//! Chromium host adapter built on the shared UIA transport.

use std::time::Duration;

use serde::Serialize;

use crate::context::{
    AsideContextBlock, ContextSensitivity, ExtractedHostContext, HostCapability,
    HostCaptureErrorCode, HostExtractor, HostKind, HostTargetSnapshot,
};
#[cfg(target_os = "windows")]
use crate::platform::{self, TargetWindow};
use crate::uia::{normalize_name, DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES};
#[cfg(target_os = "windows")]
use crate::uia::{normalize_semantic, SemanticPage, UiRect, UiaView};

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
    fn strategy_id(&self) -> &'static str {
        "browser_chromium_uia"
    }

    fn priority(&self) -> u16 {
        10
    }

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

#[cfg(target_os = "windows")]
fn capture_windows(
    target: &TargetWindow,
    captured_at: u64,
    max_depth: usize,
    max_nodes: usize,
) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
    use crate::uia::{run_on_worker, UiaError, UiaLimits, UiaWorkerError};

    let target = target.clone();
    let limits = UiaLimits {
        max_depth,
        max_nodes,
    };
    run_on_worker(target.native_handle(), move |session| {
        capture_with_session(&target, captured_at, limits, &session)
    })
    .map_err(|error| match error {
        UiaWorkerError::Operation(code) => code,
        UiaWorkerError::System(UiaError::Unavailable) => HostCaptureErrorCode::Unavailable,
        UiaWorkerError::System(UiaError::Failed) => HostCaptureErrorCode::CaptureFailed,
    })
}

#[cfg(target_os = "windows")]
fn capture_with_session(
    target: &TargetWindow,
    captured_at: u64,
    limits: crate::uia::UiaLimits,
    session: &crate::uia::UiaSession,
) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
    let content_tree = session.tree(UiaView::Content, limits);
    let control_tree = session.tree(UiaView::Control, limits);

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
        .and_then(|node| node.name().map(str::to_string));

    let selected_tabs: Vec<String> = control_tree
        .nodes
        .iter()
        .filter(|node| node.role() == "tabitem")
        .filter(|node| node.selected() == Some(true))
        .filter_map(|node| node.name().and_then(normalize_name))
        .collect();
    let tab_name = (selected_tabs.len() == 1).then(|| selected_tabs[0].clone());

    let url_values: Vec<String> = control_tree
        .nodes
        .iter()
        .filter(|node| node.role() == "edit")
        .filter(|node| node.automation_id() == Some("view_1021"))
        .filter_map(read_address_bar_value)
        .collect();
    let url = (url_values.len() == 1).then(|| url_values[0].clone());

    let document_indices: Vec<usize> = content_tree
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.role() == "document")
        .filter(|(_, node)| node.offscreen() != Some(true))
        .filter(|(_, node)| node.bounds().map(UiRect::is_valid).unwrap_or(false))
        .map(|(index, _)| index)
        .collect();

    let document = (document_indices.len() == 1).then(|| &content_tree.nodes[document_indices[0]]);
    let document_title = document
        .and_then(|node| node.name())
        .and_then(normalize_name);
    let title = document_title
        .or_else(|| tab_name.clone())
        .or_else(|| window_title.as_deref().and_then(strip_browser_suffix));

    let mut page_tree_flags = (false, false, false, 0usize, 0usize);
    let semantic_page = document.and_then(|document| {
        let page_tree = session.tree_from(document, UiaView::Content, limits);
        let raw_nodes: Vec<_> = page_tree
            .nodes
            .iter()
            .map(|node| session.semantic_node(node))
            .collect();
        let normalized = normalize_semantic(&raw_nodes, document.bounds(), limits.max_nodes);
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
            limit: limits.max_depth,
            observed: page_tree_flags.3,
            depth_truncated: page_tree_flags.1,
        },
        node_limit: limits.max_nodes,
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
        descriptors: Vec::new(),
    })
}

#[cfg(target_os = "windows")]
fn read_address_bar_value(node: &crate::uia::UiNode) -> Option<String> {
    sanitize_url(&node.current_value()?)
}

#[cfg(test)]
mod tests {
    use super::*;

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
