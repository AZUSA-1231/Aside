//! The bounded UIA fallback for targets without a specialized host strategy.

use std::time::Duration;

use serde::Serialize;

use crate::context::{
    AsideContextBlock, ContextSensitivity, ExtractedHostContext, HostCapability,
    HostCaptureErrorCode, HostExtractor, HostKind, HostTargetSnapshot,
};
#[cfg(target_os = "windows")]
use crate::platform::{self, TargetWindow};
use crate::uia::{
    normalize_name, normalize_semantic, SemanticPage, DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES,
};
#[cfg(target_os = "windows")]
use crate::uia::{run_on_worker, UiRect, UiaError, UiaLimits, UiaView, UiaWorkerError};

const CONTEXT_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug)]
pub(crate) struct GenericUiaExtractor {
    max_depth: usize,
    max_nodes: usize,
}

impl Default for GenericUiaExtractor {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_DEPTH,
            max_nodes: DEFAULT_MAX_NODES,
        }
    }
}

impl HostExtractor for GenericUiaExtractor {
    fn strategy_id(&self) -> &'static str {
        "generic_uia"
    }

    // Generic UIA is selected only after the specialized registry has no match.
    fn priority(&self) -> u16 {
        u16::MAX
    }

    fn kind(&self) -> HostKind {
        HostKind::Generic
    }

    fn matches(&self, target: &HostTargetSnapshot) -> bool {
        target.native_target().is_some() || target.application_id.is_some()
    }

    fn capabilities(&self, _: &HostTargetSnapshot) -> Vec<HostCapability> {
        vec![
            HostCapability::CaptureContext,
            HostCapability::GenericUiaSemanticCapture,
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
#[serde(rename_all = "snake_case")]
struct GenericQuality {
    quality: &'static str,
    view: &'static str,
    depth_limit: usize,
    observed_depth: usize,
    depth_truncated: bool,
    node_limit: usize,
    node_count: usize,
    node_truncated: bool,
}

fn quality(provider_error: bool, depth_truncated: bool, node_truncated: bool) -> &'static str {
    if provider_error || depth_truncated || node_truncated {
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
    let target = target.clone();
    let limits = UiaLimits {
        max_depth,
        max_nodes,
    };
    run_on_worker(target.native_handle(), move |session| {
        let tree = session.tree(UiaView::Content, limits);
        if !platform::target_is_captureable(&target) {
            return Err(HostCaptureErrorCode::StaleTarget);
        }

        let raw_nodes: Vec<_> = tree
            .nodes
            .iter()
            .map(|node| session.semantic_node(node))
            .collect();
        let root_bounds = Some(UiRect {
            left: target.bounds.x,
            top: target.bounds.y,
            right: target.bounds.right(),
            bottom: target.bounds.bottom(),
        });
        let normalized = normalize_semantic(&raw_nodes, root_bounds, max_nodes);
        if normalized.nodes.is_empty() {
            return Err(HostCaptureErrorCode::Unavailable);
        }

        let node_truncated = tree.node_truncated || normalized.node_truncated;
        let capture_quality = quality(tree.provider_error, tree.depth_truncated, node_truncated);
        let metadata = GenericQuality {
            quality: capture_quality,
            view: "content",
            depth_limit: max_depth,
            observed_depth: normalized.observed_depth,
            depth_truncated: tree.depth_truncated,
            node_limit: max_nodes,
            node_count: normalized.nodes.len(),
            node_truncated,
        };
        let source = target
            .application_id
            .as_deref()
            .and_then(normalize_name)
            .unwrap_or_else(|| "Generic UIA".to_string());
        let summary = format!(
            "{} | {} semantic nodes | {}",
            source,
            normalized.nodes.len(),
            capture_quality
        );
        Ok(ExtractedHostContext {
            source,
            summary,
            captured_at,
            expires_at: captured_at.saturating_add(CONTEXT_TTL.as_millis() as u64),
            sensitivity: ContextSensitivity::LocalContent,
            blocks: vec![
                AsideContextBlock::Json {
                    label: Some("generic.semantic_page".to_string()),
                    data: serde_json::to_value(SemanticPage::new(normalized.nodes))
                        .map_err(|_| HostCaptureErrorCode::Malformed)?,
                },
                AsideContextBlock::Json {
                    label: Some("generic.quality".to_string()),
                    data: serde_json::to_value(metadata)
                        .map_err(|_| HostCaptureErrorCode::Malformed)?,
                },
            ],
            descriptors: Vec::new(),
        })
    })
    .map_err(|error| match error {
        UiaWorkerError::Operation(code) => code,
        UiaWorkerError::System(UiaError::Unavailable) => HostCaptureErrorCode::Unavailable,
        UiaWorkerError::System(UiaError::Failed) => HostCaptureErrorCode::CaptureFailed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_partial_quality_for_any_bounded_limit_or_provider_issue() {
        assert_eq!(quality(false, false, false), "complete");
        assert_eq!(quality(true, false, false), "partial");
        assert_eq!(quality(false, true, false), "partial");
        assert_eq!(quality(false, false, true), "partial");
    }

    #[test]
    fn generic_strategy_is_not_a_specialized_priority_candidate() {
        let strategy = GenericUiaExtractor::default();
        assert_eq!(strategy.priority(), u16::MAX);
        assert_eq!(strategy.kind(), HostKind::Generic);
        assert!(strategy.matches(&HostTargetSnapshot::synthetic("target", Some("chat.exe"),)));
    }
}
