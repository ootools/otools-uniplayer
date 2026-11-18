use axum::http::{HeaderMap, Method, StatusCode};

#[derive(Clone)]
pub struct Guard {
    token: String,
    origin: String,
    host: String,
}

impl Guard {
    pub fn new(token: String, origin: String, port: u16) -> Self {
        Self {
            token,
            origin,
            host: format!("127.0.0.1:{port}"),
        }
    }

    pub fn check(&self, method: &Method, headers: &HeaderMap) -> Result<(), StatusCode> {
        if ["host", "origin", "authorization"]
            .iter()
            .any(|name| headers.get_all(*name).iter().count() > 1)
        {
            return Err(StatusCode::FORBIDDEN);
        }
        if headers.get("host").and_then(|v| v.to_str().ok()) != Some(self.host.as_str())
            || headers.get("origin").and_then(|v| v.to_str().ok()) != Some(self.origin.as_str())
        {
            return Err(StatusCode::FORBIDDEN);
        }
        if method == Method::OPTIONS {
            if !matches!(
                headers
                    .get("access-control-request-method")
                    .and_then(|v| v.to_str().ok()),
                Some("GET" | "POST")
            ) {
                return Err(StatusCode::FORBIDDEN);
            }
            if headers
                .get("access-control-request-headers")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .any(|h| {
                    !matches!(
                        h.to_ascii_lowercase().as_str(),
                        "" | "authorization" | "content-type" | "range"
                    )
                })
            {
                return Err(StatusCode::FORBIDDEN);
            }
            return Ok(());
        }
        let value = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let supplied = value.strip_prefix("Bearer ").unwrap_or("").as_bytes();
        let expected = self.token.as_bytes();
        let mut diff = supplied.len() ^ expected.len();
        for i in 0..supplied.len().max(expected.len()) {
            diff |= usize::from(*supplied.get(i).unwrap_or(&0) ^ *expected.get(i).unwrap_or(&0));
        }
        if diff == 0 {
            Ok(())
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}
