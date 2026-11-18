#[derive(Clone, Debug)]
pub struct Segment {
    pub name: String,
    pub start: f64,
    pub end: f64,
    pub bytes: u64,
}

pub struct CachePolicy {
    pub byte_limit: u64,
    pub ahead_seconds: f64,
    pub behind_seconds: f64,
    pub low_water_seconds: f64,
}

pub struct Decision {
    pub evict: Vec<String>,
    pub stop: bool,
    pub need_reload: bool,
}

impl CachePolicy {
    pub fn decide(&self, entries: &[Segment], position: f64, extra_bytes: u64) -> Decision {
        let mut total = entries.iter().fold(extra_bytes, |total, entry| {
            total.saturating_add(entry.bytes)
        });
        let earliest = entries
            .iter()
            .map(|entry| entry.start)
            .fold(f64::INFINITY, f64::min);
        let latest = entries
            .iter()
            .map(|entry| entry.end)
            .fold(f64::NEG_INFINITY, f64::max);
        let need_reload =
            earliest.is_finite() && (position + 0.25 < earliest || position > latest + 0.25);
        let mut evict = Vec::new();
        let cutoff = position - self.behind_seconds;
        for entry in entries {
            if entry.end <= cutoff {
                total = total.saturating_sub(entry.bytes);
                evict.push(entry.name.clone());
            }
        }
        let ahead = entries
            .iter()
            .filter(|entry| !evict.contains(&entry.name))
            .map(|entry| entry.end)
            .fold(position, f64::max)
            - position;
        Decision {
            evict,
            stop: total >= self.byte_limit || ahead > self.ahead_seconds,
            need_reload,
        }
    }
}
