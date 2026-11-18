use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use otools_media_service::{
    auth::Guard,
    cache::{CachePolicy, Segment},
    media::{safe_media_name, srt_to_vtt, validate_init},
};

fn headers(origin: &str, host: &str, auth: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("origin", HeaderValue::from_str(origin).unwrap());
    h.insert("host", HeaderValue::from_str(host).unwrap());
    if let Some(auth) = auth {
        h.insert("authorization", HeaderValue::from_str(auth).unwrap());
    }
    h
}

#[test]
fn control_and_media_require_token_exact_origin_and_bound_host() {
    let token = "a".repeat(64);
    let guard = Guard::new(token.clone(), "http://localhost:6574".into(), 31001);
    let good = headers(
        "http://localhost:6574",
        "127.0.0.1:31001",
        Some(&format!("Bearer {token}")),
    );
    assert_eq!(guard.check(&Method::POST, &good), Ok(()));
    for (h, expected) in [
        (
            headers("http://localhost:6574", "127.0.0.1:31001", None),
            StatusCode::UNAUTHORIZED,
        ),
        (
            headers(
                "http://localhost:6574.evil",
                "127.0.0.1:31001",
                Some(&format!("Bearer {token}")),
            ),
            StatusCode::FORBIDDEN,
        ),
        (
            headers(
                "http://localhost:6574",
                "localhost:31001",
                Some(&format!("Bearer {token}")),
            ),
            StatusCode::FORBIDDEN,
        ),
        (
            headers(
                "http://localhost:6574",
                "127.0.0.1:31002",
                Some(&format!("Bearer {token}")),
            ),
            StatusCode::FORBIDDEN,
        ),
        (
            headers(
                "http://localhost:6574",
                "127.0.0.1:31001",
                Some("Bearer bad"),
            ),
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        assert_eq!(guard.check(&Method::GET, &h), Err(expected));
    }
    let mut missing = good.clone();
    missing.remove("origin");
    assert_eq!(
        guard.check(&Method::GET, &missing),
        Err(StatusCode::FORBIDDEN)
    );
}

#[test]
fn preflight_requires_only_known_methods_headers_and_exact_origin() {
    let guard = Guard::new("a".repeat(64), "http://localhost:6574".into(), 31001);
    let mut h = headers("http://localhost:6574", "127.0.0.1:31001", None);
    h.insert(
        "access-control-request-method",
        HeaderValue::from_static("POST"),
    );
    h.insert(
        "access-control-request-headers",
        HeaderValue::from_static("authorization, content-type"),
    );
    assert_eq!(guard.check(&Method::OPTIONS, &h), Ok(()));
    h.insert(
        "access-control-request-headers",
        HeaderValue::from_static("authorization, x-evil"),
    );
    assert_eq!(
        guard.check(&Method::OPTIONS, &h),
        Err(StatusCode::FORBIDDEN)
    );
    h.insert(
        "access-control-request-method",
        HeaderValue::from_static("DELETE"),
    );
    assert_eq!(
        guard.check(&Method::OPTIONS, &h),
        Err(StatusCode::FORBIDDEN)
    );
}

#[test]
fn initialization_rejects_weak_tokens_and_non_origin_urls() {
    assert!(validate_init(&"a".repeat(64), "http://localhost:6574"));
    assert!(validate_init(&"9".repeat(64), "tauri://localhost"));
    for (token, origin) in [
        ("weak".to_owned(), "http://localhost:6574"),
        ("g".repeat(64), "http://localhost:6574"),
        ("a".repeat(64), "null"),
        ("a".repeat(64), "https://example.com/path"),
        ("a".repeat(64), "http://user:password@localhost"),
    ] {
        assert!(!validate_init(&token, origin));
    }
}

#[test]
fn packaged_otools_protocol_origin_requires_localhost_and_the_same_exact_origin() {
    let token = "a".repeat(64);
    assert!(validate_init(&token, "otools-plugin://localhost"));
    for origin in [
        "otools-plugin://evil",
        "otools-plugin://localhost:123",
        "otools-plugin://localhost/path",
        "otools-plugin://user@localhost",
        "otools-plugin://localhost?x=1",
    ] {
        assert!(!validate_init(&token, origin), "must reject {origin}");
    }
    let guard = Guard::new(token.clone(), "otools-plugin://localhost".into(), 31001);
    assert_eq!(
        guard.check(
            &Method::POST,
            &headers(
                "otools-plugin://localhost",
                "127.0.0.1:31001",
                Some(&format!("Bearer {token}"))
            )
        ),
        Ok(())
    );
    assert_eq!(
        guard.check(
            &Method::POST,
            &headers(
                "otools-plugin://evil",
                "127.0.0.1:31001",
                Some(&format!("Bearer {token}"))
            )
        ),
        Err(StatusCode::FORBIDDEN)
    );
}

#[test]
fn unpublished_paths_and_traversal_never_become_media_names() {
    for name in [
        "index.m3u8",
        "init.mp4",
        "segment000001.m4s",
        "subtitle-track-1.vtt",
    ] {
        assert!(safe_media_name(name));
    }
    for name in [
        "../secret",
        "/tmp/a",
        "a/b",
        "a\\b",
        "%2e%2e",
        "segment000001.m4s.tmp",
        ".hidden",
        "",
        "token.json",
    ] {
        assert!(!safe_media_name(name));
    }
}

#[test]
fn cache_evicts_only_consumed_segments_and_stops_before_discarding_unread_media() {
    let policy = CachePolicy {
        byte_limit: 70,
        ahead_seconds: 20.0,
        behind_seconds: 6.0,
        low_water_seconds: 4.0,
    };
    let entries = vec![
        Segment {
            name: "segment0.m4s".into(),
            start: 0.0,
            end: 2.0,
            bytes: 40,
        },
        Segment {
            name: "segment1.m4s".into(),
            start: 2.0,
            end: 4.0,
            bytes: 40,
        },
        Segment {
            name: "segment2.m4s".into(),
            start: 4.0,
            end: 6.0,
            bytes: 40,
        },
    ];
    let unread = policy.decide(&entries, 0.0, 0);
    assert!(unread.evict.is_empty());
    assert!(unread.stop);
    assert!(!unread.need_reload);
    let consumed = policy.decide(&entries, 10.5, 0);
    assert_eq!(consumed.evict, vec!["segment0.m4s", "segment1.m4s"]);
    assert!(!consumed.stop);
    assert!(policy.decide(&entries[2..], 0.0, 0).need_reload);
}

#[test]
fn srt_conversion_keeps_text_and_normalizes_timestamps() {
    let text = "\u{feff}1\r\n00:00:01,200 --> 00:00:02,500\r\nHello <i>world</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n你好\r\n";
    let vtt = srt_to_vtt(text).unwrap();
    assert!(vtt.starts_with("WEBVTT\n\n"));
    assert!(vtt.contains("00:00:01.200 --> 00:00:02.500"));
    assert!(vtt.contains("Hello <i>world</i>"));
    assert!(vtt.contains("你好"));
    assert!(srt_to_vtt("not a subtitle").is_err());
}
