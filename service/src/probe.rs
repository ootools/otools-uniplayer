use crate::process::{FORMAT_WHITELIST, capture, local_command};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub id: u32,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub codec: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    #[serde(skip)]
    pub path: Option<String>,
    pub name: String,
    pub duration: f64,
    pub video_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub hdr: bool,
    pub audio_tracks: Vec<AudioTrack>,
    pub subtitle_tracks: Vec<Value>,
    #[serde(skip)]
    pub pixel_format: Option<String>,
    #[serde(skip)]
    pub video_index: Option<u32>,
    #[serde(skip)]
    pub source_start: f64,
}

pub async fn probe(ffprobe: &str, input: &str) -> Result<(PathBuf, MediaInfo), String> {
    probe_with_cancel(ffprobe, input, &CancellationToken::new()).await
}

pub async fn probe_with_cancel(
    ffprobe: &str,
    input: &str,
    shutdown: &CancellationToken,
) -> Result<(PathBuf, MediaInfo), String> {
    let canonical = local_file(input).await?;
    if !allowed_extension(&canonical) {
        return Err("unsupported local media file".into());
    }
    let mut command = local_command(ffprobe);
    command.args(["-v", "error", "-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST,
        "-probesize", "8388608", "-analyzeduration", "10000000", "-max_alloc", "67108864", "-show_format", "-show_streams",
        "-show_entries", "format=format_name,duration,start_time:stream=index,codec_type,codec_name,width,height,pix_fmt,duration,start_time,color_transfer:stream_tags=language,title:stream_disposition=attached_pic:stream_side_data=side_data_type", "-of", "json"])
        .arg(&canonical);
    let output = capture(command, 1024 * 1024, Duration::from_secs(15), shutdown).await?;
    let json: Value =
        serde_json::from_slice(&output).map_err(|_| "media probe failed".to_owned())?;
    let format = json
        .pointer("/format/format_name")
        .and_then(Value::as_str)
        .ok_or("unsupported media container")?;
    if !format
        .split(',')
        .any(|name| FORMAT_WHITELIST.split(',').any(|allowed| allowed == name))
    {
        return Err("unsupported media container".into());
    }
    let streams = json
        .get("streams")
        .and_then(Value::as_array)
        .ok_or("media has no streams")?;
    if streams.len() > 128 {
        return Err("media has too many streams".into());
    }
    let video = streams.iter().find(|stream| {
        stream.get("codec_type").and_then(Value::as_str) == Some("video")
            && stream
                .pointer("/disposition/attached_pic")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                == 0
    });
    if video.is_none()
        && !streams
            .iter()
            .any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
    {
        return Err("media has no playable streams".into());
    }
    let duration = json
        .pointer("/format/duration")
        .and_then(number_string)
        .or_else(|| {
            streams
                .iter()
                .filter_map(|stream| stream.get("duration").and_then(number_string))
                .reduce(f64::max)
        })
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or("media duration is unavailable")?;
    let source_start = json
        .pointer("/format/start_time")
        .and_then(number_string)
        .filter(|start| start.is_finite())
        .unwrap_or(0.0);
    let audio_tracks = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .map(|stream| {
            let id = stream.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
            let codec = stream
                .get("codec_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            let language = stream
                .pointer("/tags/language")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let label = stream
                .pointer("/tags/title")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| language.clone())
                .unwrap_or_else(|| format!("Audio {}", id + 1));
            AudioTrack {
                id,
                label,
                language,
                codec,
            }
        })
        .collect();
    let subtitle_tracks = streams.iter().filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("subtitle"))
        .map(|stream| {
            let id = stream.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
            let codec = stream.get("codec_name").and_then(Value::as_str).unwrap_or("unknown");
            let label = stream.pointer("/tags/title").and_then(Value::as_str)
                .or_else(|| stream.pointer("/tags/language").and_then(Value::as_str)).map(str::to_owned)
                .unwrap_or_else(|| format!("Subtitle {}", id + 1));
            let mut track = json!({"id": id, "label": label, "codec": codec, "styleLoss": matches!(codec, "ass" | "ssa")});
            if let Some(language) = stream.pointer("/tags/language").and_then(Value::as_str) { track["language"] = json!(language); }
            track
        }).collect();
    let video_codec = video
        .and_then(|stream| stream.get("codec_name"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let pixel_format = video
        .and_then(|stream| stream.get("pix_fmt"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let hdr = video.is_some_and(|stream| {
        matches!(
            stream.get("color_transfer").and_then(Value::as_str),
            Some("smpte2084" | "arib-std-b67")
        ) || stream
            .get("side_data_list")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    matches!(
                        item.get("side_data_type").and_then(Value::as_str),
                        Some(
                            "Mastering display metadata"
                                | "Content light level metadata"
                                | "DOVI configuration record"
                        )
                    )
                })
            })
    });
    let info = MediaInfo {
        path: Some(canonical.to_string_lossy().into_owned()),
        name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("media")
            .to_owned(),
        duration,
        video_codec,
        width: video
            .and_then(|stream| stream.get("width"))
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        height: video
            .and_then(|stream| stream.get("height"))
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        hdr,
        audio_tracks,
        subtitle_tracks,
        pixel_format,
        video_index: video
            .and_then(|stream| stream.get("index"))
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        source_start,
    };
    Ok((canonical, info))
}

pub async fn local_file(input: &str) -> Result<PathBuf, String> {
    if input.is_empty()
        || input.len() > 32768
        || input.contains('\0')
        || !Path::new(input).is_absolute()
    {
        return Err("only absolute local files are supported".into());
    }
    let canonical = tokio::fs::canonicalize(input)
        .await
        .map_err(|_| "media file cannot be opened".to_owned())?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|_| "media file cannot be opened".to_owned())?;
    if !metadata.is_file() {
        return Err("only regular local files are supported".into());
    }
    Ok(canonical)
}

fn number_string(value: &Value) -> Option<f64> {
    value
        .as_str()
        .and_then(|text| text.parse::<f64>().ok())
        .or_else(|| value.as_f64())
}

fn allowed_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mp4"
            | "m4v"
            | "mov"
            | "mkv"
            | "webm"
            | "avi"
            | "mpg"
            | "mpeg"
            | "ts"
            | "m2ts"
            | "mts"
            | "mp3"
            | "m4a"
            | "aac"
            | "flac"
            | "wav"
            | "ogg"
            | "opus"
            | "3gp"
            | "ogv"
    )
}

pub fn can_copy_h264_aac(info: &MediaInfo) -> bool {
    info.audio_tracks.iter().all(|track| track.codec == "aac") && compatible_video(info)
}

pub fn compatible_video(info: &MediaInfo) -> bool {
    info.video_codec.is_none()
        || (info.video_codec.as_deref() == Some("h264")
            && matches!(info.pixel_format.as_deref(), Some("yuv420p" | "yuvj420p"))
            && !info.hdr)
}

pub async fn preceding_keyframe(
    ffprobe: &str,
    path: &Path,
    info: &MediaInfo,
    requested: f64,
    shutdown: &CancellationToken,
) -> Option<f64> {
    if requested < 0.001 {
        return Some(0.0);
    }
    let index = info.video_index?;
    // Packet scanning is bounded in both time and bytes. If no trustworthy keyframe
    // is found, the caller must transcode exactly instead of inventing an offset.
    let lower = (requested - 60.0).max(0.0);
    let mut command = local_command(ffprobe);
    command
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            FORMAT_WHITELIST,
            "-select_streams",
            &index.to_string(),
            "-read_intervals",
            &format!("{lower:.6}%+{:.6}", requested - lower + 4.0),
            "-show_packets",
            "-show_entries",
            "packet=pts_time,flags",
            "-of",
            "json",
        ])
        .arg(path);
    let output = capture(command, 8 * 1024 * 1024, Duration::from_secs(12), shutdown)
        .await
        .ok()?;
    let json: Value = serde_json::from_slice(&output).ok()?;
    json.get("packets")?
        .as_array()?
        .iter()
        .filter(|packet| {
            packet
                .get("flags")
                .and_then(Value::as_str)
                .is_some_and(|flags| flags.contains('K'))
        })
        .filter_map(|packet| packet.get("pts_time").and_then(number_string))
        .map(|pts| pts - info.source_start)
        .filter(|pts| pts.is_finite() && *pts >= -0.05 && *pts <= requested + 0.0001)
        .map(|pts| pts.max(0.0))
        .reduce(f64::max)
}

pub async fn text_subtitles(
    ffmpeg: &str,
    path: &Path,
    info: &MediaInfo,
    shutdown: &CancellationToken,
) -> Result<Vec<(u32, Vec<u8>)>, String> {
    let mut output = Vec::new();
    for track in info.subtitle_tracks.iter().filter(|track| {
        matches!(
            track["codec"].as_str(),
            Some("subrip" | "srt" | "webvtt" | "mov_text" | "text" | "ass" | "ssa")
        )
    }) {
        let id = track["id"].as_u64().ok_or("invalid subtitle track")? as u32;
        let mut command = local_command(ffmpeg);
        command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-protocol_whitelist",
                "file",
                "-format_whitelist",
                FORMAT_WHITELIST,
                "-i",
            ])
            .arg(path)
            .args([
                "-map",
                &format!("0:{id}"),
                "-vn",
                "-an",
                "-c:s",
                "webvtt",
                "-f",
                "webvtt",
                "pipe:1",
            ]);
        let text = capture(command, 4 * 1024 * 1024, Duration::from_secs(15), shutdown).await?;
        if !text.starts_with(b"WEBVTT") {
            return Err("subtitle conversion failed".into());
        }
        output.push((id, text));
    }
    Ok(output)
}
