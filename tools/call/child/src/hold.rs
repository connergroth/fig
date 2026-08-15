use std::time::{Duration, Instant};

/// Renewable orphan deadline for an unreleased `--hold` child.
#[derive(Debug)]
pub struct HoldWatchdog {
    expire: Duration,
    deadline: Option<Instant>,
    disarmed: bool,
}

impl HoldWatchdog {
    pub fn new(expire: Duration) -> Self {
        Self {
            expire,
            deadline: None,
            disarmed: false,
        }
    }

    pub fn arm_at(&mut self, now: Instant) {
        self.renew_at(now);
    }

    pub fn renew_at(&mut self, now: Instant) {
        if !self.disarmed {
            self.deadline = Some(now + self.expire);
        }
    }

    pub fn disarm(&mut self) {
        self.disarmed = true;
        self.deadline = None;
    }

    pub fn expired_at(&self, now: Instant) -> bool {
        !self.disarmed && self.deadline.is_some_and(|deadline| now >= deadline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expires_without_heartbeat() {
        let t0 = Instant::now();
        let mut w = HoldWatchdog::new(Duration::from_millis(120));
        w.arm_at(t0);
        assert!(!w.expired_at(t0 + Duration::from_millis(119)));
        assert!(w.expired_at(t0 + Duration::from_millis(120)));
    }

    #[test]
    fn heartbeat_renews_full_deadline() {
        let t0 = Instant::now();
        let mut w = HoldWatchdog::new(Duration::from_millis(120));
        w.arm_at(t0);
        w.renew_at(t0 + Duration::from_millis(90));
        assert!(!w.expired_at(t0 + Duration::from_millis(120)));
        assert!(!w.expired_at(t0 + Duration::from_millis(209)));
        assert!(w.expired_at(t0 + Duration::from_millis(210)));
    }

    #[test]
    fn go_disarms_permanently() {
        let t0 = Instant::now();
        let mut w = HoldWatchdog::new(Duration::from_millis(120));
        w.arm_at(t0);
        w.disarm();
        w.renew_at(t0 + Duration::from_secs(1));
        assert!(!w.expired_at(t0 + Duration::from_secs(100)));
    }
}
