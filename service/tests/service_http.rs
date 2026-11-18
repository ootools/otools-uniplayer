use axum::{
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
};
use otools_media_service::api::{AppState, router};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::Duration,
};
use tempfile::TempDir;
use tower::ServiceExt;

const ORIGIN: &str = "http://localhost:6574";
const PORT: u16 = 31001;
static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixtures {
    _dir: TempDir,
    mp4: PathBuf,
    mkv: PathBuf,
    srt: PathBuf,
}

fn ffmpeg() -> String {
    std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "/opt/homebrew/bin/ffmpeg".into())
}
fn ffprobe() -> String {
    std::env::var("FFPROBE_PATH").unwrap_or_else(|_| "/opt/homebrew/bin/ffprobe".into())
}

fn fixtures() -> &'static Fixtures {
    static FIXTURES: OnceLock<Fixtures> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let mp4 = dir.path().join("sample with spaces.mp4");
        let mkv = dir.path().join("multi-audio.mkv");
        let srt = dir.path().join("captions.srt");
        std::fs::write(&srt, "1\n00:00:01,200 --> 00:00:03,500\nHello 字幕\n\n2\n00:00:06,000 --> 00:00:08,000\nSecond cue\n").unwrap();
        let output = Command::new(ffmpeg()).args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "48", "-keyint_min", "48",
            "-sc_threshold", "0", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"])
            .arg(&mp4).output().unwrap();
        assert!(output.status.success(), "fixture synthesis failed: {}", String::from_utf8_lossy(&output.stderr));
        let output = Command::new(ffmpeg()).args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"]).arg(&mp4)
            .args(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-i"]).arg(&srt)
            .args(["-map", "0:v:0", "-map", "0:a:0", "-map", "1:a:0", "-map", "2:s:0", "-t", "12", "-c:v", "copy",
                "-c:a:0", "copy", "-c:a:1", "flac", "-c:s", "srt", "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=Original",
                "-metadata:s:a:1", "language=deu", "-metadata:s:a:1", "title=Alternate"]).arg(&mkv).output().unwrap();
        assert!(output.status.success(), "MKV fixture synthesis failed: {}", String::from_utf8_lossy(&output.stderr));
        Fixtures { _dir: dir, mp4, mkv, srt }
    })
}

fn state() -> AppState {
    AppState::new("a".repeat(64), ORIGIN.into(), ffmpeg(), ffprobe(), PORT)
}

async fn request(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", format!("127.0.0.1:{PORT}"))
        .header("origin", ORIGIN)
        .header("authorization", format!("Bearer {}", "a".repeat(64)))
        .header("content-type", "application/json")
        .body(
            body.map(|b| Body::from(b.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    (status, headers, bytes)
}

async fn control(app: &axum::Router, uri: &str, body: Value) -> Value {
    let (status, _, bytes) = request(app, "POST", uri, Some(body)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{uri}: {}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}

async fn status(app: &axum::Router) -> Value {
    let (code, _, bytes) = request(app, "GET", "/api/status", None).await;
    assert_eq!(code, StatusCode::OK);
    serde_json::from_slice(&bytes).unwrap()
}

fn segments(text: &str) -> Vec<&str> {
    text.lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

fn worker_pids() -> Vec<u32> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let pid = words.next()?.parse().ok()?;
            let parent: u32 = words.next()?.parse().ok()?;
            let exe = words.next()?;
            (parent == std::process::id() && Path::new(exe).file_name()?.to_str()? == "ffmpeg")
                .then_some(pid)
        })
        .collect()
}

async fn assert_decodable(app: &axum::Router, generation: u64, playlist: &str) {
    let (_, _, init) = request(app, "GET", &format!("/media/{generation}/init.mp4"), None).await;
    assert!(init.windows(4).any(|w| w == b"ftyp"));
    let mut bytes = init;
    let names = segments(playlist);
    assert!(
        !names.is_empty(),
        "playlist must contain real, published media"
    );
    for name in names.iter().take(2) {
        let (code, headers, segment) =
            request(app, "GET", &format!("/media/{generation}/{name}"), None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(headers["content-type"], "video/iso.segment");
        assert!(segment.windows(4).any(|w| w == b"moof"));
        bytes.extend_from_slice(&segment);
    }
    let dir = tempfile::tempdir().unwrap();
    let recovered = dir.path().join("recovered.mp4");
    std::fs::write(&recovered, bytes).unwrap();
    let output = Command::new(ffmpeg())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-xerror",
            "-protocol_whitelist",
            "file",
            "-i",
        ])
        .arg(&recovered)
        .args(["-t", "1", "-f", "null", "-"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "published media must decode: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn status_api_rejects_missing_token_and_allows_bound_origin() {
    let _lock = TEST_LOCK.lock().await;
    let app = router(state());
    let unauthorized = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/status")
                .header("host", format!("127.0.0.1:{PORT}"))
                .header("origin", ORIGIN)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let (code, headers, _) = request(&app, "GET", "/api/status", None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(headers["access-control-allow-origin"], ORIGIN);
}

#[tokio::test]
async fn open_publishes_real_copy_hls_and_keyframe_seek_expires_the_previous_generation() {
    let _lock = TEST_LOCK.lock().await;
    let app = router(state());
    let open = control(&app, "/api/open", json!({"path": fixtures().mp4})).await;
    assert_eq!(open["mode"], "copy");
    assert_eq!(open["media"]["videoCodec"], "h264");
    assert!((open["media"]["duration"].as_f64().unwrap() - 12.0).abs() < 0.15);
    assert!(
        open["media"].get("path").is_none(),
        "local paths are not part of the public media contract"
    );
    let generation = open["generation"].as_u64().unwrap();
    let playlist = open["playlist"].as_str().unwrap();
    let (code, headers, bytes) = request(&app, "GET", playlist, None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/vnd.apple.mpegurl");
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("#EXT-X-MAP:URI=\"init.mp4\""));
    assert_decodable(&app, generation, &text).await;
    assert!(status(&app).await["cacheBytes"].as_u64().unwrap() > 0);

    let seek = control(&app, "/api/seek", json!({"position": 5.3, "rate": 1.5})).await;
    assert!(seek["generation"].as_u64().unwrap() > generation);
    assert_eq!(seek["requestedStart"], 5.3);
    assert_eq!(seek["seekPrecision"], "keyframe");
    assert!(
        (seek["effectiveStart"].as_f64().unwrap() - 4.0).abs() < 0.1,
        "seek must report the actual preceding keyframe: {seek}"
    );
    assert_eq!(
        request(&app, "GET", playlist, None).await.0,
        StatusCode::GONE
    );
    assert_eq!(
        request(&app, "GET", &format!("/media/{generation}/init.mp4"), None)
            .await
            .0,
        StatusCode::GONE
    );
    let (_, _, bytes) = request(&app, "GET", seek["playlist"].as_str().unwrap(), None).await;
    assert_decodable(
        &app,
        seek["generation"].as_u64().unwrap(),
        &String::from_utf8(bytes).unwrap(),
    )
    .await;
    assert_eq!(status(&app).await["rate"], 1.5);
    assert_eq!(
        worker_pids().len(),
        1,
        "seek must replace, not overlap, the FFmpeg worker"
    );
    assert_eq!(
        request(&app, "POST", "/api/close", Some(json!({}))).await.0,
        StatusCode::OK
    );
    assert!(worker_pids().is_empty());
}

#[tokio::test]
async fn selected_incompatible_mkv_audio_is_transcoded_and_embedded_subtitles_are_real_vtt() {
    let _lock = TEST_LOCK.lock().await;
    let app = router(state());
    let open = control(
        &app,
        "/api/open",
        json!({"path": fixtures().mkv, "audioTrack": 2, "start": 5.3}),
    )
    .await;
    assert_eq!(open["mode"], "transcode");
    assert_eq!(open["seekPrecision"], "exact");
    assert_eq!(open["effectiveStart"], 5.3);
    assert_eq!(open["media"]["audioTracks"].as_array().unwrap().len(), 2);
    assert_eq!(open["media"]["audioTracks"][1]["codec"], "flac");
    let tracks = open["media"]["subtitleTracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 1);
    let track = tracks[0]["id"].as_u64().unwrap();
    let (_, _, bytes) = request(&app, "GET", open["playlist"].as_str().unwrap(), None).await;
    assert_decodable(
        &app,
        open["generation"].as_u64().unwrap(),
        &String::from_utf8(bytes).unwrap(),
    )
    .await;
    let (code, headers, bytes) =
        request(&app, "GET", &format!("/api/subtitle?track={track}"), None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(headers["content-type"], "text/vtt; charset=utf-8");
    let vtt = String::from_utf8(bytes).unwrap();
    assert!(vtt.starts_with("WEBVTT"));
    assert!(vtt.contains("Hello 字幕"));
    assert!(
        vtt.contains("00:01.2") || vtt.contains("00:00:01.2"),
        "subtitle timestamps must stay on the source timeline: {vtt}"
    );
    request(&app, "POST", "/api/close", Some(json!({}))).await;
    assert!(worker_pids().is_empty());
}

#[tokio::test]
async fn pause_stops_production_preserves_published_segments_and_close_allows_reopen() {
    let _lock = TEST_LOCK.lock().await;
    let app = router(state());
    let open = control(&app, "/api/open", json!({"path": fixtures().mp4})).await;
    let generation = open["generation"].as_u64().unwrap();
    let (_, _, before) = request(&app, "GET", open["playlist"].as_str().unwrap(), None).await;
    let before = String::from_utf8(before).unwrap();
    let first = segments(&before)[0].to_owned();
    let (code, _, _) = request(&app, "POST", "/api/pause", Some(json!({"position": 1.25}))).await;
    assert_eq!(code, StatusCode::OK);
    assert!(
        worker_pids().is_empty(),
        "pause must reap the worker before ACK"
    );
    let paused = status(&app).await;
    assert_eq!(paused["paused"], true);
    assert_eq!(paused["position"], 1.25);
    assert_eq!(paused["needReload"], true);
    let bytes = paused["cacheBytes"].as_u64().unwrap();
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(status(&app).await["cacheBytes"], bytes);
    assert_eq!(
        request(&app, "GET", &format!("/media/{generation}/{first}"), None)
            .await
            .0,
        StatusCode::OK
    );
    assert!(bytes < 256 * 1024 * 1024);
    request(&app, "POST", "/api/close", Some(json!({}))).await;
    assert_eq!(status(&app).await["cacheBytes"], 0);
    assert_eq!(
        request(&app, "GET", &format!("/media/{generation}/{first}"), None)
            .await
            .0,
        StatusCode::GONE
    );
    let reopened = control(
        &app,
        "/api/open",
        json!({"path": fixtures().mp4, "start": 2.5}),
    )
    .await;
    assert!(reopened["generation"].as_u64().unwrap() > generation);
    request(&app, "POST", "/api/close", Some(json!({}))).await;
    assert!(worker_pids().is_empty());
}

#[tokio::test]
async fn external_subtitles_and_all_media_paths_share_auth_and_published_filename_restrictions() {
    let _lock = TEST_LOCK.lock().await;
    let app = router(state());
    let open = control(&app, "/api/open", json!({"path": fixtures().mp4})).await;
    let generation = open["generation"].as_u64().unwrap();
    let external = control(&app, "/api/subtitle", json!({"path": fixtures().srt})).await;
    let url = external["subtitleURL"].as_str().unwrap();
    assert!(!url.contains("captions.srt"));
    let (code, _, bytes) = request(&app, "GET", url, None).await;
    assert_eq!(code, StatusCode::OK);
    assert!(
        String::from_utf8(bytes)
            .unwrap()
            .contains("00:00:01.200 --> 00:00:03.500")
    );
    for uri in [
        format!("/media/{generation}/segment999999.m4s"),
        format!("/media/{generation}/segment000000.m4s.tmp"),
        format!("/media/{generation}/%2e%2e%2fsecret"),
        format!("/media/{generation}/token.json"),
    ] {
        assert_eq!(
            request(&app, "GET", &uri, None).await.0,
            StatusCode::NOT_FOUND
        );
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(url)
                .header("host", format!("127.0.0.1:{PORT}"))
                .header("origin", ORIGIN)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    request(&app, "POST", "/api/close", Some(json!({}))).await;
}

#[tokio::test]
async fn consumer_gc_reclaims_only_old_segments_and_keeps_hls_sequence_monotonic() {
    let _lock = TEST_LOCK.lock().await;
    let app = router(state());
    let open = control(
        &app,
        "/api/open",
        json!({"path": fixtures().mp4, "rate": 2.5}),
    )
    .await;
    let generation = open["generation"].as_u64().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        if status(&app).await["pipelineState"] == "ended" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "finite source must complete"
        );
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    let before = status(&app).await["cacheBytes"].as_u64().unwrap();
    control(
        &app,
        "/api/progress",
        json!({"position": 10.5, "paused": false, "rate": 2.5}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    let (code, _, bytes) = request(&app, "GET", open["playlist"].as_str().unwrap(), None).await;
    assert_eq!(code, StatusCode::OK);
    let text = String::from_utf8(bytes).unwrap();
    assert_eq!(
        segments(&text)[0],
        "segment000002.m4s",
        "GC must retain the six-second rewind margin"
    );
    assert!(
        text.contains("#EXT-X-MEDIA-SEQUENCE:2\n"),
        "a refreshed HLS playlist must not renumber retained fragments: {text}"
    );
    assert!(status(&app).await["cacheBytes"].as_u64().unwrap() < before);
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/media/{generation}/segment000000.m4s"),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/media/{generation}/segment000005.m4s"),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let rewind = control(
        &app,
        "/api/progress",
        json!({"position": 0.0, "paused": true, "rate": 2.5}),
    )
    .await;
    assert_eq!(rewind["needReload"], true);
    request(&app, "POST", "/api/close", Some(json!({}))).await;
}

#[tokio::test]
async fn finite_window_and_readrate_bound_slow_consumption_without_deleting_unread_segments() {
    let _lock = TEST_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("long-window.mp4");
    let output = Command::new(ffmpeg())
        .args([
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "90",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "48",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
        ])
        .arg(&file)
        .output()
        .unwrap();
    assert!(output.status.success(), "long source synthesis failed");
    let app = router(state());
    let open = control(&app, "/api/open", json!({"path": file, "rate": 2.5})).await;
    assert!((open["media"]["duration"].as_f64().unwrap() - 90.0).abs() < 0.15);
    tokio::time::sleep(Duration::from_millis(450)).await;
    let (_, _, bytes) = request(&app, "GET", open["playlist"].as_str().unwrap(), None).await;
    let text = String::from_utf8(bytes).unwrap();
    assert!(
        segments(&text).len() <= 4,
        "readrate with a four-second initial burst must not produce the whole window immediately"
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(35);
    let stopped = loop {
        let snapshot = status(&app).await;
        if snapshot["pipelineState"] != "running" {
            break snapshot;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "64-second producer window must terminate"
        );
        assert!(snapshot["cacheBytes"].as_u64().unwrap() < 256 * 1024 * 1024);
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(stopped["needReload"], true);
    assert!(worker_pids().is_empty());
    let (_, _, bytes) = request(&app, "GET", open["playlist"].as_str().unwrap(), None).await;
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("#EXT-X-ENDLIST"));
    let total: f64 = text
        .lines()
        .filter_map(|line| line.strip_prefix("#EXTINF:"))
        .map(|line| line.split(',').next().unwrap().parse::<f64>().unwrap())
        .sum();
    assert!(
        (63.5..=66.0).contains(&total),
        "90-second source must publish a complete 64-second window; actual={total}, status={stopped}"
    );
    assert_eq!(segments(&text)[0], "segment000000.m4s");
    assert!(segments(&text).len() <= 34);
    let generation = open["generation"].as_u64().unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/media/{generation}/segment000000.m4s"),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let cache = stopped["cacheBytes"].as_u64().unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(status(&app).await["cacheBytes"], cache);
    request(&app, "POST", "/api/close", Some(json!({}))).await;
}

#[tokio::test]
async fn concurrent_replacements_serialize_and_never_publish_an_older_generation_again() {
    let _lock = TEST_LOCK.lock().await;
    let app = router(state());
    let (first, second) = tokio::join!(
        request(
            &app,
            "POST",
            "/api/open",
            Some(json!({"path": fixtures().mp4}))
        ),
        request(
            &app,
            "POST",
            "/api/open",
            Some(json!({"path": fixtures().mp4, "start": 5.3}))
        )
    );
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(second.0, StatusCode::OK);
    let first: Value = serde_json::from_slice(&first.2).unwrap();
    let second: Value = serde_json::from_slice(&second.2).unwrap();
    let latest = status(&app).await["generation"].as_u64().unwrap();
    assert_eq!(
        latest,
        first["generation"]
            .as_u64()
            .unwrap()
            .max(second["generation"].as_u64().unwrap())
    );
    for result in [first, second] {
        let expected = if result["generation"] == latest {
            StatusCode::OK
        } else {
            StatusCode::GONE
        };
        assert_eq!(
            request(&app, "GET", result["playlist"].as_str().unwrap(), None)
                .await
                .0,
            expected
        );
    }
    assert_eq!(worker_pids().len(), 1);
    request(&app, "POST", "/api/close", Some(json!({}))).await;
    assert!(worker_pids().is_empty());
}

#[tokio::test]
async fn ten_bit_hdr_source_transcodes_to_decodable_eight_bit_sdr_in_the_local_runtime() {
    let _lock = TEST_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("hdr-10bit.mp4");
    let output = Command::new(ffmpeg())
        .args([
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-t",
            "6",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p10le",
            "-profile:v",
            "high10",
            "-color_primaries",
            "bt2020",
            "-color_trc",
            "smpte2084",
            "-colorspace",
            "bt2020nc",
            "-g",
            "48",
            "-sc_threshold",
            "0",
            "-x264-params",
            "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
            "-c:a",
            "aac",
        ])
        .arg(&file)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "HDR source synthesis failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let app = router(state());
    let open = control(&app, "/api/open", json!({"path": file})).await;
    assert_eq!(open["media"]["hdr"], true);
    assert_eq!(open["mode"], "transcode");
    assert_eq!(open["seekPrecision"], "exact");
    let (_, _, bytes) = request(&app, "GET", open["playlist"].as_str().unwrap(), None).await;
    assert_decodable(
        &app,
        open["generation"].as_u64().unwrap(),
        &String::from_utf8(bytes).unwrap(),
    )
    .await;
    request(&app, "POST", "/api/close", Some(json!({}))).await;
    assert!(worker_pids().is_empty());
}

#[tokio::test]
async fn cancelled_open_cannot_orphan_a_worker_or_overlap_the_next_generation() {
    let _lock = TEST_LOCK.lock().await;
    let app = router(state());
    let pending_app = app.clone();
    let pending = tokio::spawn(async move {
        request(
            &pending_app,
            "POST",
            "/api/open",
            Some(json!({"path": fixtures().mp4, "rate": 0.25})),
        )
        .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if worker_pids().len() == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker must start before cancellation"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    pending.abort();
    let _ = pending.await;
    let result = control(&app, "/api/open", json!({"path": fixtures().mp4})).await;
    assert_eq!(
        worker_pids().len(),
        1,
        "a disconnected HTTP caller must not strand the old supervisor"
    );
    assert_eq!(
        request(&app, "GET", result["playlist"].as_str().unwrap(), None)
            .await
            .0,
        StatusCode::OK
    );
    request(&app, "POST", "/api/close", Some(json!({}))).await;
    assert!(worker_pids().is_empty());
}

#[tokio::test]
async fn invalid_media_parameters_and_network_playlists_fail_without_leaking_paths_or_credentials()
{
    let _lock = TEST_LOCK.lock().await;
    let app = router(state());
    let dir = tempfile::tempdir().unwrap();
    let disguised = dir.path().join("remote.mp4");
    std::fs::write(&disguised, "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:9/secret-token.ts\n#EXT-X-ENDLIST\n").unwrap();
    for body in [
        json!({"path": "https://example.com/movie.mp4"}),
        json!({"path": disguised}),
        json!({"path": dir.path()}),
        json!({"path": fixtures().mp4, "start": -1}),
        json!({"path": fixtures().mp4, "rate": 0}),
        json!({"path": fixtures().mp4, "audioTrack": 999}),
    ] {
        let (code, _, bytes) = request(&app, "POST", "/api/open", Some(body)).await;
        assert!(code.is_client_error(), "bad input must be rejected: {code}");
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("secret-token"));
        assert!(!text.contains(&"a".repeat(64)));
        assert!(!text.contains(dir.path().to_str().unwrap()));
        assert!(worker_pids().is_empty());
    }
}
