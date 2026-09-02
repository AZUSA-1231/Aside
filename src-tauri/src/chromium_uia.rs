use std::time::Duration;

use serde::Serialize;

use crate::context::{
    AsideContextBlock, ContextSensitivity, ExtractedHostContext, HostCapability,
    HostCaptureErrorCode, HostExtractor, HostKind, HostTargetSnapshot,
};
use crate::platform::{self, TargetWindow};

pub(crate) const DEFAULT_MAX_DEPTH: usize = 16;
pub(crate) const DEFAULT_MAX_NODES: usize = 800;
const MAX_NODE_NAME_BYTES: usize = 1_024;
const CONTEXT_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug)]
pub(crate) struct ChromiumUiaExtractor {
    max_depth: usize,
    max_nodes: usize,
}

impl Default for ChromiumUiaExtractor {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_DEPTH,
            max_nodes: DEFAULT_MAX_NODES,
        }
    }
}

impl HostExtractor for ChromiumUiaExtractor {
    fn kind(&self) -> HostKind {
        HostKind::Browser
    }

    fn matches(&self, target: &HostTargetSnapshot) -> bool {
        target
            .application_id
            .as_deref()
            .map(is_chromium_application)
            .unwrap_or(false)
    }

    fn capabilities(&self, _: &HostTargetSnapshot) -> Vec<HostCapability> {
        vec![
            HostCapability::CaptureContext,
            HostCapability::ChromiumUiaSemanticCapture,
            HostCapability::BrowserUrlTitle,
        ]
    }

    fn capture(
        &self,
        request: &crate::context::HostCaptureRequest,
    ) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
        #[cfg(target_os = "windows")]
        {
            let target = request
                .target
                .native_target()
                .ok_or(HostCaptureErrorCode::Unavailable)?;
            if !platform::target_is_captureable(target) {
                return Err(HostCaptureErrorCode::StaleTarget);
            }
            capture_windows(target, request.captured_at, self.max_depth, self.max_nodes)
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = request;
            Err(HostCaptureErrorCode::Unavailable)
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserMetadata {
    application: String,
    pid: u32,
    tab_name: Option<String>,
    url: Option<String>,
    title: Option<String>,
    quality: String,
    view: &'static str,
    depth: DepthMetadata,
    node_limit: usize,
    node_count: usize,
    node_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DepthMetadata {
    limit: usize,
    observed: usize,
    depth_truncated: bool,
}

#[derive(Debug, Serialize)]
struct SemanticPage {
    fields: [&'static str; 3],
    nodes: Vec<SemanticNode>,
}

#[derive(Debug, Serialize)]
struct SemanticNode(String, String, Option<SemanticBounds>);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
struct SemanticBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl SemanticPage {
    fn new(nodes: Vec<SemanticNode>) -> Self {
        Self {
            fields: ["role", "name", "bounds"],
            nodes,
        }
    }
}

fn is_chromium_application(application_id: &str) -> bool {
    matches!(
        application_id.to_ascii_lowercase().as_str(),
        "chrome.exe" | "msedge.exe"
    )
}

fn application_name(application_id: &str) -> &'static str {
    match application_id.to_ascii_lowercase().as_str() {
        "chrome.exe" => "Google Chrome",
        "msedge.exe" => "Microsoft Edge",
        _ => "Chromium browser",
    }
}

fn normalize_name(value: &str) -> Option<String> {
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

fn sanitize_url(value: &str) -> Option<String> {
    let mut parsed = url::Url::parse(value.trim()).ok()?;
    if parsed.scheme().is_empty() {
        return None;
    }
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string())
}

fn strip_browser_suffix(value: &str) -> Option<String> {
    let normalized = normalize_name(value)?;
    let lower = normalized.to_ascii_lowercase();
    for suffix in [" - microsoft edge", " - google chrome"] {
        if lower.ends_with(suffix) {
            let end = normalized.len().saturating_sub(suffix.len());
            return normalize_name(&normalized[..end]);
        }
    }
    Some(normalized)
}

fn quality(
    has_page: bool,
    metadata_complete: bool,
    provider_error: bool,
    depth_truncated: bool,
    node_truncated: bool,
) -> &'static str {
    if !has_page {
        "metadata_only"
    } else if !metadata_complete || provider_error || depth_truncated || node_truncated {
        "partial"
    } else {
        "complete"
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UiRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl UiRect {
    fn is_valid(self) -> bool {
        self.right > self.left && self.bottom > self.top
    }

    fn intersects(self, other: Self) -> bool {
        self.left < other.right
            && other.left < self.right
            && self.top < other.bottom
            && other.top < self.bottom
    }
}

#[derive(Clone, Debug)]
struct RawSemanticNode {
    role: String,
    name: String,
    depth: usize,
    offscreen: Option<bool>,
    bounds: Option<UiRect>,
}

struct NormalizedSemantic {
    nodes: Vec<SemanticNode>,
    observed_depth: usize,
    node_truncated: bool,
}

fn normalize_semantic(
    raw_nodes: &[RawSemanticNode],
    root_bounds: Option<UiRect>,
    max_nodes: usize,
) -> NormalizedSemantic {
    let mut nodes = Vec::new();
    let mut observed_depth = 0;
    let mut node_truncated = false;

    for (index, raw) in raw_nodes.iter().enumerate() {
        let visible = raw.offscreen != Some(true)
            && raw
                .bounds
                .map(|bounds| {
                    bounds.is_valid()
                        && root_bounds
                            .map(|root| root.is_valid() && root.intersects(bounds))
                            .unwrap_or(true)
                })
                .unwrap_or(true);
        let name = normalize_name(&raw.name);
        let is_root = index == 0;

        if !visible || (!is_root && name.is_none()) {
            continue;
        }
        if nodes.len() >= max_nodes {
            node_truncated = raw_nodes[index..].iter().any(|candidate| {
                candidate.offscreen != Some(true) && normalize_name(&candidate.name).is_some()
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

fn semantic_bounds(bounds: UiRect) -> SemanticBounds {
    SemanticBounds {
        x: bounds.left,
        y: bounds.top,
        width: bounds.right.saturating_sub(bounds.left),
        height: bounds.bottom.saturating_sub(bounds.top),
    }
}

#[cfg(target_os = "windows")]
mod windows_capture {
    use super::*;
    use windows::core::{Interface, BSTR};
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomation2, IUIAutomationElement,
        IUIAutomationSelectionItemPattern, IUIAutomationTreeWalker, IUIAutomationValuePattern,
        UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_SelectionItemPatternId,
        UIA_TabItemControlTypeId, UIA_ValuePatternId,
    };

    struct ComGuard;

    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    #[derive(Clone)]
    struct UiNode {
        element: IUIAutomationElement,
        depth: usize,
        control_type: Option<i32>,
        name: Option<String>,
        automation_id: Option<String>,
        selected: Option<bool>,
        offscreen: Option<bool>,
        bounds: Option<UiRect>,
    }

    struct UiTree {
        nodes: Vec<UiNode>,
        provider_error: bool,
        depth_truncated: bool,
        node_truncated: bool,
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

    pub(super) fn capture_windows(
        target: &TargetWindow,
        captured_at: u64,
        max_depth: usize,
        max_nodes: usize,
    ) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
        let target = target.clone();
        std::thread::Builder::new()
            .name("aside-chromium-uia".to_string())
            .spawn(move || capture_windows_on_worker(&target, captured_at, max_depth, max_nodes))
            .map_err(|_| HostCaptureErrorCode::Unavailable)?
            .join()
            .unwrap_or(Err(HostCaptureErrorCode::CaptureFailed))
    }

    fn capture_windows_on_worker(
        target: &TargetWindow,
        captured_at: u64,
        max_depth: usize,
        max_nodes: usize,
    ) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
        let initialize_result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if initialize_result.is_err() {
            return Err(HostCaptureErrorCode::Unavailable);
        }
        let _com = ComGuard;

        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
                .map_err(|_| HostCaptureErrorCode::Unavailable)?;
        if let Ok(automation2) = automation.cast::<IUIAutomation2>() {
            let _ = unsafe { automation2.SetConnectionTimeout(750) };
        }

        let hwnd = HWND(target.native_handle() as *mut core::ffi::c_void);
        let root = unsafe { automation.ElementFromHandle(hwnd) }
            .map_err(|_| HostCaptureErrorCode::CaptureFailed)?;
        let content_walker = unsafe { automation.ContentViewWalker() }
            .map_err(|_| HostCaptureErrorCode::CaptureFailed)?;
        let content_tree = collect_tree(&root, &content_walker, max_depth, max_nodes);

        let control_walker = unsafe { automation.ControlViewWalker() }
            .map_err(|_| HostCaptureErrorCode::CaptureFailed)?;
        let control_tree = collect_tree(&root, &control_walker, max_depth, max_nodes);

        if !platform::target_is_captureable(target) {
            return Err(HostCaptureErrorCode::StaleTarget);
        }

        let application_id = target
            .application_id
            .as_deref()
            .ok_or(HostCaptureErrorCode::Unavailable)?;
        let application = application_name(application_id).to_string();
        let window_title = content_tree
            .nodes
            .first()
            .and_then(|node| node.name.clone());

        let selected_tabs: Vec<String> = control_tree
            .nodes
            .iter()
            .filter(|node| node.control_type == Some(UIA_TabItemControlTypeId.0))
            .filter(|node| node.selected == Some(true))
            .filter_map(|node| node.name.as_deref().and_then(normalize_name))
            .collect();
        let tab_name = (selected_tabs.len() == 1).then(|| selected_tabs[0].clone());

        let url_values: Vec<String> = control_tree
            .nodes
            .iter()
            .filter(|node| node.control_type == Some(UIA_EditControlTypeId.0))
            .filter(|node| node.automation_id.as_deref() == Some("view_1021"))
            .filter_map(read_address_bar_value)
            .collect();
        let url = (url_values.len() == 1).then(|| url_values[0].clone());

        let document_indices: Vec<usize> = content_tree
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| node.control_type == Some(UIA_DocumentControlTypeId.0))
            .filter(|(_, node)| node.offscreen != Some(true))
            .filter(|(_, node)| node.bounds.map(UiRect::is_valid).unwrap_or(false))
            .map(|(index, _)| index)
            .collect();

        let document =
            (document_indices.len() == 1).then(|| &content_tree.nodes[document_indices[0]]);
        let document_title = document
            .and_then(|node| node.name.as_deref())
            .and_then(normalize_name);
        let title = document_title
            .or_else(|| tab_name.clone())
            .or_else(|| window_title.as_deref().and_then(strip_browser_suffix));

        let mut page_tree_flags = (false, false, false, 0usize, 0usize);
        let semantic_page = document.and_then(|document| {
            let page_tree = collect_tree(&document.element, &content_walker, max_depth, max_nodes);
            let raw_nodes: Vec<RawSemanticNode> = page_tree
                .nodes
                .iter()
                .map(|node| RawSemanticNode {
                    role: node
                        .control_type
                        .map(role_for_control_type)
                        .unwrap_or("unknown")
                        .to_string(),
                    name: node.name.clone().unwrap_or_default(),
                    depth: node.depth,
                    offscreen: node.offscreen,
                    bounds: node.bounds,
                })
                .collect();
            let normalized = normalize_semantic(&raw_nodes, document.bounds, max_nodes);
            page_tree_flags = (
                page_tree.provider_error,
                page_tree.depth_truncated,
                page_tree.node_truncated || normalized.node_truncated,
                normalized.observed_depth,
                normalized.nodes.len(),
            );
            (!normalized.nodes.is_empty()).then(|| SemanticPage::new(normalized.nodes))
        });

        let metadata_complete = tab_name.is_some() && url.is_some() && title.is_some();
        let capture_quality = quality(
            semantic_page.is_some(),
            metadata_complete,
            page_tree_flags.0 || content_tree.provider_error || control_tree.provider_error,
            page_tree_flags.1,
            page_tree_flags.2,
        );
        let metadata = BrowserMetadata {
            application: application.clone(),
            pid: target.native_process_id(),
            tab_name,
            url,
            title: title.clone(),
            quality: capture_quality.to_string(),
            view: "content",
            depth: DepthMetadata {
                limit: max_depth,
                observed: page_tree_flags.3,
                depth_truncated: page_tree_flags.1,
            },
            node_limit: max_nodes,
            node_count: page_tree_flags.4,
            node_truncated: page_tree_flags.2,
        };

        let mut blocks = vec![AsideContextBlock::Json {
            label: Some("browser.metadata".to_string()),
            data: serde_json::to_value(metadata).map_err(|_| HostCaptureErrorCode::Malformed)?,
        }];
        if let Some(page) = semantic_page {
            blocks.push(AsideContextBlock::Json {
                label: Some("browser.semantic_page".to_string()),
                data: serde_json::to_value(page).map_err(|_| HostCaptureErrorCode::Malformed)?,
            });
        }

        let quality_summary = capture_quality.replace('_', " ");
        let summary = format!(
            "{} | {} semantic nodes | {}",
            title.as_deref().unwrap_or(&application),
            page_tree_flags.4,
            quality_summary,
        );
        Ok(ExtractedHostContext {
            source: application,
            summary,
            captured_at,
            expires_at: captured_at.saturating_add(CONTEXT_TTL.as_millis() as u64),
            sensitivity: ContextSensitivity::LocalContent,
            blocks,
        })
    }

    fn collect_tree(
        root: &IUIAutomationElement,
        walker: &IUIAutomationTreeWalker,
        max_depth: usize,
        max_nodes: usize,
    ) -> UiTree {
        let mut tree = UiTree::new();
        collect_element(root.clone(), 0, walker, max_depth, max_nodes, &mut tree);
        tree
    }

    fn collect_element(
        element: IUIAutomationElement,
        depth: usize,
        walker: &IUIAutomationTreeWalker,
        max_depth: usize,
        max_nodes: usize,
        tree: &mut UiTree,
    ) {
        if tree.nodes.len() >= max_nodes {
            tree.node_truncated = true;
            return;
        }
        tree.nodes
            .push(read_node(element.clone(), depth, &mut tree.provider_error));

        if depth >= max_depth {
            if unsafe { walker.GetFirstChildElement(&element) }.is_ok() {
                tree.depth_truncated = true;
            }
            return;
        }

        let mut child = unsafe { walker.GetFirstChildElement(&element) }.ok();
        while let Some(element) = child {
            if tree.nodes.len() >= max_nodes {
                tree.node_truncated = true;
                return;
            }
            collect_element(
                element.clone(),
                depth + 1,
                walker,
                max_depth,
                max_nodes,
                tree,
            );
            if tree.nodes.len() >= max_nodes {
                tree.node_truncated = true;
                return;
            }
            child = unsafe { walker.GetNextSiblingElement(&element) }.ok();
        }
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
        .map(|value| value.as_bool())
        .filter(|value| *value);
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

    fn read_address_bar_value(node: &UiNode) -> Option<String> {
        let pattern = unsafe {
            node.element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        }
        .ok()?;
        let value = unsafe { pattern.CurrentValue() }.ok()?;
        sanitize_url(&bstr_to_string(value)?)
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
        use windows::Win32::UI::Accessibility::*;
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
use windows_capture::capture_windows;

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

    #[test]
    fn sanitizes_url_without_credentials_query_or_fragment() {
        assert_eq!(
            sanitize_url("https://user:secret@example.com/a?token=x#part").as_deref(),
            Some("https://example.com/a")
        );
        assert!(sanitize_url("not a url").is_none());
    }

    #[test]
    fn derives_quality_from_page_and_capture_limits() {
        assert_eq!(quality(false, true, false, false, false), "metadata_only");
        assert_eq!(quality(true, true, false, false, false), "complete");
        assert_eq!(quality(true, true, false, true, false), "partial");
        assert_eq!(quality(true, false, false, false, false), "partial");
    }
}
