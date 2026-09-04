use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::platform::{self, TargetWindow};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextLimits {
    max_blocks: usize,
    max_text_bytes: usize,
    max_json_bytes: usize,
    max_total_bytes: usize,
    max_descriptors: usize,
    max_json_depth: usize,
    max_block_label_length: usize,
    max_attachment_source_length: usize,
    max_attachment_summary_length: usize,
    max_attachment_id_length: usize,
    max_path_length: usize,
}

static CONTEXT_LIMITS: OnceLock<ContextLimits> = OnceLock::new();

fn context_limits() -> &'static ContextLimits {
    CONTEXT_LIMITS.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/context-limits.json"
        )))
        .expect("shared context limits must be valid JSON")
    })
}

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
    Word,
    Excel,
    Generic,
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
    GenericUiaSemanticCapture,
    ChromiumUiaSemanticCapture,
    BrowserUrlTitle,
    ExplorerMetadata,
    VscodeWorkspace,
    PdfDocument,
    WordDocument,
    ExcelDocument,
    PathDescriptor,
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
    LocatorUnavailable,
    AmbiguousLocator,
    InvalidPath,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathRole {
    WorkspaceRoot,
    ActiveFile,
    Directory,
    SelectedItem,
    Document,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathKind {
    File,
    Directory,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathDescriptor {
    pub role: PathRole,
    pub path: String,
    pub kind: PathKind,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    pub source: String,
    pub captured_at: u64,
    pub expires_at: u64,
    pub sensitivity: ContextSensitivity,
    pub summary: String,
    pub blocks: Vec<AsideContextBlock>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub descriptors: Vec<PathDescriptor>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy_priority: Option<u16>,
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
    pub(crate) fn synthetic(target_id: &str, application_id: Option<&str>) -> Self {
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
    pub descriptors: Vec<PathDescriptor>,
}

pub trait HostExtractor: Send + Sync {
    fn strategy_id(&self) -> &'static str;
    fn priority(&self) -> u16;
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
    generic: Box<dyn HostExtractor>,
}

#[derive(Clone, Copy)]
enum StrategySelection<'a> {
    Specialized(&'a dyn HostExtractor),
    Generic(&'a dyn HostExtractor),
    Ambiguous,
    None,
}

impl HostExtractorRegistry {
    pub fn new(extractors: Vec<Box<dyn HostExtractor>>) -> Self {
        Self {
            extractors,
            generic: Box::new(crate::generic_uia::GenericUiaExtractor::default()),
        }
    }

    #[cfg(test)]
    fn with_generic(
        extractors: Vec<Box<dyn HostExtractor>>,
        generic: Box<dyn HostExtractor>,
    ) -> Self {
        Self {
            extractors,
            generic,
        }
    }

    pub fn production() -> Self {
        let mut registry = Self::new(Vec::new());
        registry.register(Box::new(
            crate::chromium_uia::ChromiumUiaExtractor::default(),
        ));
        registry.register(Box::new(crate::file_hosts::VsCodePathExtractor));
        registry.register(Box::new(crate::file_hosts::ExplorerPathExtractor));
        registry.register(Box::new(crate::file_hosts::PdfPathExtractor));
        registry.register(Box::new(crate::file_hosts::WordPathExtractor));
        registry.register(Box::new(crate::file_hosts::ExcelPathExtractor));
        registry
    }

    pub fn register(&mut self, extractor: Box<dyn HostExtractor>) {
        self.extractors.push(extractor);
    }

    fn matching<'a>(&'a self, target: &HostTargetSnapshot) -> Vec<&'a dyn HostExtractor> {
        self.extractors
            .iter()
            .filter(|extractor| extractor.matches(target))
            .map(|extractor| extractor.as_ref())
            .collect()
    }

    fn select<'a>(&'a self, target: &HostTargetSnapshot) -> StrategySelection<'a> {
        let matches = self.matching(target);
        let Some(priority) = matches.iter().map(|extractor| extractor.priority()).min() else {
            return if self.generic.matches(target) {
                StrategySelection::Generic(self.generic.as_ref())
            } else {
                StrategySelection::None
            };
        };
        let winners: Vec<_> = matches
            .into_iter()
            .filter(|extractor| extractor.priority() == priority)
            .collect();
        if winners.len() == 1 {
            StrategySelection::Specialized(winners[0])
        } else {
            StrategySelection::Ambiguous
        }
    }

    fn classify_matches(target: &HostTargetSnapshot, selection: StrategySelection<'_>) -> HostView {
        let extractor = match selection {
            StrategySelection::Specialized(extractor) | StrategySelection::Generic(extractor) => {
                extractor
            }
            StrategySelection::Ambiguous => {
                return HostView {
                    target_id: Some(target.target_id.clone()),
                    application_id: target.application_id.clone(),
                    kind: HostKind::Unsupported,
                    strategy: None,
                    strategy_priority: None,
                    availability: HostAvailability::Ambiguous,
                    capabilities: Vec::new(),
                }
            }
            StrategySelection::None => {
                return HostView {
                    target_id: Some(target.target_id.clone()),
                    application_id: target.application_id.clone(),
                    kind: HostKind::Unsupported,
                    strategy: None,
                    strategy_priority: None,
                    availability: HostAvailability::Unsupported,
                    capabilities: Vec::new(),
                }
            }
        };

        let mut capabilities = extractor.capabilities(target);
        if !capabilities.contains(&HostCapability::Identify) {
            capabilities.insert(0, HostCapability::Identify);
        }
        HostView {
            target_id: Some(target.target_id.clone()),
            application_id: target.application_id.clone(),
            kind: extractor.kind(),
            strategy: Some(extractor.strategy_id().to_string()),
            strategy_priority: Some(extractor.priority()),
            availability: HostAvailability::Available,
            capabilities,
        }
    }

    pub fn classify(&self, target: &HostTargetSnapshot) -> HostView {
        Self::classify_matches(target, self.select(target))
    }

    pub fn capture(&self, request: HostCaptureRequest) -> HostCaptureResult {
        let selection = self.select(&request.target);
        let host = Self::classify_matches(&request.target, selection);

        if !request.target.is_current() {
            return failed_result(request.capture_id, host, HostCaptureErrorCode::StaleTarget);
        }
        let extractor = match selection {
            StrategySelection::Specialized(extractor) | StrategySelection::Generic(extractor) => {
                extractor
            }
            StrategySelection::Ambiguous => {
                return failed_result(
                    request.capture_id,
                    host,
                    HostCaptureErrorCode::AmbiguousTarget,
                )
            }
            StrategySelection::None => {
                return HostCaptureResult {
                    capture_id: request.capture_id,
                    host,
                    attachment: None,
                    error: None,
                }
            }
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
        if !request.target.is_current() {
            return failed_result(request.capture_id, host, HostCaptureErrorCode::StaleTarget);
        }
        let attachment = match normalize_attachment(
            &request,
            extractor.kind(),
            extractor.strategy_id(),
            extracted,
        ) {
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
            strategy: None,
            strategy_priority: None,
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
        strategy: None,
        strategy_priority: None,
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
        HostCaptureErrorCode::LocatorUnavailable => {
            ("The host did not expose a reliable path locator.", true)
        }
        HostCaptureErrorCode::AmbiguousLocator => (
            "The host exposed more than one possible path locator.",
            true,
        ),
        HostCaptureErrorCode::InvalidPath => ("The host path could not be validated safely.", true),
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
    strategy: &str,
    extracted: ExtractedHostContext,
) -> Result<AsideHostAttachment, HostCaptureErrorCode> {
    if request.capture_id.is_empty()
        || request.capture_id.len() > context_limits().max_attachment_id_length
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
    validate_safe_text(
        &extracted.source,
        context_limits().max_attachment_source_length,
    )
    .map_err(|_| HostCaptureErrorCode::Malformed)?;
    validate_safe_text(
        &extracted.summary,
        context_limits().max_attachment_summary_length,
    )
    .map_err(|_| HostCaptureErrorCode::Malformed)?;
    validate_blocks(&extracted.blocks)?;
    validate_descriptors(&extracted.descriptors)?;
    validate_safe_text(strategy, context_limits().max_attachment_source_length)
        .map_err(|_| HostCaptureErrorCode::Malformed)?;
    let attachment = AsideHostAttachment {
        id: request.capture_id.clone(),
        host,
        strategy: Some(strategy.to_string()),
        source: extracted.source,
        captured_at: extracted.captured_at,
        expires_at: extracted.expires_at,
        sensitivity: extracted.sensitivity,
        summary: extracted.summary,
        blocks: extracted.blocks,
        descriptors: extracted.descriptors,
    };
    let serialized =
        serde_json::to_vec(&attachment).map_err(|_| HostCaptureErrorCode::Malformed)?;
    if serialized.len() > context_limits().max_total_bytes {
        return Err(HostCaptureErrorCode::Oversized);
    }
    Ok(attachment)
}

fn validate_descriptors(descriptors: &[PathDescriptor]) -> Result<(), HostCaptureErrorCode> {
    if descriptors.len() > context_limits().max_descriptors {
        return Err(HostCaptureErrorCode::Oversized);
    }
    for descriptor in descriptors {
        validate_safe_text(&descriptor.path, context_limits().max_path_length)
            .map_err(|_| HostCaptureErrorCode::InvalidPath)?;
        if descriptor.path.is_empty() || !std::path::Path::new(&descriptor.path).is_absolute() {
            return Err(HostCaptureErrorCode::InvalidPath);
        }
        let role_requires_directory = matches!(
            descriptor.role,
            PathRole::WorkspaceRoot | PathRole::Directory
        );
        let role_requires_file =
            matches!(descriptor.role, PathRole::ActiveFile | PathRole::Document);
        if (role_requires_directory && descriptor.kind != PathKind::Directory)
            || (role_requires_file && descriptor.kind != PathKind::File)
        {
            return Err(HostCaptureErrorCode::InvalidPath);
        }
    }
    Ok(())
}

fn validate_blocks(blocks: &[AsideContextBlock]) -> Result<(), HostCaptureErrorCode> {
    if blocks.is_empty() || blocks.len() > context_limits().max_blocks {
        return Err(HostCaptureErrorCode::Oversized);
    }
    for block in blocks {
        match block {
            AsideContextBlock::Text { label, text } => {
                if let Some(label) = label {
                    validate_safe_text(label, context_limits().max_block_label_length)
                        .map_err(|_| HostCaptureErrorCode::Malformed)?;
                }
                if text.len() > context_limits().max_text_bytes {
                    return Err(HostCaptureErrorCode::Oversized);
                }
            }
            AsideContextBlock::Json { label, data } => {
                if let Some(label) = label {
                    validate_safe_text(label, context_limits().max_block_label_length)
                        .map_err(|_| HostCaptureErrorCode::Malformed)?;
                }
                let serialized =
                    serde_json::to_vec(data).map_err(|_| HostCaptureErrorCode::Malformed)?;
                if serialized.len() > context_limits().max_json_bytes {
                    return Err(HostCaptureErrorCode::Oversized);
                }
                if json_depth(data, 0) > context_limits().max_json_depth {
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
        strategy_id: &'static str,
        priority: u16,
        kind: HostKind,
        capabilities: Vec<HostCapability>,
        outcome: Result<ExtractedHostContext, HostCaptureErrorCode>,
    }

    struct CountingExtractor {
        id: &'static str,
        priority: u16,
        kind: HostKind,
        application_id: Option<&'static str>,
        calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        outcome: Result<ExtractedHostContext, HostCaptureErrorCode>,
    }

    impl HostExtractor for CountingExtractor {
        fn strategy_id(&self) -> &'static str {
            self.id
        }

        fn priority(&self) -> u16 {
            self.priority
        }

        fn kind(&self) -> HostKind {
            self.kind
        }

        fn matches(&self, target: &HostTargetSnapshot) -> bool {
            self.application_id
                .map(|application_id| target.application_id.as_deref() == Some(application_id))
                .unwrap_or(true)
        }

        fn capabilities(&self, _: &HostTargetSnapshot) -> Vec<HostCapability> {
            vec![HostCapability::CaptureContext]
        }

        fn capture(
            &self,
            request: &HostCaptureRequest,
        ) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.outcome.clone().map(|mut context| {
                context.captured_at = request.captured_at;
                context
            })
        }
    }

    impl HostExtractor for FauxExtractor {
        fn strategy_id(&self) -> &'static str {
            self.strategy_id
        }

        fn priority(&self) -> u16 {
            self.priority
        }

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
            descriptors: Vec::new(),
        }
    }

    #[test]
    fn classifies_one_matching_extractor_and_rejects_ambiguity() {
        let first = FauxExtractor {
            application_id: "browser.exe",
            strategy_id: "browser",
            priority: 10,
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
                strategy_id: "browser-a",
                priority: 10,
                kind: HostKind::Browser,
                capabilities: vec![HostCapability::CaptureContext],
                outcome: Ok(successful_context()),
            }),
            Box::new(FauxExtractor {
                application_id: "browser.exe",
                strategy_id: "browser-b",
                priority: 10,
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
            strategy_id: "browser",
            priority: 10,
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
            strategy_id: "browser",
            priority: 10,
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
                text: "x".repeat(context_limits().max_text_bytes + 1),
            }],
            descriptors: Vec::new(),
        };
        let registry = HostExtractorRegistry::new(vec![Box::new(FauxExtractor {
            application_id: "explorer.exe",
            strategy_id: "explorer",
            priority: 30,
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
            descriptors: Vec::new(),
        };
        let mut expired_request = request(Some("reader.exe"));
        expired_request.captured_at = expired.captured_at;
        let error = normalize_attachment(&expired_request, HostKind::PdfReader, "pdf", expired)
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
                    strategy_id: "faux",
                    priority: 10,
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
    fn unknown_targets_use_the_generic_fallback_without_inventing_context() {
        let registry = HostExtractorRegistry::production();
        let result = registry.capture(request(Some("unknown.exe")));
        assert_eq!(result.host.kind, HostKind::Generic);
        assert_eq!(result.host.strategy.as_deref(), Some("generic_uia"));
        assert_eq!(
            result.error.as_ref().map(|error| error.code),
            Some(HostCaptureErrorCode::Unavailable)
        );
        assert!(result.attachment.is_none());
    }

    #[test]
    fn priority_wins_regardless_of_registration_order_and_only_winner_runs() {
        let winner_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let loser_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let winner = CountingExtractor {
            id: "vscode",
            priority: 20,
            kind: HostKind::VsCode,
            application_id: Some("code.exe"),
            calls: winner_calls.clone(),
            outcome: Ok(successful_context()),
        };
        let loser = CountingExtractor {
            id: "generic-looking-specialized",
            priority: 50,
            kind: HostKind::Generic,
            application_id: Some("code.exe"),
            calls: loser_calls.clone(),
            outcome: Ok(successful_context()),
        };
        let registry = HostExtractorRegistry::with_generic(
            vec![Box::new(loser), Box::new(winner)],
            Box::new(CountingExtractor {
                id: "fallback",
                priority: u16::MAX,
                kind: HostKind::Generic,
                application_id: None,
                calls: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                outcome: Err(HostCaptureErrorCode::Unavailable),
            }),
        );

        let result = registry.capture(request(Some("code.exe")));
        assert_eq!(result.host.strategy.as_deref(), Some("vscode"));
        assert_eq!(winner_calls.load(Ordering::SeqCst), 1);
        assert_eq!(loser_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn specialized_failure_is_returned_without_a_generic_retry() {
        let specialized_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let generic_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let registry = HostExtractorRegistry::with_generic(
            vec![Box::new(CountingExtractor {
                id: "browser",
                priority: 10,
                kind: HostKind::Browser,
                application_id: Some("chrome.exe"),
                calls: specialized_calls.clone(),
                outcome: Err(HostCaptureErrorCode::CaptureFailed),
            })],
            Box::new(CountingExtractor {
                id: "fallback",
                priority: u16::MAX,
                kind: HostKind::Generic,
                application_id: None,
                calls: generic_calls.clone(),
                outcome: Ok(successful_context()),
            }),
        );
        let result = registry.capture(request(Some("chrome.exe")));
        assert_eq!(
            result.error.as_ref().map(|error| error.code),
            Some(HostCaptureErrorCode::CaptureFailed)
        );
        assert_eq!(specialized_calls.load(Ordering::SeqCst), 1);
        assert_eq!(generic_calls.load(Ordering::SeqCst), 0);
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

    #[test]
    fn descriptor_validation_enforces_count_and_role_kind_contract() {
        let path = if cfg!(windows) {
            "C:/workspace"
        } else {
            "/workspace"
        };
        let too_many = vec![
            PathDescriptor {
                role: PathRole::WorkspaceRoot,
                path: path.to_string(),
                kind: PathKind::Directory,
            };
            context_limits().max_descriptors + 1
        ];
        assert_eq!(
            validate_descriptors(&too_many),
            Err(HostCaptureErrorCode::Oversized)
        );

        let mismatch = [PathDescriptor {
            role: PathRole::Document,
            path: path.to_string(),
            kind: PathKind::Directory,
        }];
        assert_eq!(
            validate_descriptors(&mismatch),
            Err(HostCaptureErrorCode::InvalidPath)
        );
    }
}
