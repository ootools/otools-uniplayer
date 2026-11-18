use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use otools_media_service::{
    auth::Guard,
    cache::{CachePolicy, Segment},
    media::validate_init,
};

#[test]
fn init_requires_exactly_256_bit_hex_token() {
    assert!(!validate_init(&"a".repeat(65), "http://localhost:6574"));
    assert!(!validate_init(&"a".repeat(128), "http://localhost:6574"));
}

#[test]
fn duplicate_security_headers_are_not_treated_as_an_authenticated_request() {
    let guard = Guard::new("a".repeat(64), "http://localhost:6574".into(), 31001);
    for name in ["host", "origin", "authorization"] {
        let mut h = HeaderMap::new();
        h.insert("host", HeaderValue::from_static("127.0.0.1:31001"));
        h.insert("origin", HeaderValue::from_static("http://localhost:6574"));
        h.insert(
            "authorization",
            HeaderValue::from_str(&format!("Bearer {}", "a".repeat(64))).unwrap(),
        );
        h.append(name, h.get(name).unwrap().clone());
        assert_eq!(guard.check(&Method::GET, &h), Err(StatusCode::FORBIDDEN));
    }
}

#[test]
fn byte_accounting_does_not_wrap_and_cached_range_exhaustion_requires_reload() {
    let policy = CachePolicy {
        byte_limit: 256,
        ahead_seconds: 64.0,
        behind_seconds: 6.0,
        low_water_seconds: 4.0,
    };
    let entries = vec![
        Segment {
            name: "segment0.m4s".into(),
            start: 0.0,
            end: 2.0,
            bytes: u64::MAX,
        },
        Segment {
            name: "segment1.m4s".into(),
            start: 2.0,
            end: 4.0,
            bytes: 1,
        },
    ];
    let decision = policy.decide(&entries, 0.0, 0);
    assert!(decision.stop);
    assert!(decision.evict.is_empty());
    let consumed = [Segment {
        name: "segment0.m4s".into(),
        start: 0.0,
        end: 2.0,
        bytes: 10,
    }];
    assert!(policy.decide(&consumed, 3.0, 0).need_reload);
}
