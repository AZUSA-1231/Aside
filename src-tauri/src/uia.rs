//! Shared, bounded Windows UI Automation transport for host adapters.
//!
//! Application modules consume sanitized node snapshots and typed pattern reads;
//! COM lifetime, traversal limits, normalization, and provider diagnostics stay
//! inside this module.

use serde::Serialize;

pub(crate) const DEFAULT_MAX_DEPTH: usize = 16;
pub(crate) const DEFAULT_MAX_NODES: usize = 800;
const MAX_NODE_NAME_BYTES: usize = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct UiRect {
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) right: i32,
    pub(crate) bottom: i32,
}

impl UiRect {
    pub(crate) fn is_valid(self) -> bool {
        self.right > self.left && self.bottom > self.top
    }

    pub(crate) fn intersects(self, other: Self) -> bool {
        self.left < other.right
            && other.left < self.right
            && self.top < other.bottom
            && other.top < self.bottom
    }
}

#[derive(Clone, Debug)]
pub(crate) struct RawSemanticNode {
    pub(crate) role: String,
    pub(crate) name: String,
    pub(crate) depth: usize,
    pub(crate) offscreen: Option<bool>,
    pub(crate) bounds: Option<UiRect>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SemanticPage {
    fields: [&'static str; 3],
    nodes: Vec<SemanticNode>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SemanticNode(
    pub(crate) String,
    pub(crate) String,
    pub(crate) Option<SemanticBounds>,
);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct SemanticBounds {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
}

impl SemanticPage {
    pub(crate) fn new(nodes: Vec<SemanticNode>) -> Self {
        Self {
            fields: ["role", "name", "bounds"],
            nodes,
        }
    }
}

pub(crate) struct NormalizedSemantic {
    pub(crate) nodes: Vec<SemanticNode>,
    pub(crate) observed_depth: usize,
    pub(crate) node_truncated: bool,
}

pub(crate) fn normalize_name(value: &str) -> Option<String> {
    let mut normalized = String::with_capacity(value.len().min(MAX_NODE_NAME_BYTES));
    let mut pending_space = false;

    for character in value.chars() {
        if character.is_control() && !character.is_whitespace() {
            return None;
        }
        if character.is_whitespace() {
            pending_space = !normalized.is_empty();
            continue;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        normalized.push(character);
        if normalized.len() > MAX_NODE_NAME_BYTES {
            return None;
        }
    }

    let normalized = normalized.trim().to_string();
    (!normalized.is_empty()).then_some(normalized)
}

pub(crate) fn normalize_semantic(
    raw_nodes: &[RawSemanticNode],
    root_bounds: Option<UiRect>,
    max_nodes: usize,
) -> NormalizedSemantic {
    let mut nodes = Vec::new();
    let mut observed_depth = 0;
    let mut node_truncated = false;

    for (index, raw) in raw_nodes.iter().enumerate() {
        let visible = is_visible(raw, root_bounds);
        let name = normalize_name(&raw.name);
        let is_root = index == 0;

        if !visible || (!is_root && name.is_none()) {
            continue;
        }
        if nodes.len() >= max_nodes {
            node_truncated = raw_nodes[index..].iter().any(|candidate| {
                is_visible(candidate, root_bounds) && normalize_name(&candidate.name).is_some()
            });
            break;
        }

        observed_depth = observed_depth.max(raw.depth);
        nodes.push(SemanticNode(
            raw.role.clone(),
            name.unwrap_or_default(),
            raw.bounds.map(semantic_bounds),
        ));
    }

    if nodes.len() == 1 && nodes[0].1.is_empty() {
        nodes.clear();
        observed_depth = 0;
    }

    NormalizedSemantic {
        nodes,
        observed_depth,
        node_truncated,
    }
}

fn is_visible(raw: &RawSemanticNode, root_bounds: Option<UiRect>) -> bool {
    raw.offscreen != Some(true)
        && raw
            .bounds
            .map(|bounds| {
                bounds.is_valid()
                    && root_bounds
                        .map(|root| root.is_valid() && root.intersects(bounds))
                        .unwrap_or(true)
            })
            .unwrap_or(true)
}

pub(crate) fn semantic_bounds(bounds: UiRect) -> SemanticBounds {
    SemanticBounds {
        x: bounds.left,
        y: bounds.top,
        width: bounds.right.saturating_sub(bounds.left),
        height: bounds.bottom.saturating_sub(bounds.top),
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use std::thread;

    use ::windows::core::{Interface, BSTR};
    use ::windows::Win32::Foundation::{HWND, RECT};
    use ::windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use ::windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomation2, IUIAutomationElement,
        IUIAutomationSelectionItemPattern, IUIAutomationTreeWalker, IUIAutomationValuePattern,
        UIA_SelectionItemPatternId, UIA_ValuePatternId,
    };

    #[derive(Clone, Copy, Debug)]
    pub(crate) struct UiaLimits {
        pub(crate) max_depth: usize,
        pub(crate) max_nodes: usize,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum UiaView {
        Content,
        Control,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub(crate) enum UiaError {
        Unavailable,
        Failed,
    }

    pub(crate) enum UiaWorkerError<E> {
        System(UiaError),
        Operation(E),
    }

    struct ComGuard;

    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    #[derive(Clone)]
    pub(crate) struct UiNode {
        element: IUIAutomationElement,
        depth: usize,
        control_type: Option<i32>,
        name: Option<String>,
        automation_id: Option<String>,
        selected: Option<bool>,
        offscreen: Option<bool>,
        bounds: Option<UiRect>,
    }

    impl UiNode {
        pub(crate) fn role(&self) -> &'static str {
            self.control_type
                .map(role_for_control_type)
                .unwrap_or("unknown")
        }

        pub(crate) fn name(&self) -> Option<&str> {
            self.name.as_deref()
        }

        pub(crate) fn automation_id(&self) -> Option<&str> {
            self.automation_id.as_deref()
        }

        pub(crate) fn selected(&self) -> Option<bool> {
            self.selected
        }

        pub(crate) fn offscreen(&self) -> Option<bool> {
            self.offscreen
        }

        pub(crate) fn bounds(&self) -> Option<UiRect> {
            self.bounds
        }

        pub(crate) fn current_value(&self) -> Option<String> {
            let pattern = unsafe {
                self.element
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            }
            .ok()?;
            let value = unsafe { pattern.CurrentValue() }.ok()?;
            bstr_to_string(value)
        }

        fn raw_semantic_node(&self, role: &str) -> RawSemanticNode {
            RawSemanticNode {
                role: role.to_string(),
                name: self.name.clone().unwrap_or_default(),
                depth: self.depth,
                offscreen: self.offscreen,
                bounds: self.bounds,
            }
        }
    }

    pub(crate) struct UiTree {
        pub(crate) nodes: Vec<UiNode>,
        pub(crate) provider_error: bool,
        pub(crate) depth_truncated: bool,
        pub(crate) node_truncated: bool,
    }

    impl UiTree {
        fn new() -> Self {
            Self {
                nodes: Vec::new(),
                provider_error: false,
                depth_truncated: false,
                node_truncated: false,
            }
        }
    }

    pub(crate) struct UiaSession {
        _com: ComGuard,
        root: IUIAutomationElement,
        content_walker: IUIAutomationTreeWalker,
        control_walker: IUIAutomationTreeWalker,
    }

    impl UiaSession {
        fn new(hwnd: isize) -> Result<Self, UiaError> {
            let initialize_result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if initialize_result.is_err() {
                return Err(UiaError::Unavailable);
            }
            let com = ComGuard;
            let automation: IUIAutomation =
                unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
                    .map_err(|_| UiaError::Unavailable)?;
            if let Ok(automation2) = automation.cast::<IUIAutomation2>() {
                let _ = unsafe { automation2.SetConnectionTimeout(750) };
            }
            let root =
                unsafe { automation.ElementFromHandle(HWND(hwnd as *mut core::ffi::c_void)) }
                    .map_err(|_| UiaError::Failed)?;
            let content_walker =
                unsafe { automation.ContentViewWalker() }.map_err(|_| UiaError::Failed)?;
            let control_walker =
                unsafe { automation.ControlViewWalker() }.map_err(|_| UiaError::Failed)?;
            Ok(Self {
                _com: com,
                root,
                content_walker,
                control_walker,
            })
        }

        pub(crate) fn tree(&self, view: UiaView, limits: UiaLimits) -> UiTree {
            let walker = self.walker(view);
            collect_tree(
                self.root.clone(),
                walker,
                limits.max_depth,
                limits.max_nodes,
            )
        }

        pub(crate) fn tree_from(&self, root: &UiNode, view: UiaView, limits: UiaLimits) -> UiTree {
            let walker = self.walker(view);
            collect_tree(
                root.element.clone(),
                walker,
                limits.max_depth,
                limits.max_nodes,
            )
        }

        pub(crate) fn semantic_node(&self, node: &UiNode) -> RawSemanticNode {
            node.raw_semantic_node(node.role())
        }

        fn walker(&self, view: UiaView) -> &IUIAutomationTreeWalker {
            match view {
                UiaView::Content => &self.content_walker,
                UiaView::Control => &self.control_walker,
            }
        }
    }

    pub(crate) fn run_on_worker<T, E, F>(hwnd: isize, operation: F) -> Result<T, UiaWorkerError<E>>
    where
        T: Send + 'static,
        E: Send + 'static,
        F: FnOnce(UiaSession) -> Result<T, E> + Send + 'static,
    {
        thread::Builder::new()
            .name("aside-uia-capture".to_string())
            .spawn(move || {
                let session = UiaSession::new(hwnd).map_err(UiaWorkerError::System)?;
                operation(session).map_err(UiaWorkerError::Operation)
            })
            .map_err(|_| UiaWorkerError::System(UiaError::Unavailable))?
            .join()
            .unwrap_or(Err(UiaWorkerError::System(UiaError::Failed)))
    }

    fn collect_tree(
        root: IUIAutomationElement,
        walker: &IUIAutomationTreeWalker,
        max_depth: usize,
        max_nodes: usize,
    ) -> UiTree {
        let mut tree = UiTree::new();
        if collect_element(root, 0, walker, max_depth, max_nodes, &mut tree) {
            tree.node_truncated = true;
        }
        tree
    }

    fn collect_element(
        element: IUIAutomationElement,
        depth: usize,
        walker: &IUIAutomationTreeWalker,
        max_depth: usize,
        max_nodes: usize,
        tree: &mut UiTree,
    ) -> bool {
        if tree.nodes.len() >= max_nodes {
            return true;
        }
        tree.nodes
            .push(read_node(element.clone(), depth, &mut tree.provider_error));

        if depth >= max_depth {
            if unsafe { walker.GetFirstChildElement(&element) }.is_ok() {
                tree.depth_truncated = true;
            }
            return false;
        }

        let mut child = unsafe { walker.GetFirstChildElement(&element) }.ok();
        while let Some(element) = child {
            if collect_element(
                element.clone(),
                depth + 1,
                walker,
                max_depth,
                max_nodes,
                tree,
            ) {
                return true;
            }
            child = unsafe { walker.GetNextSiblingElement(&element) }.ok();
        }
        false
    }

    fn read_node(element: IUIAutomationElement, depth: usize, provider_error: &mut bool) -> UiNode {
        let control_type = match unsafe { element.CurrentControlType() } {
            Ok(value) => Some(value.0),
            Err(_) => {
                *provider_error = true;
                None
            }
        };
        let name = match unsafe { element.CurrentName() } {
            Ok(value) => bstr_to_string(value),
            Err(_) => {
                *provider_error = true;
                None
            }
        };
        let automation_id = unsafe { element.CurrentAutomationId() }
            .ok()
            .and_then(bstr_to_string);
        let selected = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                UIA_SelectionItemPatternId,
            )
        }
        .ok()
        .and_then(|pattern| unsafe { pattern.CurrentIsSelected().ok() })
        .map(|value| value.as_bool());
        let offscreen = unsafe { element.CurrentIsOffscreen() }
            .ok()
            .map(|value| value.as_bool());
        let bounds = unsafe { element.CurrentBoundingRectangle() }
            .ok()
            .and_then(UiRect::from_rect);
        UiNode {
            element,
            depth,
            control_type,
            name,
            automation_id,
            selected,
            offscreen,
            bounds,
        }
    }

    fn bstr_to_string(value: BSTR) -> Option<String> {
        String::try_from(value).ok()
    }

    impl UiRect {
        fn from_rect(rect: RECT) -> Option<Self> {
            Some(Self {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
            })
        }
    }

    fn role_for_control_type(control_type: i32) -> &'static str {
        use ::windows::Win32::UI::Accessibility::*;
        match control_type {
            value if value == UIA_DocumentControlTypeId.0 => "document",
            value if value == UIA_EditControlTypeId.0 => "edit",
            value if value == UIA_TabItemControlTypeId.0 => "tabitem",
            value if value == UIA_ButtonControlTypeId.0 => "button",
            value if value == UIA_CheckBoxControlTypeId.0 => "checkbox",
            value if value == UIA_ComboBoxControlTypeId.0 => "combobox",
            value if value == UIA_DataItemControlTypeId.0 => "dataitem",
            value if value == UIA_GroupControlTypeId.0 => "group",
            value if value == UIA_HeaderControlTypeId.0 => "header",
            value if value == UIA_HyperlinkControlTypeId.0 => "link",
            value if value == UIA_ImageControlTypeId.0 => "image",
            value if value == UIA_ListControlTypeId.0 => "list",
            value if value == UIA_ListItemControlTypeId.0 => "listitem",
            value if value == UIA_MenuItemControlTypeId.0 => "menuitem",
            value if value == UIA_PaneControlTypeId.0 => "pane",
            value if value == UIA_RadioButtonControlTypeId.0 => "radiobutton",
            value if value == UIA_SeparatorControlTypeId.0 => "separator",
            value if value == UIA_StatusBarControlTypeId.0 => "statusbar",
            value if value == UIA_TabControlTypeId.0 => "tab",
            value if value == UIA_TableControlTypeId.0 => "table",
            value if value == UIA_TextControlTypeId.0 => "text",
            value if value == UIA_TitleBarControlTypeId.0 => "titlebar",
            value if value == UIA_ToolBarControlTypeId.0 => "toolbar",
            value if value == UIA_TreeItemControlTypeId.0 => "treeitem",
            value if value == UIA_WindowControlTypeId.0 => "window",
            _ => "unknown",
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use windows::{
    run_on_worker, UiNode, UiaError, UiaLimits, UiaSession, UiaView, UiaWorkerError,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(role: &str, name: &str, depth: usize) -> RawSemanticNode {
        RawSemanticNode {
            role: role.to_string(),
            name: name.to_string(),
            depth,
            offscreen: Some(false),
            bounds: Some(UiRect {
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
            }),
        }
    }

    #[test]
    fn normalizes_names_and_serializes_bounds() {
        let nodes = vec![
            raw("document", " GitHub\n", 0),
            raw("group", "", 1),
            raw("link", "  Open\tissues ", 2),
            raw("link", "  Open\tissues ", 2),
        ];

        let normalized = normalize_semantic(
            &nodes,
            Some(UiRect {
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
            }),
            10,
        );
        assert_eq!(normalized.observed_depth, 2);
        assert_eq!(normalized.nodes.len(), 3);
        assert_eq!(normalized.nodes[0].1, "GitHub");
        assert_eq!(
            normalized.nodes[1].2,
            Some(SemanticBounds {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            })
        );
        assert_eq!(normalized.nodes[2].2, normalized.nodes[1].2);
    }

    #[test]
    fn filters_offscreen_and_out_of_region_nodes() {
        let mut offscreen = raw("text", "Hidden", 1);
        offscreen.offscreen = Some(true);
        let mut outside = raw("text", "Outside", 1);
        outside.bounds = Some(UiRect {
            left: 200,
            top: 200,
            right: 300,
            bottom: 300,
        });
        let nodes = vec![raw("document", "Page", 0), offscreen, outside];
        let normalized = normalize_semantic(
            &nodes,
            Some(UiRect {
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
            }),
            10,
        );
        assert_eq!(normalized.nodes.len(), 1);
    }

    #[test]
    fn filters_nodes_with_invalid_bounds() {
        let mut invalid = raw("text", "Invalid", 1);
        invalid.bounds = Some(UiRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 100,
        });
        let normalized = normalize_semantic(
            &[raw("document", "Page", 0), invalid],
            Some(UiRect {
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
            }),
            10,
        );
        assert_eq!(normalized.nodes.len(), 1);
    }

    #[test]
    fn keeps_fixed_columns_and_reports_node_limit() {
        let nodes = vec![
            raw("document", "Page", 0),
            raw("text", "One", 1),
            raw("text", "Two", 1),
        ];
        let normalized = normalize_semantic(
            &nodes,
            Some(UiRect {
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
            }),
            2,
        );
        assert_eq!(normalized.nodes.len(), 2);
        assert!(normalized.node_truncated);
        assert_eq!(normalized.nodes[0].0, "document");
    }

    #[test]
    fn ignores_invisible_tail_when_reporting_normalized_node_limit() {
        let mut hidden = raw("text", "Hidden", 1);
        hidden.offscreen = Some(true);
        let normalized = normalize_semantic(
            &[raw("document", "Page", 0), raw("text", "One", 1), hidden],
            Some(UiRect {
                left: 0,
                top: 0,
                right: 100,
                bottom: 100,
            }),
            2,
        );
        assert_eq!(normalized.nodes.len(), 2);
        assert!(!normalized.node_truncated);
    }

    #[test]
    fn semantic_page_exposes_only_agent_fields() {
        let page = SemanticPage::new(vec![SemanticNode(
            "button".to_string(),
            "Open issues".to_string(),
            Some(SemanticBounds {
                x: 10,
                y: 20,
                width: 80,
                height: 30,
            }),
        )]);

        let value = serde_json::to_value(page).expect("semantic page should serialize");
        assert_eq!(
            value["fields"],
            serde_json::json!(["role", "name", "bounds"])
        );
        assert_eq!(
            value["nodes"][0],
            serde_json::json!(["button", "Open issues", {
                "x": 10,
                "y": 20,
                "width": 80,
                "height": 30
            }])
        );
        assert!(value["nodes"][0].get("parent").is_none());
        assert!(value["nodes"][0].get("selected").is_none());
    }
}
