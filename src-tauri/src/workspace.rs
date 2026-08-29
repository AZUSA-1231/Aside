use crate::platform::{Rect, TargetWindow};

pub const DEFAULT_PANEL_WIDTH: i32 = 420;
pub const DEFAULT_PANEL_HEIGHT: i32 = 680;
pub const MIN_PANEL_WIDTH: i32 = 340;
pub const MIN_PANEL_HEIGHT: i32 = 460;
pub const MAX_PANEL_WIDTH: i32 = 520;
pub const MAX_PANEL_HEIGHT: i32 = 900;
pub const DISPLAY_MARGIN: i32 = 24;

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

pub fn floating_layout(work_area: Rect) -> Rect {
    let width = clamp(DEFAULT_PANEL_WIDTH, 1, work_area.width.max(1));
    let height = clamp(DEFAULT_PANEL_HEIGHT, 1, work_area.height.max(1));
    let x = clamp(
        work_area.right() - width - DISPLAY_MARGIN,
        work_area.x,
        work_area.right() - width,
    );
    let y = clamp(
        work_area.y + (work_area.height - height) / 2,
        work_area.y,
        work_area.bottom() - height,
    );
    Rect::new(x, y, width, height)
}

pub fn workspace_layout(work_area: Rect) -> Layout {
    let available_width = work_area.width.max(2);
    let preferred_agent_width = ((available_width as f32) * 0.2).round() as i32;
    let minimum = MIN_PANEL_WIDTH.min(available_width - 1).max(1);
    let maximum = MAX_PANEL_WIDTH.min(available_width - 1).max(1);
    let agent_width = clamp(preferred_agent_width, minimum, maximum);
    let target_width = (available_width - agent_width).max(1);

    Layout {
        target: Rect::new(work_area.x, work_area.y, target_width, work_area.height),
        agent: Rect::new(
            work_area.x + target_width,
            work_area.y,
            agent_width,
            work_area.height,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{floating_layout, workspace_layout};
    use crate::platform::Rect;

    #[test]
    fn floating_layout_preserves_negative_display_origin() {
        let work_area = Rect::new(-1920, -40, 1920, 1040);
        let panel = floating_layout(work_area);

        assert_eq!(panel.x, -444);
        assert_eq!(panel.y, 140);
        assert_eq!(panel.right(), work_area.right() - 24);
    }

    #[test]
    fn workspace_layout_keeps_the_two_segments_inside_work_area() {
        let work_area = Rect::new(-1600, 0, 1600, 900);
        let layout = workspace_layout(work_area);

        assert_eq!(layout.target.x, work_area.x);
        assert_eq!(layout.agent.right(), work_area.right());
        assert_eq!(layout.target.width + layout.agent.width, work_area.width);
        assert_eq!(layout.agent.width, 340);
    }
}
