use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::platform::{self, TargetWindow};

pub const MAX_CONTEXT_BLOCKS: usize = 8;
pub const MAX_CONTEXT_TEXT_BYTES: usize = 8 * 1024;
pub const MAX_CONTEXT_JSON_BYTES: usize = 16 * 1024;
pub const MAX_CONTEXT_TOTAL_BYTES: usize = 24 * 1024;
pub const MAX_CONTEXT_JSON_DEPTH: usize = 4;
pub const MAX_CONTEXT_ID_LENGTH: usize = 128;
pub const MAX_CONTEXT_SOURCE_LENGTH: usize = 160;
pub const MAX_CONTEXT_SUMMARY_LENGTH: usize = 240;

static NEXT_CAPTURE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKind {
    Browser,
    Explorer,
    #[serde(rename = "vscode")]
    VsCode,
    #[serde(rename = "pdf_reader")]
    PdfReader,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostAvailability {
    Available,
    Unsupported,
    Ambiguous,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostCapability {
    Identify,
    CaptureContext,
    ChromiumUiaSemanticCapture,
    BrowserUrlTitle,
    ExplorerMetadata,
    VscodeWorkspace,
    PdfDocument,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSensitivity {
    Public,
    LocalMetadata,
    LocalContent,
    Restricted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostCaptureErrorCode {
    NoForegroundTarget,
    AmbiguousTarget,
    UnsupportedCapability,
    PermissionDenied,
    Unavailable,
    Timeout,
    Cancelled,
    Malformed,
    Oversized,
    Expired,
    StaleTarget,
    CaptureFailed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AsideFlow {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AsideContextBlock {
    Text {
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        text: String,
    },
    Json {
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        data: serde_json::Value,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsideHostAttachment {
    pub id: String,
    pub host: HostKind,
    pub source: String,
    pub captured_at: u64,
    pub expires_at: u64,
    pub sensitivity: ContextSensitivity,
    pub summary: String,
    pub blocks: Vec<AsideContextBlock>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AsideTurnContext {
    pub flow: AsideFlow,
    pub blocks: Vec<AsideContextBlock>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AsideHostAttachment>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub target_id: Option<String>,
    pub application_id: Option<String>,
    pub kind: HostKind,
    pub availability: HostAvailability,
    pub capabilities: Vec<HostCapability>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCaptureError {
    pub code: HostCaptureErrorCode,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCaptureResult {
    pub capture_id: String,
    pub host: HostView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment: Option<AsideHostAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<HostCaptureError>,
}

#[derive(Clone, Debug)]
pub struct HostTargetSnapshot {
    pub target_id: String,
    pub application_id: Option<String>,
    native_target: Option<TargetWindow>,
}

impl HostTargetSnapshot {
    pub fn from_target(target: TargetWindow) -> Self {
        Self {
            target_id: target.opaque_id.clone(),
            application_id: target.application_id.clone(),
            native_target: Some(target),
        }
    }

    #[cfg(test)]
    fn synthetic(target_id: &str, application_id: Option<&str>) -> Self {
        Self {
            target_id: target_id.to_string(),
            application_id: application_id.map(str::to_string),
            native_target: None,
        }
    }

    fn is_current(&self) -> bool {
        self.native_target
            .as_ref()
            .map(platform::target_is_current)
            .unwrap_or(true)
    }

    pub(crate) fn native_target(&self) -> Option<&TargetWindow> {
        self.native_target.as_ref()
    }
}

#[derive(Clone, Debug)]
pub struct HostCaptureRequest {
    pub capture_id: String,
    pub target: HostTargetSnapshot,
    pub captured_at: u64,
}

#[derive(Clone, Debug)]
pub struct ExtractedHostContext {
    pub source: String,
    pub summary: String,
    pub captured_at: u64,
    pub expires_at: u64,
    pub sensitivity: ContextSensitivity,
    pub blocks: Vec<AsideContextBlock>,
}

pub trait HostExtractor: Send + Sync {
    fn kind(&self) -> HostKind;
    fn matches(&self, target: &HostTargetSnapshot) -> bool;
    fn capabilities(&self, target: &HostTargetSnapshot) -> Vec<HostCapability>;
    fn capture(
        &self,
        request: &HostCaptureRequest,
    ) -> Result<ExtractedHostContext, HostCaptureErrorCode>;
}

pub struct HostExtractorRegistry {
    extractors: Vec<Box<dyn HostExtractor>>,
}

impl HostExtractorRegistry {
    pub fn new(extractors: Vec<Box<dyn HostExtractor>>) -> Self {
        Self { extractors }
    }

    pub fn production() -> Self {
        Self::new(vec![Box::new(
            crate::chromium_uia::ChromiumUiaExtractor::default(),
        )])
    }

    fn matching<'a>(&'a self, target: &HostTargetSnapshot) -> Vec<&'a dyn HostExtractor> {
        self.extractors
            .iter()
            .filter(|extractor| extractor.matches(target))
            .map(|extractor| extractor.as_ref())
            .collect()
    }

    pub fn classify(&self, target: &HostTargetSnapshot) -> HostView {
        let matches = self.matching(target);
        if matches.len() > 1 {
            return HostView {
                target_id: Some(target.target_id.clone()),
                application_id: target.application_id.clone(),
                kind: HostKind::Unsupported,
                availability: HostAvailability::Ambiguous,
                capabilities: Vec::new(),
            };
        }

        let Some(extractor) = matches.first() else {
            return HostView {
                target_id: Some(target.target_id.clone()),
                application_id: target.application_id.clone(),
                kind: HostKind::Unsupported,
                availability: HostAvailability::Unsupported,
                capabilities: Vec::new(),
            };
        };

        let mut capabilities = extractor.capabilities(target);
        if !capabilities.contains(&HostCapability::Identify) {
            capabilities.insert(0, HostCapability::Identify);
        }
        HostView {
            target_id: Some(target.target_id.clone()),
            application_id: target.application_id.clone(),
            kind: extractor.kind(),
            availability: HostAvailability::Available,
            capabilities,
        }
    }

    pub fn capture(&self, request: HostCaptureRequest) -> HostCaptureResult {
        let matches = self.matching(&request.target);
        let host = self.classify(&request.target);

        if !request.target.is_current() {
            return failed_result(request.capture_id, host, HostCaptureErrorCode::StaleTarget);
        }
        if matches.len() > 1 {
            return failed_result(
                request.capture_id,
                host,
                HostCaptureErrorCode::AmbiguousTarget,
            );
        }
        let Some(extractor) = matches.first() else {
            return HostCaptureResult {
                capture_id: request.capture_id,
                host,
                attachment: None,
                error: None,
            };
        };

        let capabilities = extractor.capabilities(&request.target);
        if !capabilities.contains(&HostCapability::CaptureContext) {
            return failed_result(
                request.capture_id,
                host,
                HostCaptureErrorCode::UnsupportedCapability,
            );
        }

        let extracted = match extractor.capture(&request) {
            Ok(extracted) => extracted,
            Err(code) => return failed_result(request.capture_id, host, code),
        };
        let attachment = match normalize_attachment(&request, extractor.kind(), extracted) {
            Ok(attachment) => attachment,
            Err(code) => return failed_result(request.capture_id, host, code),
        };
        HostCaptureResult {
            capture_id: request.capture_id,
            host,
            attachment: Some(attachment),
            error: None,
        }
    }
}

pub fn classify_foreground_host() -> HostView {
    let registry = HostExtractorRegistry::production();
    match platform::foreground_target() {
        Some(target) => registry.classify(&HostTargetSnapshot::from_target(target)),
        None => HostView {
            target_id: None,
            application_id: None,
            kind: HostKind::Unsupported,
            availability: HostAvailability::Unavailable,
            capabilities: Vec::new(),
        },
    }
}

pub fn capture_foreground_context() -> HostCaptureResult {
    match snapshot_foreground_target() {
        Some(target) => capture_target_context(target),
        None => failed_result(
            next_capture_id(),
            unavailable_host_view(),
            HostCaptureErrorCode::NoForegroundTarget,
        ),
    }
}

pub fn snapshot_foreground_target() -> Option<HostTargetSnapshot> {
    platform::foreground_target().map(HostTargetSnapshot::from_target)
}

pub fn capture_target_context(target: HostTargetSnapshot) -> HostCaptureResult {
    let capture_id = next_capture_id();
    let registry = HostExtractorRegistry::production();
    registry.capture(HostCaptureRequest {
        capture_id,
        target,
        captured_at: now_millis(),
    })
}

fn unavailable_host_view() -> HostView {
    HostView {
        target_id: None,
        application_id: None,
        kind: HostKind::Unsupported,
        availability: HostAvailability::Unavailable,
        capabilities: Vec::new(),
    }
}

fn next_capture_id() -> String {
    format!(
        "capture-{}-{}",
        now_millis(),
        NEXT_CAPTURE_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn failed_result(
    capture_id: String,
    host: HostView,
    code: HostCaptureErrorCode,
) -> HostCaptureResult {
    HostCaptureResult {
        capture_id,
        host,
        attachment: None,
        error: Some(sanitized_error(code)),
    }
}

fn sanitized_error(code: HostCaptureErrorCode) -> HostCaptureError {
    let (message, recoverable) = match code {
        HostCaptureErrorCode::NoForegroundTarget => {
            ("No foreground host target was available.", true)
        }
        HostCaptureErrorCode::AmbiguousTarget => {
            ("The host could not be identified unambiguously.", true)
        }
        HostCaptureErrorCode::UnsupportedCapability => (
            "This host does not provide a supported context capture.",
            true,
        ),
        HostCaptureErrorCode::PermissionDenied => {
            ("Host context permission was not granted.", true)
        }
        HostCaptureErrorCode::Unavailable => ("The host context integration is unavailable.", true),
        HostCaptureErrorCode::Timeout => ("Host context capture timed out.", true),
        HostCaptureErrorCode::Cancelled => ("Host context capture was cancelled.", true),
        HostCaptureErrorCode::Malformed => ("The host returned invalid context.", true),
        HostCaptureErrorCode::Oversized => ("The host context is too large to attach.", true),
        HostCaptureErrorCode::Expired => ("The host context expired before it was attached.", true),
        HostCaptureErrorCode::StaleTarget => (
            "The original host changed before context capture completed.",
            true,
        ),
        HostCaptureErrorCode::CaptureFailed => ("Host context capture failed.", true),
    };
    HostCaptureError {
        code,
        message: message.to_string(),
        recoverable,
    }
}

fn normalize_attachment(
    request: &HostCaptureRequest,
    host: HostKind,
    extracted: ExtractedHostContext,
) -> Result<AsideHostAttachment, HostCaptureErrorCode> {
    if request.capture_id.is_empty()
        || request.capture_id.len() > MAX_CONTEXT_ID_LENGTH
        || !request
            .capture_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".:_-".contains(character))
    {
        return Err(HostCaptureErrorCode::Malformed);
    }
    if extracted.captured_at != request.captured_at || extracted.expires_at <= extracted.captured_at
    {
        return Err(HostCaptureErrorCode::Malformed);
    }
    if extracted.expires_at <= now_millis() {
        return Err(HostCaptureErrorCode::Expired);
    }
    validate_safe_text(&extracted.source, MAX_CONTEXT_SOURCE_LENGTH)
        .map_err(|_| HostCaptureErrorCode::Malformed)?;
    validate_safe_text(&extracted.summary, MAX_CONTEXT_SUMMARY_LENGTH)
        .map_err(|_| HostCaptureErrorCode::Malformed)?;
    validate_blocks(&extracted.blocks)?;
    let attachment = AsideHostAttachment {
        id: request.capture_id.clone(),
        host,
        source: extracted.source,
        captured_at: extracted.captured_at,
        expires_at: extracted.expires_at,
        sensitivity: extracted.sensitivity,
        summary: extracted.summary,
        blocks: extracted.blocks,
    };
    let serialized =
        serde_json::to_vec(&attachment).map_err(|_| HostCaptureErrorCode::Malformed)?;
    if serialized.len() > MAX_CONTEXT_TOTAL_BYTES {
        return Err(HostCaptureErrorCode::Oversized);
    }
    Ok(attachment)
}

fn validate_blocks(blocks: &[AsideContextBlock]) -> Result<(), HostCaptureErrorCode> {
    if blocks.is_empty() || blocks.len() > MAX_CONTEXT_BLOCKS {
        return Err(HostCaptureErrorCode::Oversized);
    }
    for block in blocks {
        match block {
            AsideContextBlock::Text { label, text } => {
                if let Some(label) = label {
                    validate_safe_text(label, MAX_CONTEXT_SUMMARY_LENGTH)
                        .map_err(|_| HostCaptureErrorCode::Malformed)?;
                }
                if text.len() > MAX_CONTEXT_TEXT_BYTES {
                    return Err(HostCaptureErrorCode::Oversized);
                }
            }
            AsideContextBlock::Json { label, data } => {
                if let Some(label) = label {
                    validate_safe_text(label, MAX_CONTEXT_SUMMARY_LENGTH)
                        .map_err(|_| HostCaptureErrorCode::Malformed)?;
                }
                let serialized =
                    serde_json::to_vec(data).map_err(|_| HostCaptureErrorCode::Malformed)?;
                if serialized.len() > MAX_CONTEXT_JSON_BYTES {
                    return Err(HostCaptureErrorCode::Oversized);
                }
                if json_depth(data, 0) > MAX_CONTEXT_JSON_DEPTH {
                    return Err(HostCaptureErrorCode::Oversized);
                }
            }
        }
    }
    Ok(())
}

fn validate_safe_text(value: &str, max_bytes: usize) -> Result<(), ()> {
    if value.len() > max_bytes || value.chars().any(|character| character.is_control()) {
        return Err(());
    }
    Ok(())
}

fn json_depth(value: &serde_json::Value, depth: usize) -> usize {
    match value {
        serde_json::Value::Array(values) => values
            .iter()
            .map(|value| json_depth(value, depth + 1))
            .max()
            .unwrap_or(depth),
        serde_json::Value::Object(values) => values
            .values()
            .map(|value| json_depth(value, depth + 1))
            .max()
            .unwrap_or(depth),
        _ => depth,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct FauxExtractor {
        application_id: &'static str,
        kind: HostKind,
        capabilities: Vec<HostCapability>,
        outcome: Result<ExtractedHostContext, HostCaptureErrorCode>,
    }

    impl HostExtractor for FauxExtractor {
        fn kind(&self) -> HostKind {
            self.kind
        }

        fn matches(&self, target: &HostTargetSnapshot) -> bool {
            target.application_id.as_deref() == Some(self.application_id)
        }

        fn capabilities(&self, _: &HostTargetSnapshot) -> Vec<HostCapability> {
            self.capabilities.clone()
        }

        fn capture(
            &self,
            request: &HostCaptureRequest,
        ) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
            self.outcome.clone().map(|mut context| {
                context.captured_at = request.captured_at;
                context
            })
        }
    }

    fn request(application_id: Option<&str>) -> HostCaptureRequest {
        HostCaptureRequest {
            capture_id: "capture-test-1".to_string(),
            target: HostTargetSnapshot::synthetic("target-test-1", application_id),
            captured_at: now_millis(),
        }
    }

    fn successful_context() -> ExtractedHostContext {
        let captured_at = now_millis();
        ExtractedHostContext {
            source: "Faux Browser".to_string(),
            summary: "A bounded browser page".to_string(),
            captured_at,
            expires_at: captured_at + 60_000,
            sensitivity: ContextSensitivity::LocalContent,
            blocks: vec![AsideContextBlock::Json {
                label: Some("page".to_string()),
                data: json!({"title": "Example", "url": "https://example.test"}),
            }],
        }
    }

    #[test]
    fn classifies_one_matching_extractor_and_rejects_ambiguity() {
        let first = FauxExtractor {
            application_id: "browser.exe",
            kind: HostKind::Browser,
            capabilities: vec![HostCapability::CaptureContext],
            outcome: Ok(successful_context()),
        };
        let registry = HostExtractorRegistry::new(vec![Box::new(first)]);
        let view = registry.classify(&HostTargetSnapshot::synthetic(
            "target-1",
            Some("browser.exe"),
        ));
        assert_eq!(view.kind, HostKind::Browser);
        assert_eq!(view.availability, HostAvailability::Available);
        assert!(view.capabilities.contains(&HostCapability::Identify));

        let ambiguous = HostExtractorRegistry::new(vec![
            Box::new(FauxExtractor {
                application_id: "browser.exe",
                kind: HostKind::Browser,
                capabilities: vec![HostCapability::CaptureContext],
                outcome: Ok(successful_context()),
            }),
            Box::new(FauxExtractor {
                application_id: "browser.exe",
                kind: HostKind::Browser,
                capabilities: vec![HostCapability::CaptureContext],
                outcome: Ok(successful_context()),
            }),
        ]);
        let result = ambiguous.capture(request(Some("browser.exe")));
        assert!(result.attachment.is_none());
        assert_eq!(
            result.error.as_ref().map(|error| error.code),
            Some(HostCaptureErrorCode::AmbiguousTarget)
        );
    }

    #[test]
    fn captures_one_bounded_attachment_and_strips_adapter_errors() {
        let extractor = FauxExtractor {
            application_id: "browser.exe",
            kind: HostKind::Browser,
            capabilities: vec![
                HostCapability::CaptureContext,
                HostCapability::BrowserUrlTitle,
            ],
            outcome: Ok(successful_context()),
        };
        let registry = HostExtractorRegistry::new(vec![Box::new(extractor)]);
        let result = registry.capture(request(Some("browser.exe")));
        let attachment = result.attachment.expect("attachment");
        assert_eq!(attachment.id, "capture-test-1");
        assert_eq!(attachment.host, HostKind::Browser);
        assert_eq!(attachment.blocks.len(), 1);

        let failed = HostExtractorRegistry::new(vec![Box::new(FauxExtractor {
            application_id: "browser.exe",
            kind: HostKind::Browser,
            capabilities: vec![HostCapability::CaptureContext],
            outcome: Err(HostCaptureErrorCode::CaptureFailed),
        })]);
        let result = failed.capture(request(Some("browser.exe")));
        let error = result.error.expect("error");
        assert_eq!(error.message, "Host context capture failed.");
        assert!(!error.message.contains("secret"));
    }

    #[test]
    fn rejects_oversized_and_expired_faux_context() {
        let captured_at = now_millis();
        let oversized = ExtractedHostContext {
            source: "Faux Explorer".to_string(),
            summary: "Too large".to_string(),
            captured_at,
            expires_at: captured_at + 60_000,
            sensitivity: ContextSensitivity::LocalMetadata,
            blocks: vec![AsideContextBlock::Text {
                label: None,
                text: "x".repeat(MAX_CONTEXT_TEXT_BYTES + 1),
            }],
        };
        let registry = HostExtractorRegistry::new(vec![Box::new(FauxExtractor {
            application_id: "explorer.exe",
            kind: HostKind::Explorer,
            capabilities: vec![HostCapability::CaptureContext],
            outcome: Ok(oversized),
        })]);
        let result = registry.capture(request(Some("explorer.exe")));
        assert_eq!(
            result.error.as_ref().map(|error| error.code),
            Some(HostCaptureErrorCode::Oversized)
        );

        let expired = ExtractedHostContext {
            source: "Faux PDF".to_string(),
            summary: "Expired".to_string(),
            captured_at: captured_at.saturating_sub(60_000),
            expires_at: captured_at.saturating_sub(1),
            sensitivity: ContextSensitivity::LocalContent,
            blocks: vec![AsideContextBlock::Text {
                label: None,
                text: "expired".to_string(),
            }],
        };
        let mut expired_request = request(Some("reader.exe"));
        expired_request.captured_at = expired.captured_at;
        let error = normalize_attachment(&expired_request, HostKind::PdfReader, expired)
            .expect_err("expired attachment should be rejected");
        assert_eq!(error, HostCaptureErrorCode::Expired);
    }

    #[test]
    fn captures_all_supported_host_kinds_through_one_extractor_contract() {
        let cases = [
            (
                "browser.exe",
                HostKind::Browser,
                HostCapability::BrowserUrlTitle,
            ),
            (
                "explorer.exe",
                HostKind::Explorer,
                HostCapability::ExplorerMetadata,
            ),
            (
                "code.exe",
                HostKind::VsCode,
                HostCapability::VscodeWorkspace,
            ),
            (
                "reader.exe",
                HostKind::PdfReader,
                HostCapability::PdfDocument,
            ),
        ];
        let extractors = cases
            .iter()
            .map(|(application_id, kind, capability)| {
                Box::new(FauxExtractor {
                    application_id,
                    kind: *kind,
                    capabilities: vec![HostCapability::CaptureContext, *capability],
                    outcome: Ok(successful_context()),
                }) as Box<dyn HostExtractor>
            })
            .collect();
        let registry = HostExtractorRegistry::new(extractors);

        for (application_id, expected_kind, _) in cases {
            let result = registry.capture(request(Some(application_id)));
            let attachment = result.attachment.expect("attachment");
            assert_eq!(result.host.kind, expected_kind);
            assert_eq!(attachment.host, expected_kind);
        }
    }

    #[test]
    fn unsupported_targets_never_invent_context() {
        let registry = HostExtractorRegistry::production();
        let result = registry.capture(request(Some("unknown.exe")));
        assert_eq!(result.host.kind, HostKind::Unsupported);
        assert_eq!(result.host.availability, HostAvailability::Unsupported);
        assert!(result.attachment.is_none());
        assert!(result.error.is_none());
    }

    #[test]
    fn production_registry_classifies_chromium_by_executable_identity() {
        let registry = HostExtractorRegistry::production();

        for application_id in ["chrome.exe", "msedge.exe"] {
            let view = registry.classify(&HostTargetSnapshot::synthetic(
                "browser-target",
                Some(application_id),
            ));
            assert_eq!(view.kind, HostKind::Browser);
            assert_eq!(view.availability, HostAvailability::Available);
            assert!(view
                .capabilities
                .contains(&HostCapability::ChromiumUiaSemanticCapture));
        }
    }
}
