use crate::{
    cache::{CachePolicy, Segment},
    media::safe_media_name,
    probe::MediaInfo,
    process::{FORMAT_WHITELIST, local_command, terminate},
};
use bytes::Bytes;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    process::Child,
    sync::{Mutex, Notify, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

pub const HARD_CACHE_BYTES: u64 = 256 * 1024 * 1024;
pub const WINDOW_SECONDS: f64 = 64.0;
// A 64s / 2s HLS window has at most 34 media fragments (including an
// incomplete tail). Per-file limits also bound writes between watcher ticks.
// 36 * 6MiB + 16MiB subtitles + playlist overhead remains below 256MiB.
pub const MAX_OUTPUT_FILE_BYTES: u64 = 6 * 1024 * 1024;
pub const MAX_SUBTITLE_BYTES: u64 = 16 * 1024 * 1024;
const PLAYLIST_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub struct Pipeline {
    shared: Arc<Shared>,
}

struct Shared {
    directory: TempDir,
    state: Mutex<PipelineState>,
    refresh_guard: Mutex<()>,
    changed: Notify,
    stop: CancellationToken,
    done: Mutex<Option<JoinHandle<()>>>,
    effective_start: f64,
    duration: f64,
}

struct PipelineState {
    playlist: Option<Bytes>,
    published: HashSet<String>,
    segments: Vec<Segment>,
    subtitle_bytes: u64,
    cache_bytes: u64,
    consumer: f64,
    state: &'static str,
    need_reload: bool,
    finished: bool,
}

pub struct PipelineConfig {
    pub path: PathBuf,
    pub media: MediaInfo,
    pub effective_start: f64,
    pub rate: f64,
    pub audio_track: Option<u32>,
    pub copy: bool,
    pub subtitles: Vec<(u32, Vec<u8>)>,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub pipeline_state: String,
    pub need_reload: bool,
    pub cache_bytes: u64,
}

impl Pipeline {
    pub async fn start(
        ffmpeg: &str,
        config: PipelineConfig,
        shutdown: CancellationToken,
    ) -> Result<Self, String> {
        if shutdown.is_cancelled() {
            return Err("service is shutting down".into());
        }
        let directory = tempfile::Builder::new()
            .prefix("otools-media-")
            .tempdir()
            .map_err(|_| "media cache cannot be created".to_owned())?;
        let mut published = HashSet::new();
        let mut subtitle_bytes = 0u64;
        for (track, bytes) in &config.subtitles {
            subtitle_bytes = subtitle_bytes.saturating_add(bytes.len() as u64);
            if subtitle_bytes > MAX_SUBTITLE_BYTES {
                return Err("subtitle cache exceeds limit".into());
            }
            let name = format!("subtitle-track-{track}.vtt");
            tokio::fs::write(directory.path().join(&name), bytes)
                .await
                .map_err(|_| "subtitle cache cannot be written".to_owned())?;
            published.insert(name);
        }
        let shared = Arc::new(Shared {
            directory,
            state: Mutex::new(PipelineState {
                playlist: None,
                published,
                segments: Vec::new(),
                subtitle_bytes,
                cache_bytes: subtitle_bytes,
                consumer: config.effective_start,
                state: "starting",
                need_reload: false,
                finished: false,
            }),
            refresh_guard: Mutex::new(()),
            changed: Notify::new(),
            stop: CancellationToken::new(),
            done: Mutex::new(None),
            effective_start: config.effective_start,
            duration: config.media.duration,
        });
        let mut command = local_command(ffmpeg);
        command.stdout(Stdio::null());
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                FORMAT_WHITELIST,
                "-readrate",
                &format!("{:.6}", config.rate),
                "-readrate_initial_burst",
                "4",
                "-ss",
                &format!("{:.6}", config.effective_start),
                "-i",
            ])
            .arg(&config.path)
            .args([
                "-t",
                &format!(
                    "{:.6}",
                    WINDOW_SECONDS.min((config.media.duration - config.effective_start).max(0.001))
                ),
            ]);
        if let Some(video) = config.media.video_index {
            command.args(["-map", &format!("0:{video}")]);
        }
        if let Some(audio) = config.audio_track {
            command.args(["-map", &format!("0:{audio}")]);
        }
        command.args(["-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"]);
        if config.copy {
            command.args(["-c:v", "copy", "-c:a", "copy"]);
        } else {
            if config.media.video_index.is_some() {
                command.args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "22",
                    "-pix_fmt",
                    "yuv420p",
                    "-threads",
                    "2",
                    "-maxrate",
                    "8M",
                    "-bufsize",
                    "12M",
                    "-force_key_frames",
                    "expr:gte(t,n_forced*2)",
                    "-sc_threshold",
                    "0",
                ]);
                if config.media.hdr {
                    // FFmpeg 9's built-in scale performs transfer/primary
                    // conversion; unlike zscale it is present in the local
                    // Homebrew runtime. Tone mapping is SDR, not HDR fidelity.
                    command.args(["-vf", "scale=out_transfer=linear:out_primaries=bt709:flags=full_chroma_int,format=gbrpf32le,tonemap=tonemap=hable:desat=0,scale=out_transfer=bt709:out_color_matrix=bt709:out_range=tv,format=yuv420p"]);
                }
                command.args([
                    "-color_primaries",
                    "bt709",
                    "-color_trc",
                    "bt709",
                    "-colorspace",
                    "bt709",
                ]);
            }
            command.args(["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"]);
        }
        command
            .args([
                "-avoid_negative_ts",
                "make_zero",
                "-max_muxing_queue_size",
                "1024",
                "-f",
                "hls",
                "-hls_time",
                "2",
                "-hls_segment_type",
                "fmp4",
                "-hls_list_size",
                "0",
                "-hls_playlist_type",
                "event",
                "-hls_flags",
                "temp_file+independent_segments",
                "-hls_fmp4_init_filename",
                "init.mp4",
                "-hls_segment_filename",
            ])
            .arg(shared.directory.path().join("segment%06d.m4s"))
            .arg(shared.directory.path().join("index.m3u8"));
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                let limit = libc::rlimit {
                    rlim_cur: MAX_OUTPUT_FILE_BYTES as libc::rlim_t,
                    rlim_max: MAX_OUTPUT_FILE_BYTES as libc::rlim_t,
                };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command
            .spawn()
            .map_err(|_| "media worker cannot be started".to_owned())?;
        let worker_shared = shared.clone();
        let (ready_tx, ready_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            supervise(child, worker_shared, shutdown, ready_tx).await;
        });
        *shared.done.lock().await = Some(task);
        let pipeline = Self { shared };
        match tokio::time::timeout(Duration::from_secs(30), ready_rx).await {
            Ok(Ok(Ok(()))) => Ok(pipeline),
            Ok(Ok(Err(error))) => {
                pipeline.stop().await;
                Err(error)
            }
            _ => {
                pipeline.stop().await;
                Err("media worker did not publish a playable segment".into())
            }
        }
    }

    pub async fn stop(&self) {
        self.shared.stop.cancel();
        if let Some(task) = self.shared.done.lock().await.take() {
            let _ = task.await;
        }
    }

    pub async fn snapshot(&self) -> Snapshot {
        let state = self.shared.state.lock().await;
        Snapshot {
            pipeline_state: state.state.into(),
            need_reload: state.need_reload,
            cache_bytes: state.cache_bytes,
        }
    }

    pub async fn progress(&self, position: f64) {
        let mut state = self.shared.state.lock().await;
        state.consumer = position;
        if let Some(first) = state.segments.first()
            && position + 0.25 < first.start
        {
            state.need_reload = true;
        }
        drop(state);
        // Consumer GC remains available after pause/window completion, when
        // there is no worker watcher left to process a notification.
        let _ = refresh(&self.shared).await;
        self.shared.changed.notify_one();
    }

    pub async fn media(&self, name: &str) -> Result<Bytes, ()> {
        if !safe_media_name(name) {
            return Err(());
        }
        let state = self.shared.state.lock().await;
        if name == "index.m3u8" {
            return state.playlist.clone().ok_or(());
        }
        if !state.published.contains(name) {
            return Err(());
        }
        // Holding the cache lock keeps consumer GC from unlinking a file between
        // the published check and the read. No caller-supplied filesystem path.
        let bytes = tokio::fs::read(self.shared.directory.path().join(name))
            .await
            .map_err(|_| ())?;
        Ok(Bytes::from(bytes))
    }

    pub async fn external_subtitle(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("subtitle exceeds limit".into());
        }
        let mut state = self.shared.state.lock().await;
        let path = self.shared.directory.path().join("subtitle-external.vtt");
        let old = tokio::fs::metadata(&path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let next = state
            .subtitle_bytes
            .saturating_sub(old)
            .saturating_add(bytes.len() as u64);
        if next > MAX_SUBTITLE_BYTES {
            return Err("subtitle cache exceeds limit".into());
        }
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|_| "subtitle cache cannot be written".to_owned())?;
        state.published.insert("subtitle-external.vtt".into());
        state.subtitle_bytes = next;
        state.cache_bytes = state
            .cache_bytes
            .saturating_sub(old)
            .saturating_add(bytes.len() as u64);
        Ok(())
    }
}

async fn supervise(
    mut child: Child,
    shared: Arc<Shared>,
    shutdown: CancellationToken,
    ready: oneshot::Sender<Result<(), String>>,
) {
    let mut ready = Some(ready);
    let mut ticker = tokio::time::interval(Duration::from_millis(30));
    let reason = loop {
        tokio::select! {
            _ = shared.stop.cancelled() => { break "stopped"; }
            _ = shutdown.cancelled() => { break "stopped"; }
            _ = shared.changed.notified() => {}
            _ = ticker.tick() => {}
        }
        match refresh(&shared).await {
            Ok(stop) => {
                let playable = shared.state.lock().await.playlist.is_some();
                if playable && let Some(ready) = ready.take() {
                    let _ = ready.send(Ok(()));
                }
                if stop {
                    break "cache-limit";
                }
            }
            Err(_) => break "error",
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    "finished"
                } else {
                    "error"
                };
            }
            Ok(None) => {}
            Err(_) => break "error",
        }
    };
    terminate(&mut child).await;
    let _ = refresh(&shared).await;
    let mut state = shared.state.lock().await;
    let reached_end = state
        .segments
        .last()
        .is_some_and(|segment| segment.end >= shared.duration - 0.15);
    state.finished = true;
    state.state = match reason {
        "finished" if reached_end => "ended",
        "finished" => "window-ended",
        other => other,
    };
    state.need_reload |= !reached_end || reason == "error" || reason == "cache-limit";
    let playable = state.playlist.is_some();
    if let Some(bytes) = &state.playlist {
        let mut text = String::from_utf8_lossy(bytes).into_owned();
        if !text.contains("#EXT-X-ENDLIST") {
            text.push_str("#EXT-X-ENDLIST\n");
        }
        state.playlist = Some(Bytes::from(text));
    }
    drop(state);
    if let Some(ready) = ready {
        let _ = ready.send(if playable {
            Ok(())
        } else {
            Err("media worker failed before publishing a segment".into())
        });
    }
}

async fn refresh(shared: &Shared) -> Result<bool, ()> {
    let _refresh = shared.refresh_guard.lock().await;
    let mut sizes = HashMap::new();
    let mut directory = tokio::fs::read_dir(shared.directory.path())
        .await
        .map_err(|_| ())?;
    let mut total = 0u64;
    while let Some(entry) = directory.next_entry().await.map_err(|_| ())? {
        let metadata = match entry.metadata().await {
            Ok(metadata) => metadata,
            // Official temp_file HLS renames fragments and the playlist while
            // this asynchronous scan is in flight. A vanished directory entry
            // is a publication race, not a failed worker/cache.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(()),
        };
        if metadata.is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            total = total.saturating_add(metadata.len());
            sizes.insert(name, metadata.len());
        }
    }
    let raw = match tokio::fs::read(shared.directory.path().join("index.m3u8")).await {
        Ok(bytes) if bytes.len() <= PLAYLIST_LIMIT => String::from_utf8(bytes).map_err(|_| ())?,
        Ok(_) => return Err(()),
        Err(_) => {
            shared.state.lock().await.cache_bytes = total;
            return Ok(total >= HARD_CACHE_BYTES - MAX_OUTPUT_FILE_BYTES * 2);
        }
    };
    let mut state = shared.state.lock().await;
    let mut time = shared.effective_start;
    let mut duration = None;
    let mut parsed = Vec::new();
    let mut raw_blocks = Vec::new();
    let mut target = 2u32;
    let mut pending = Vec::new();
    let mut sequence = 0u64;
    let mut missing_prefix = 0u64;
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            target = value.parse().unwrap_or(2);
        }
        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            sequence = value.parse().unwrap_or(0);
        }
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            duration = value
                .split(',')
                .next()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value > 0.0);
            pending.push(line.to_owned());
        } else if line.starts_with("#EXT-X-BYTERANGE:") || line.starts_with("#EXT-X-DISCONTINUITY")
        {
            pending.push(line.to_owned());
        } else if !line.is_empty() && !line.starts_with('#') {
            let elapsed = duration.take().ok_or(())?;
            if !safe_media_name(line) || !line.starts_with("segment") {
                return Err(());
            }
            let end = time + elapsed;
            if !sizes.contains_key(line) {
                // The playlist is read after enumeration. A completed segment
                // may have been renamed into place between those snapshots.
                match tokio::fs::metadata(shared.directory.path().join(line)).await {
                    Ok(metadata) if metadata.is_file() => {
                        total = total.saturating_add(metadata.len());
                        sizes.insert(line.to_owned(), metadata.len());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    _ => return Err(()),
                }
            }
            if let Some(bytes) = sizes.get(line) {
                parsed.push(Segment {
                    name: line.to_owned(),
                    start: time,
                    end,
                    bytes: *bytes,
                });
                let mut block = std::mem::take(&mut pending);
                block.push(line.to_owned());
                raw_blocks.push((line.to_owned(), block.join("\n")));
            } else {
                // Only consumer GC can legitimately make a published prefix
                // disappear. A missing unconsumed/new tail is a transient
                // snapshot: retain the previous playlist and reload flag.
                if end > state.consumer - 6.0 {
                    state.cache_bytes = total;
                    return Ok(total >= HARD_CACHE_BYTES - MAX_OUTPUT_FILE_BYTES * 2);
                }
                if parsed.is_empty() {
                    missing_prefix += 1;
                }
                pending.clear();
            }
            time = end;
        }
    }
    // FFmpeg never receives delete_segments. Only the consumer position permits
    // deleting completed fragments; incomplete and unread files are retained.
    let policy = CachePolicy {
        byte_limit: HARD_CACHE_BYTES - MAX_OUTPUT_FILE_BYTES * 2,
        ahead_seconds: WINDOW_SECONDS,
        behind_seconds: 6.0,
        low_water_seconds: 4.0,
    };
    let decision = policy.decide(
        &parsed,
        state.consumer,
        total.saturating_sub(parsed.iter().map(|segment| segment.bytes).sum::<u64>()),
    );
    let mut skipped = 0u64;
    for segment in &parsed {
        if decision.evict.contains(&segment.name) {
            if tokio::fs::remove_file(shared.directory.path().join(&segment.name))
                .await
                .is_ok()
            {
                total = total.saturating_sub(segment.bytes);
                state.published.remove(&segment.name);
            }
            skipped += 1;
        } else {
            break;
        }
    }
    parsed.retain(|segment| !decision.evict.contains(&segment.name));
    state.cache_bytes = total;
    state.need_reload |= decision.need_reload;
    if sizes.get("init.mp4").copied().unwrap_or(0) > 0 && !parsed.is_empty() {
        state.published.insert("init.mp4".into());
        for segment in &parsed {
            state.published.insert(segment.name.clone());
        }
        let retained: HashSet<_> = parsed.iter().map(|segment| segment.name.as_str()).collect();
        let mut text = format!(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:{}\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"init.mp4\"\n",
            sequence + missing_prefix + skipped
        );
        for (name, block) in raw_blocks {
            if retained.contains(name.as_str()) {
                text.push_str(&block);
                text.push('\n');
            }
        }
        if raw.contains("#EXT-X-ENDLIST") || state.finished {
            text.push_str("#EXT-X-ENDLIST\n");
        }
        state.playlist = Some(Bytes::from(text));
        if !state.finished {
            state.state = "running";
        }
    }
    state.segments = parsed;
    Ok(decision.stop || total >= HARD_CACHE_BYTES - MAX_OUTPUT_FILE_BYTES * 2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn atomic_temp_file_rename_during_cache_scan_must_not_stop_the_pipeline() {
        let directory = tempfile::tempdir().unwrap();
        let shared = Shared {
            directory,
            state: Mutex::new(PipelineState {
                playlist: None,
                published: HashSet::new(),
                segments: Vec::new(),
                subtitle_bytes: 0,
                cache_bytes: 0,
                consumer: 0.0,
                state: "running",
                need_reload: false,
                finished: false,
            }),
            refresh_guard: Mutex::new(()),
            changed: Notify::new(),
            stop: CancellationToken::new(),
            done: Mutex::new(None),
            effective_start: 0.0,
            duration: 90.0,
        };
        tokio::fs::write(shared.directory.path().join("init.mp4"), b"init")
            .await
            .unwrap();
        tokio::fs::write(
            shared.directory.path().join("segment000000.m4s"),
            b"published",
        )
        .await
        .unwrap();
        tokio::fs::write(shared.directory.path().join("index.m3u8"), b"#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.0,\nsegment000000.m4s\n").await.unwrap();
        let files: Vec<_> = (0..64)
            .map(|index| {
                (
                    shared
                        .directory
                        .path()
                        .join(format!("volatile{index}.m4s.tmp")),
                    shared.directory.path().join(format!("volatile{index}.m4s")),
                )
            })
            .collect();
        for (temporary, _) in &files {
            std::fs::write(temporary, b"pending").unwrap();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let renamer = std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                for (temporary, published) in &files {
                    std::fs::rename(temporary, published).unwrap();
                    std::fs::rename(published, temporary).unwrap();
                }
            }
        });
        let mut lost_entry_was_fatal = false;
        for _ in 0..128 {
            if refresh(&shared).await.is_err() {
                lost_entry_was_fatal = true;
                break;
            }
        }
        stop.store(true, Ordering::Relaxed);
        renamer.join().unwrap();
        assert!(
            !lost_entry_was_fatal,
            "a muxer's atomic temp-file rename is not a cache failure or a reason to stop producing"
        );
        assert!(
            shared.state.lock().await.playlist.is_some(),
            "stable published media remains playable throughout scanning"
        );
    }

    #[tokio::test]
    async fn missing_unconsumed_tail_keeps_previous_playlist_until_publication_completes() {
        let directory = tempfile::tempdir().unwrap();
        let shared = Shared {
            directory,
            state: Mutex::new(PipelineState {
                playlist: None,
                published: HashSet::new(),
                segments: Vec::new(),
                subtitle_bytes: 0,
                cache_bytes: 0,
                consumer: 0.0,
                state: "running",
                need_reload: false,
                finished: false,
            }),
            refresh_guard: Mutex::new(()),
            changed: Notify::new(),
            stop: CancellationToken::new(),
            done: Mutex::new(None),
            effective_start: 0.0,
            duration: 90.0,
        };
        tokio::fs::write(shared.directory.path().join("init.mp4"), b"init")
            .await
            .unwrap();
        for name in ["segment000000.m4s", "segment000001.m4s"] {
            tokio::fs::write(shared.directory.path().join(name), b"published")
                .await
                .unwrap();
        }
        let raw = b"#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2.0,\nsegment000000.m4s\n#EXTINF:2.0,\nsegment000001.m4s\n";
        tokio::fs::write(shared.directory.path().join("index.m3u8"), raw)
            .await
            .unwrap();
        assert_eq!(refresh(&shared).await, Ok(false));
        let previous = shared.state.lock().await.playlist.clone().unwrap();
        // The watcher may hold a directory snapshot from before a muxer rename.
        // Simulate an unconsumed listed tail not yet visible to the current scan.
        tokio::fs::rename(
            shared.directory.path().join("segment000001.m4s"),
            shared.directory.path().join("segment000001.m4s.tmp"),
        )
        .await
        .unwrap();
        assert_eq!(refresh(&shared).await, Ok(false));
        {
            let state = shared.state.lock().await;
            assert_eq!(
                state.playlist.as_ref(),
                Some(&previous),
                "transient tail visibility must not shrink an already-published playlist"
            );
            assert!(
                !state.need_reload,
                "an incomplete cache snapshot is not a consumer rewind"
            );
        }
        tokio::fs::rename(
            shared.directory.path().join("segment000001.m4s.tmp"),
            shared.directory.path().join("segment000001.m4s"),
        )
        .await
        .unwrap();
        assert_eq!(refresh(&shared).await, Ok(false));
        assert_eq!(shared.state.lock().await.playlist.as_ref(), Some(&previous));
    }
}
