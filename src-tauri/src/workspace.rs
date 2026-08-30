use crate::platform::{Rect, TargetWindow};

pub const MIN_PANEL_WIDTH: i32 = 340;
pub const MIN_PANEL_HEIGHT: i32 = 460;
pub const MAX_PANEL_WIDTH: i32 = 520;
pub const MAX_PANEL_HEIGHT: i32 = 900;
const SIDE_WIDTH_PERCENT: i64 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub target: Rect,
    pub agent: Rect,
}

#[derive(Clone, Debug)]
pub struct WorkspaceSnapshot {
    pub target: TargetWindow,
}

impl WorkspaceSnapshot {
    pub fn new(target: TargetWindow) -> Self {
        Self { target }
    }
}

fn clamp(value: i32, minimum: i32, maximum: i32) -> i32 {
    value.min(maximum).max(minimum)
}

pub fn side_layout(work_area: Rect) -> Layout {
    let available_width = work_area.width.max(2);
    let preferred_agent_width = ((available_width as i64 * SIDE_WIDTH_PERCENT + 50) / 100) as i32;
    let minimum = MIN_PANEL_WIDTH.min(available_width - 1).max(1);
    let maximum = MAX_PANEL_WIDTH.min(available_width - 1).max(1);
    let agent_width = clamp(preferred_agent_width, minimum, maximum);
    let target_width = (available_width - agent_width).max(1);
    let height = work_area.height.max(1);

    Layout {
        target: Rect::new(work_area.x, work_area.y, target_width, height),
        agent: Rect::new(work_area.x + target_width, work_area.y, agent_width, height),
    }
}

#[cfg(test)]
mod tests {
    use super::side_layout;
    use crate::platform::Rect;

    #[test]
    fn side_layout_keeps_the_two_segments_inside_work_area() {
        let work_area = Rect::new(-1600, 0, 1600, 900);
        let layout = side_layout(work_area);

        assert_eq!(layout.target.x, work_area.x);
        assert_eq!(layout.target.y, work_area.y);
        assert_eq!(layout.target.bottom(), work_area.bottom());
        assert_eq!(layout.agent.right(), work_area.right());
        assert_eq!(layout.target.width + layout.agent.width, work_area.width);
        assert_eq!(layout.agent.width, 340);
    }

    #[test]
    fn side_layout_rounds_the_twenty_percent_rail() {
        let work_area = Rect::new(11, -8, 1733, 1080);
        let layout = side_layout(work_area);

        assert_eq!(layout.agent.width, 347);
        assert_eq!(layout.agent.x, work_area.x + 1733 - 347);
        assert_eq!(layout.target.width + layout.agent.width, work_area.width);
    }

    #[test]
    fn side_layout_clamps_a_narrow_display_without_crossing_the_origin() {
        let work_area = Rect::new(-300, 14, 300, 600);
        let layout = side_layout(work_area);

        assert_eq!(layout.agent.width, 299);
        assert_eq!(layout.target.width, 1);
        assert_eq!(layout.target.x, -300);
        assert_eq!(layout.agent.right(), work_area.right());
        assert_eq!(layout.agent.bottom(), work_area.bottom());
    }
}
