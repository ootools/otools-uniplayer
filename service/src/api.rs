use crate::{
    auth::Guard,
    media::{safe_media_name, srt_to_vtt},
    pipeline::{Pipeline, PipelineConfig},
    probe::{self, MediaInfo},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::PathBuf, sync::Arc, time::Instant};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct AppState {
    pub guard: Guard,
    pub origin: String,
    pub ffmpeg: String,
    pub ffprobe: String,
    pub inner: Arc<Mutex<ServiceState>>,
    pub started: Instant,
    operation: Arc<Mutex<()>>,
    shutdown: CancellationToken,
}

#[derive(Default)]
pub struct ServiceState {
    pub generation: u64,
    pub position: f64,
    pub paused: bool,
    pub rate: f64,
    pub need_reload: bool,
    pub pipeline_state: String,
    media: Option<OpenedMedia>,
    pipeline: Option<Pipeline>,
}

#[derive(Clone)]
struct OpenedMedia {
    path: PathBuf,
    info: MediaInfo,
    audio_track: Option<u32>,
    subtitles: Vec<(u32, Vec<u8>)>,
}

impl AppState {
    pub fn new(token: String, origin: String, ffmpeg: String, ffprobe: String, port: u16) -> Self {
        Self {
            guard: Guard::new(token, origin.clone(), port),
            origin,
            ffmpeg,
            ffprobe,
            inner: Arc::new(Mutex::new(ServiceState {
                rate: 1.0,
                paused: true,
                pipeline_state: "idle".into(),
                ..Default::default()
            })),
            started: Instant::now(),
            operation: Arc::new(Mutex::new(())),
            shutdown: CancellationToken::new(),
        }
    }

    pub async fn shutdown(&self) {
        // Cancellation interrupts a probe/start that currently owns operation,
        // so EOF/SIGTERM cannot be held hostage by a slow media request.
        self.shutdown.cancel();
        let _operation = self.operation.lock().await;
        self.close_pipeline("closed", true).await;
    }

    async fn close_pipeline(&self, state: &str, forget: bool) {
        let pipeline = {
            let mut inner = self.inner.lock().await;
            inner.generation += 1;
            inner.pipeline_state = state.into();
            inner.paused = true;
            inner.need_reload = false;
            if forget {
                inner.media = None;
            }
            inner.pipeline.take()
        };
        if let Some(pipeline) = pipeline {
            pipeline.stop().await;
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/status", get(status))
        .route("/api/close", post(close))
        .route("/api/progress", post(progress))
        .route("/api/open", post(open))
        .route("/api/seek", post(seek))
        .route("/api/pause", post(pause))
        .route("/api/subtitle", get(subtitle).post(external_subtitle))
        .route("/media/{generation}/{file}", get(media))
        .fallback(not_found)
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, auth_and_cors))
}

async fn auth_and_cors(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    match state.guard.check(request.method(), request.headers()) {
        Ok(()) if request.method() == Method::OPTIONS => {
            let mut response = StatusCode::NO_CONTENT.into_response();
            add_cors(response.headers_mut(), &state.origin);
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST, OPTIONS"),
            );
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("Authorization, Content-Type, Range"),
            );
            response.headers_mut().insert(
                header::ACCESS_CONTROL_MAX_AGE,
                HeaderValue::from_static("600"),
            );
            response
        }
        Ok(()) => {
            // An accepted control operation owns process lifecycle even if
            // the HTTP client disconnects. Dropping Next's future during an
            // open/seek could otherwise strand a live FFmpeg supervisor.
            let shutdown = state.shutdown.clone();
            let operation = tokio::spawn(async move {
                tokio::select! {
                    result = next.run(request) => result,
                    _ = shutdown.cancelled() => error(StatusCode::SERVICE_UNAVAILABLE, "service is shutting down"),
                }
            });
            let mut response = operation
                .await
                .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "request failed"));
            add_cors(response.headers_mut(), &state.origin);
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response.headers_mut().insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            response
        }
        Err(status) => status.into_response(),
    }
}

fn add_cors(headers: &mut HeaderMap, origin: &str) {
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResponse {
    generation: u64,
    position: f64,
    paused: bool,
    rate: f64,
    pipeline_state: String,
    need_reload: bool,
    cache_bytes: u64,
}

async fn status_value(state: &AppState) -> StatusResponse {
    let inner = state.inner.lock().await;
    let snapshot = match &inner.pipeline {
        Some(pipeline) => Some(pipeline.snapshot().await),
        None => None,
    };
    StatusResponse {
        generation: inner.generation,
        position: inner.position,
        paused: inner.paused,
        rate: inner.rate,
        pipeline_state: snapshot
            .as_ref()
            .map(|snapshot| snapshot.pipeline_state.clone())
            .unwrap_or_else(|| inner.pipeline_state.clone()),
        need_reload: inner.need_reload
            || snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.need_reload),
        cache_bytes: snapshot.map(|snapshot| snapshot.cache_bytes).unwrap_or(0),
    }
}

async fn status(State(state): State<AppState>) -> Json<StatusResponse> {
    Json(status_value(&state).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionRequest {
    position: f64,
    paused: Option<bool>,
    rate: Option<f64>,
}

fn valid_position(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}
fn valid_rate(value: Option<f64>) -> bool {
    value.is_none_or(|rate| rate.is_finite() && (0.25..=2.5).contains(&rate))
}
fn error(status: StatusCode, message: impl AsRef<str>) -> Response {
    (status, Json(json!({"error": message.as_ref()}))).into_response()
}

async fn progress(State(state): State<AppState>, Json(body): Json<PositionRequest>) -> Response {
    if !valid_position(body.position) || !valid_rate(body.rate) {
        return error(StatusCode::BAD_REQUEST, "invalid playback position or rate");
    }
    let _operation = state.operation.lock().await;
    let (pipeline, stop) = {
        let mut inner = state.inner.lock().await;
        inner.position = body.position.min(
            inner
                .media
                .as_ref()
                .map(|media| media.info.duration)
                .unwrap_or(body.position),
        );
        let rate_changed = body
            .rate
            .is_some_and(|rate| (inner.rate - rate).abs() > 0.0001);
        if let Some(rate) = body.rate {
            inner.rate = rate;
        }
        if let Some(paused) = body.paused {
            inner.paused = paused;
        }
        let stop = body.paused == Some(true) || rate_changed;
        if stop && inner.pipeline.is_some() {
            inner.need_reload = true;
        }
        (inner.pipeline.clone(), stop)
    };
    if let Some(pipeline) = pipeline {
        pipeline.progress(body.position).await;
        if stop {
            pipeline.stop().await;
        }
    }
    Json(status_value(&state).await).into_response()
}

async fn close(State(state): State<AppState>) -> Response {
    let _operation = state.operation.lock().await;
    state.close_pipeline("closed", true).await;
    Json(status_value(&state).await).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    path: String,
    start: Option<f64>,
    rate: Option<f64>,
    audio_track: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekRequest {
    position: f64,
    rate: Option<f64>,
    audio_track: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackResponse {
    generation: u64,
    effective_start: f64,
    requested_start: f64,
    seek_precision: String,
    playlist: String,
    mode: String,
    media: MediaInfo,
}

async fn open(State(state): State<AppState>, Json(body): Json<OpenRequest>) -> Response {
    let start = body.start.unwrap_or(0.0);
    if !valid_position(start) || !valid_rate(body.rate) {
        return error(StatusCode::BAD_REQUEST, "invalid playback position or rate");
    }
    let _operation = state.operation.lock().await;
    if state.shutdown.is_cancelled() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "service is shutting down");
    }
    state.close_pipeline("probing", true).await;
    let result = async {
        let (path, info) =
            probe::probe_with_cancel(&state.ffprobe, &body.path, &state.shutdown).await?;
        let audio_track = select_audio(&info, body.audio_track)?;
        // Subtitle conversion also happens before the live worker exists: no
        // probe or extraction process may overlap the generation's FFmpeg.
        let subtitles = probe::text_subtitles(&state.ffmpeg, &path, &info, &state.shutdown).await?;
        let opened = OpenedMedia {
            path,
            info,
            audio_track,
            subtitles,
        };
        start_playback(&state, opened, start, body.rate.unwrap_or(1.0)).await
    }
    .await;
    match result {
        Ok(response) => Json(response).into_response(),
        Err(message) => {
            state.inner.lock().await.pipeline_state = "error".into();
            error(StatusCode::BAD_REQUEST, message)
        }
    }
}

fn select_audio(info: &MediaInfo, requested: Option<u32>) -> Result<Option<u32>, String> {
    if let Some(id) = requested {
        if !info.audio_tracks.iter().any(|track| track.id == id) {
            return Err("audio track is not available".into());
        }
        Ok(Some(id))
    } else {
        Ok(info.audio_tracks.first().map(|track| track.id))
    }
}

async fn start_playback(
    state: &AppState,
    opened: OpenedMedia,
    requested: f64,
    rate: f64,
) -> Result<PlaybackResponse, String> {
    let start = requested.min((opened.info.duration - 0.05).max(0.0));
    let compatible_audio = opened.audio_track.is_none_or(|id| {
        opened
            .info
            .audio_tracks
            .iter()
            .any(|track| track.id == id && track.codec == "aac")
    });
    let mut copy = compatible_audio && probe::compatible_video(&opened.info);
    let mut effective_start = start;
    let mut precision = "exact";
    if copy && opened.info.video_index.is_some() {
        if let Some(keyframe) = probe::preceding_keyframe(
            &state.ffprobe,
            &opened.path,
            &opened.info,
            start,
            &state.shutdown,
        )
        .await
        {
            effective_start = keyframe;
            precision = "keyframe";
        } else {
            copy = false;
        }
    }
    let pipeline = Pipeline::start(
        &state.ffmpeg,
        PipelineConfig {
            path: opened.path.clone(),
            media: opened.info.clone(),
            effective_start,
            rate,
            audio_track: opened.audio_track,
            copy,
            subtitles: opened.subtitles.clone(),
        },
        state.shutdown.clone(),
    )
    .await?;
    if state.shutdown.is_cancelled() {
        pipeline.stop().await;
        return Err("service is shutting down".into());
    }
    let mut inner = state.inner.lock().await;
    inner.position = effective_start;
    inner.rate = rate;
    inner.paused = false;
    inner.need_reload = false;
    inner.pipeline_state = "running".into();
    inner.media = Some(opened.clone());
    inner.pipeline = Some(pipeline);
    Ok(PlaybackResponse {
        generation: inner.generation,
        effective_start,
        requested_start: requested,
        seek_precision: precision.into(),
        playlist: format!("/media/{}/index.m3u8", inner.generation),
        mode: if copy { "copy" } else { "transcode" }.into(),
        media: opened.info,
    })
}

async fn seek(State(state): State<AppState>, Json(body): Json<SeekRequest>) -> Response {
    if !valid_position(body.position) || !valid_rate(body.rate) {
        return error(StatusCode::BAD_REQUEST, "invalid playback position or rate");
    }
    let _operation = state.operation.lock().await;
    if state.shutdown.is_cancelled() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "service is shutting down");
    }
    let (mut opened, rate) = {
        let inner = state.inner.lock().await;
        let Some(opened) = &inner.media else {
            return error(StatusCode::CONFLICT, "no media is open");
        };
        (opened.clone(), body.rate.unwrap_or(inner.rate))
    };
    if body.audio_track.is_some() {
        match select_audio(&opened.info, body.audio_track) {
            Ok(audio) => opened.audio_track = audio,
            Err(message) => return error(StatusCode::BAD_REQUEST, message),
        }
    }
    state.close_pipeline("starting", false).await;
    match start_playback(&state, opened, body.position, rate).await {
        Ok(response) => Json(response).into_response(),
        Err(message) => {
            let mut inner = state.inner.lock().await;
            inner.pipeline_state = "error".into();
            inner.need_reload = true;
            error(StatusCode::BAD_REQUEST, message)
        }
    }
}

async fn pause(State(state): State<AppState>, Json(body): Json<PositionRequest>) -> Response {
    if !valid_position(body.position) || !valid_rate(body.rate) {
        return error(StatusCode::BAD_REQUEST, "invalid playback position or rate");
    }
    let _operation = state.operation.lock().await;
    let pipeline = {
        let mut inner = state.inner.lock().await;
        inner.position = body.position.min(
            inner
                .media
                .as_ref()
                .map(|media| media.info.duration)
                .unwrap_or(body.position),
        );
        inner.paused = true;
        inner.need_reload = inner.pipeline.is_some();
        if let Some(rate) = body.rate {
            inner.rate = rate;
        }
        inner.pipeline.clone()
    };
    if let Some(pipeline) = pipeline {
        pipeline.progress(body.position).await;
        pipeline.stop().await;
    }
    Json(status_value(&state).await).into_response()
}

#[derive(Deserialize)]
struct SubtitleQuery {
    track: u32,
}

async fn subtitle(State(state): State<AppState>, Query(query): Query<SubtitleQuery>) -> Response {
    let inner = state.inner.lock().await;
    let Some(pipeline) = &inner.pipeline else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match pipeline
        .media(&format!("subtitle-track-{}.vtt", query.track))
        .await
    {
        Ok(bytes) => typed_media(bytes, "text/vtt; charset=utf-8", None),
        Err(()) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct ExternalSubtitleRequest {
    path: String,
}

async fn external_subtitle(
    State(state): State<AppState>,
    Json(body): Json<ExternalSubtitleRequest>,
) -> Response {
    let _operation = state.operation.lock().await;
    let (generation, pipeline) = {
        let inner = state.inner.lock().await;
        let Some(pipeline) = &inner.pipeline else {
            return error(StatusCode::CONFLICT, "no media is open");
        };
        (inner.generation, pipeline.clone())
    };
    let path = match probe::local_file(&body.path).await {
        Ok(path) => path,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "srt" | "vtt") {
        return error(
            StatusCode::BAD_REQUEST,
            "external subtitles must be SRT or VTT",
        );
    }
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(_) => return error(StatusCode::BAD_REQUEST, "subtitle file cannot be read"),
    };
    if metadata.len() > 4 * 1024 * 1024 {
        return error(StatusCode::BAD_REQUEST, "subtitle exceeds limit");
    }
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(_) => return error(StatusCode::BAD_REQUEST, "subtitle must be UTF-8 text"),
    };
    let text = if extension == "srt" {
        match srt_to_vtt(&text) {
            Ok(text) => text,
            Err(message) => return error(StatusCode::BAD_REQUEST, message),
        }
    } else {
        let text = text.trim_start_matches('\u{feff}');
        if !text.starts_with("WEBVTT") || !text.contains("-->") {
            return error(StatusCode::BAD_REQUEST, "invalid VTT subtitles");
        }
        text.to_owned()
    };
    match pipeline.external_subtitle(text.as_bytes()).await {
        Ok(()) => {
            Json(json!({"subtitleURL": format!("/media/{generation}/subtitle-external.vtt")}))
                .into_response()
        }
        Err(message) => error(StatusCode::BAD_REQUEST, message),
    }
}

async fn media(
    State(state): State<AppState>,
    Path((generation, file)): Path<(u64, String)>,
    headers: HeaderMap,
) -> Response {
    if !safe_media_name(&file) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let inner = state.inner.lock().await;
    if generation != inner.generation {
        return StatusCode::GONE.into_response();
    }
    let Some(pipeline) = &inner.pipeline else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = if file.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else if file.ends_with(".m4s") {
        "video/iso.segment"
    } else if file.ends_with(".vtt") {
        "text/vtt; charset=utf-8"
    } else {
        "video/mp4"
    };
    match pipeline.media(&file).await {
        Ok(bytes) => typed_media(
            bytes,
            mime,
            headers
                .get(header::RANGE)
                .and_then(|value| value.to_str().ok()),
        ),
        Err(()) => StatusCode::NOT_FOUND.into_response(),
    }
}

fn typed_media(bytes: bytes::Bytes, mime: &'static str, range: Option<&str>) -> Response {
    let length = bytes.len();
    let mut response = if let Some(range) = range {
        let parsed = range
            .strip_prefix("bytes=")
            .and_then(|range| range.split_once('-'))
            .and_then(|(start, end)| {
                let start = start.parse::<usize>().ok()?;
                let end = if end.is_empty() {
                    length.checked_sub(1)?
                } else {
                    end.parse().ok()?
                };
                (start <= end && end < length).then_some((start, end))
            });
        if let Some((start, end)) = parsed {
            let mut response =
                (StatusCode::PARTIAL_CONTENT, bytes.slice(start..=end)).into_response();
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{length}")).unwrap(),
            );
            response
        } else {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{length}")).unwrap(),
            );
            return response;
        }
    } else {
        bytes.into_response()
    };
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    response
        .headers_mut()
        .insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}
