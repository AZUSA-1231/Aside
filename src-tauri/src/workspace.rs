use crate::platform::Rect;

pub const MIN_PANEL_WIDTH: i32 = 340;
pub const MIN_PANEL_HEIGHT: i32 = 460;
pub const MAX_PANEL_WIDTH: i32 = 520;
pub const MAX_PANEL_HEIGHT: i32 = 900;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub target: Rect,
    pub agent: Rect,
}

pub fn side_layout(work_area: Rect) -> Layout {
    let width = work_area.width.max(2);
    let agent_width = (((i64::from(width) + 2) / 5) as i32).clamp(1, width - 1);
    let target_width = width - agent_width;
    let height = work_area.height.max(1);
    Layout {
        target: Rect::new(work_area.x, work_area.y, target_width, height),
        agent: Rect::new(work_area.x + target_width, work_area.y, agent_width, height),
    }
}

pub struct Restoration<Snapshot> {
    original: Option<Snapshot>,
}

#[derive(Default)]
pub struct SummonRequests {
    generation: u64,
    pending: Option<u64>,
}

impl SummonRequests {
    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn begin(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.pending = Some(self.generation);
        self.generation
    }

    pub fn cancel(&mut self) {
        self.pending = None;
    }

    pub fn finish(&mut self, generation: u64) -> bool {
        if self.pending != Some(generation) {
            return false;
        }
        self.pending = None;
        true
    }
}

impl<Snapshot> Default for Restoration<Snapshot> {
    fn default() -> Self {
        Self { original: None }
    }
}

impl<Snapshot> Restoration<Snapshot> {
    pub fn original(&self) -> Option<&Snapshot> {
        self.original.as_ref()
    }

    pub fn remember(&mut self, snapshot: Snapshot) -> Result<(), &'static str> {
        if self.original.is_some() {
            return Err("The original window must be restored before another layout begins.");
        }
        self.original = Some(snapshot);
        Ok(())
    }

    pub fn restore<Error>(
        &mut self,
        restore: impl FnOnce(&Snapshot) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if let Some(snapshot) = self.original.as_ref() {
            restore(snapshot)?;
            self.original = None;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{side_layout, Restoration, SummonRequests};
    use crate::platform::Rect;

    #[test]
    fn layout_uses_complementary_full_height_segments() {
        for area in [
            Rect::new(-1920, 40, 1920, 1040),
            Rect::new(11, -1080, 1733, 1080),
            Rect::new(0, 0, 7680, 2160),
            Rect::new(-300, 14, 300, 600),
            Rect::new(0, 0, 2, 1),
        ] {
            let layout = side_layout(area);
            assert_eq!(layout.target.x, area.x);
            assert_eq!(layout.agent.right(), area.right());
            assert_eq!(layout.target.right(), layout.agent.x);
            assert_eq!(layout.target.y, area.y);
            assert_eq!(layout.agent.y, area.y);
            assert_eq!(layout.target.bottom(), area.bottom());
            assert_eq!(layout.agent.bottom(), area.bottom());
            assert!((f64::from(layout.agent.width) - f64::from(area.width) * 0.2).abs() <= 0.6);
        }
    }

    #[test]
    fn physical_fraction_does_not_use_old_width_caps() {
        assert_eq!(side_layout(Rect::new(0, 0, 1920, 1080)).agent.width, 384);
        assert_eq!(side_layout(Rect::new(0, 0, 3840, 2160)).agent.width, 768);
        assert_eq!(side_layout(Rect::new(0, 0, 7680, 2160)).agent.width, 1536);
    }

    #[test]
    fn failed_restore_retains_the_original_and_prevents_overwrite() {
        let mut restoration = Restoration::default();
        restoration
            .remember(("original-window", "maximized"))
            .unwrap();
        assert_eq!(
            restoration.restore(|_| Err("temporary refusal")),
            Err("temporary refusal")
        );
        assert!(restoration.remember(("other-window", "normal")).is_err());
        let mut calls = Vec::new();
        restoration
            .restore::<()>(|snapshot| {
                calls.push(*snapshot);
                Ok(())
            })
            .unwrap();
        restoration
            .restore::<()>(|_| panic!("must restore only once"))
            .unwrap();
        assert_eq!(calls, vec![("original-window", "maximized")]);
        assert!(restoration.original().is_none());
    }

    #[test]
    fn cancelled_capture_cannot_open_or_replace_a_later_summon() {
        let mut requests = SummonRequests::default();
        let cancelled = requests.begin();
        requests.cancel();
        assert!(!requests.finish(cancelled));
        let current = requests.begin();
        assert!(!requests.finish(cancelled));
        assert!(requests.is_pending());
        assert!(requests.finish(current));
        assert!(!requests.finish(current));
    }
}
