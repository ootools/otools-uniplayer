use url::Url;

pub fn validate_init(token: &str, origin: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) && valid_origin(origin)
}

fn valid_origin(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() == "otools-plugin" {
        return value == "otools-plugin://localhost";
    }
    matches!(url.scheme(), "http" | "https" | "tauri")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && (url.path().is_empty() || url.path() == "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && (value == format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default())
            || url.port().is_some_and(|port| {
                value
                    == format!(
                        "{}://{}:{port}",
                        url.scheme(),
                        url.host_str().unwrap_or_default()
                    )
            }))
}

pub fn safe_media_name(name: &str) -> bool {
    if matches!(name, "index.m3u8" | "init.mp4" | "subtitle-external.vtt") {
        return true;
    }
    if let Some(digits) = name
        .strip_prefix("segment")
        .and_then(|s| s.strip_suffix(".m4s"))
    {
        return !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    }
    if let Some(digits) = name
        .strip_prefix("subtitle-track-")
        .and_then(|s| s.strip_suffix(".vtt"))
    {
        return !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    }
    false
}

pub fn srt_to_vtt(text: &str) -> Result<String, &'static str> {
    let normalized = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut output = String::from("WEBVTT\n\n");
    let mut cues = 0;
    for line in normalized.lines() {
        if let Some((left, right)) = line.split_once("-->") {
            let left = left.trim();
            let right = right.split_whitespace().next().unwrap_or("");
            if !timestamp(left) || !timestamp(right) {
                return Err("invalid subtitle timestamp");
            }
            output.push_str(&left.replace(',', "."));
            output.push_str(" --> ");
            output.push_str(&right.replace(',', "."));
            if let Some((_, settings)) = line
                .split_once("-->")
                .and_then(|(_, r)| r.trim().split_once(char::is_whitespace))
                && !settings.trim().is_empty()
            {
                output.push(' ');
                output.push_str(settings.trim());
            }
            output.push('\n');
            cues += 1;
        } else {
            output.push_str(line);
            output.push('\n');
        }
    }
    if cues == 0 {
        Err("subtitle has no cues")
    } else {
        Ok(output)
    }
}

fn timestamp(value: &str) -> bool {
    let Some((clock, millis)) = value.rsplit_once([',', '.']) else {
        return false;
    };
    let parts = clock.split(':').collect::<Vec<_>>();
    parts.len() == 3
        && !parts[0].is_empty()
        && parts[0].bytes().all(|b| b.is_ascii_digit())
        && parts[1].len() == 2
        && parts[1].bytes().all(|b| b.is_ascii_digit())
        && parts[2].len() == 2
        && parts[2].bytes().all(|b| b.is_ascii_digit())
        && millis.len() == 3
        && millis.bytes().all(|b| b.is_ascii_digit())
}
