//! Path-only host strategies for file-oriented Windows applications.
//!
//! These adapters deliberately stop at a validated descriptor. They may read
//! a host's metadata or accessibility locator, but they never open, parse, or
//! copy the referenced file.

use std::time::Duration;

use serde_json::json;

use crate::context::{
    AsideContextBlock, ContextSensitivity, ExtractedHostContext, HostCapability,
    HostCaptureErrorCode, HostExtractor, HostKind, HostTargetSnapshot, PathDescriptor, PathKind,
    PathRole,
};
use crate::path::{self, PathError};

const CONTEXT_TTL: Duration = Duration::from_secs(5 * 60);
const VSCODE_PRIORITY: u16 = 20;
const EXPLORER_PRIORITY: u16 = 30;
const DOCUMENT_PRIORITY: u16 = 40;
const MAX_DISCOVERED_PATH_BYTES: usize = 4_096;
const MAX_DESCRIPTORS: usize = 8;

fn path_context(
    source: &'static str,
    captured_at: u64,
    descriptors: Vec<PathDescriptor>,
) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
    if descriptors.is_empty() {
        return Err(HostCaptureErrorCode::LocatorUnavailable);
    }

    let descriptor_count = descriptors.len();
    Ok(ExtractedHostContext {
        source: source.to_string(),
        summary: format!(
            "{} | {} validated path descriptor{}",
            source,
            descriptor_count,
            if descriptor_count == 1 { "" } else { "s" }
        ),
        captured_at,
        expires_at: captured_at.saturating_add(CONTEXT_TTL.as_millis() as u64),
        sensitivity: ContextSensitivity::LocalMetadata,
        blocks: vec![AsideContextBlock::Json {
            label: Some("path.metadata".to_string()),
            data: json!({
                "mode": "path_only",
                "descriptorCount": descriptor_count,
                "contentCaptured": false,
            }),
        }],
        descriptors,
    })
}

fn map_path_error(error: PathError) -> HostCaptureErrorCode {
    match error {
        PathError::PermissionDenied => HostCaptureErrorCode::PermissionDenied,
        PathError::Missing => HostCaptureErrorCode::LocatorUnavailable,
        PathError::WrongType | PathError::Invalid => HostCaptureErrorCode::InvalidPath,
    }
}

fn add_descriptor(descriptors: &mut Vec<PathDescriptor>, descriptor: PathDescriptor) {
    if descriptors.iter().any(|existing| {
        existing.role == descriptor.role
            && existing.kind == descriptor.kind
            && existing.path == descriptor.path
    }) {
        return;
    }
    if descriptors.len() < MAX_DESCRIPTORS {
        descriptors.push(descriptor);
    }
}

fn application_is(target: &HostTargetSnapshot, applications: &[&str]) -> bool {
    target
        .application_id
        .as_deref()
        .map(|application| {
            applications
                .iter()
                .any(|candidate| application.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}

#[derive(Clone, Debug, Default)]
pub(crate) struct VsCodePathExtractor;

impl HostExtractor for VsCodePathExtractor {
    fn strategy_id(&self) -> &'static str {
        "vscode_path"
    }

    fn priority(&self) -> u16 {
        VSCODE_PRIORITY
    }

    fn kind(&self) -> HostKind {
        HostKind::VsCode
    }

    fn matches(&self, target: &HostTargetSnapshot) -> bool {
        application_is(target, &["code.exe", "code-insiders.exe", "codium.exe"])
    }

    fn capabilities(&self, _: &HostTargetSnapshot) -> Vec<HostCapability> {
        vec![
            HostCapability::CaptureContext,
            HostCapability::VscodeWorkspace,
            HostCapability::PathDescriptor,
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
            if !crate::platform::target_is_captureable(target) {
                return Err(HostCaptureErrorCode::StaleTarget);
            }
            let signals = discover_uia_path_signals(target)?;
            let descriptors = descriptors_from_signals(&signals, PathRole::ActiveFile, false)?;
            if !crate::platform::target_is_current(target) {
                return Err(HostCaptureErrorCode::StaleTarget);
            }
            path_context("Visual Studio Code", request.captured_at, descriptors)
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = request;
            Err(HostCaptureErrorCode::Unavailable)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ExplorerPathExtractor;

impl HostExtractor for ExplorerPathExtractor {
    fn strategy_id(&self) -> &'static str {
        "explorer_path"
    }

    fn priority(&self) -> u16 {
        EXPLORER_PRIORITY
    }

    fn kind(&self) -> HostKind {
        HostKind::Explorer
    }

    fn matches(&self, target: &HostTargetSnapshot) -> bool {
        application_is(target, &["explorer.exe"])
    }

    fn capabilities(&self, _: &HostTargetSnapshot) -> Vec<HostCapability> {
        vec![
            HostCapability::CaptureContext,
            HostCapability::ExplorerMetadata,
            HostCapability::PathDescriptor,
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
            if !crate::platform::target_is_captureable(target) {
                return Err(HostCaptureErrorCode::StaleTarget);
            }
            let signals = discover_explorer_signals(target)?;
            let directory = signals
                .directory
                .ok_or(HostCaptureErrorCode::LocatorUnavailable)?;
            let mut descriptors = vec![path::descriptor_from_path(
                PathRole::Directory,
                &directory,
                Some(PathKind::Directory),
            )
            .map_err(map_path_error)?];

            for selected_path in signals.selected_paths.into_iter().chain(
                signals
                    .selected_names
                    .into_iter()
                    .map(|name| selected_item_path(&directory, &name)),
            ) {
                let Ok(descriptor) =
                    path::descriptor_from_path(PathRole::SelectedItem, &selected_path, None)
                else {
                    continue;
                };
                add_descriptor(&mut descriptors, descriptor);
            }

            if !crate::platform::target_is_current(target) {
                return Err(HostCaptureErrorCode::StaleTarget);
            }
            path_context("Windows Explorer", request.captured_at, descriptors)
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = request;
            Err(HostCaptureErrorCode::Unavailable)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct PdfPathExtractor;

impl HostExtractor for PdfPathExtractor {
    fn strategy_id(&self) -> &'static str {
        "pdf_path"
    }

    fn priority(&self) -> u16 {
        DOCUMENT_PRIORITY
    }

    fn kind(&self) -> HostKind {
        HostKind::PdfReader
    }

    fn matches(&self, target: &HostTargetSnapshot) -> bool {
        application_is(
            target,
            &[
                "acrord32.exe",
                "acrobat.exe",
                "foxitreader.exe",
                "sumatrapdf.exe",
                "okular.exe",
            ],
        )
    }

    fn capabilities(&self, _: &HostTargetSnapshot) -> Vec<HostCapability> {
        vec![
            HostCapability::CaptureContext,
            HostCapability::PdfDocument,
            HostCapability::PathDescriptor,
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
            if !crate::platform::target_is_captureable(target) {
                return Err(HostCaptureErrorCode::StaleTarget);
            }
            let signals = discover_uia_path_signals(target)?;
            let descriptors = descriptors_from_signals(&signals, PathRole::Document, true)?;
            if !crate::platform::target_is_current(target) {
                return Err(HostCaptureErrorCode::StaleTarget);
            }
            path_context("PDF reader", request.captured_at, descriptors)
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = request;
            Err(HostCaptureErrorCode::Unavailable)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct WordPathExtractor;

impl HostExtractor for WordPathExtractor {
    fn strategy_id(&self) -> &'static str {
        "word_com_path"
    }

    fn priority(&self) -> u16 {
        DOCUMENT_PRIORITY
    }

    fn kind(&self) -> HostKind {
        HostKind::Word
    }

    fn matches(&self, target: &HostTargetSnapshot) -> bool {
        application_is(target, &["winword.exe"])
    }

    fn capabilities(&self, _: &HostTargetSnapshot) -> Vec<HostCapability> {
        vec![
            HostCapability::CaptureContext,
            HostCapability::WordDocument,
            HostCapability::PathDescriptor,
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
            capture_office_windows(
                target,
                request.captured_at,
                "Word.Application",
                "ActiveDocument",
                "Microsoft Word",
                PathRole::Document,
            )
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = request;
            Err(HostCaptureErrorCode::Unavailable)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ExcelPathExtractor;

impl HostExtractor for ExcelPathExtractor {
    fn strategy_id(&self) -> &'static str {
        "excel_com_path"
    }

    fn priority(&self) -> u16 {
        DOCUMENT_PRIORITY
    }

    fn kind(&self) -> HostKind {
        HostKind::Excel
    }

    fn matches(&self, target: &HostTargetSnapshot) -> bool {
        application_is(target, &["excel.exe"])
    }

    fn capabilities(&self, _: &HostTargetSnapshot) -> Vec<HostCapability> {
        vec![
            HostCapability::CaptureContext,
            HostCapability::ExcelDocument,
            HostCapability::PathDescriptor,
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
            capture_office_windows(
                target,
                request.captured_at,
                "Excel.Application",
                "ActiveWorkbook",
                "Microsoft Excel",
                PathRole::Document,
            )
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = request;
            Err(HostCaptureErrorCode::Unavailable)
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug)]
struct PathSignal {
    value: String,
    role_hint: Option<PathRole>,
}

#[cfg(target_os = "windows")]
fn path_text(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_DISCOVERED_PATH_BYTES
        || value.chars().any(char::is_control)
        || !path::is_absolute_path(value)
    {
        return None;
    }
    Some(value.to_string())
}

#[cfg(target_os = "windows")]
fn path_role_hint(identifier: &str) -> Option<PathRole> {
    if identifier.contains("workspace") || identifier.contains("folder") {
        Some(PathRole::WorkspaceRoot)
    } else if identifier.contains("file")
        || identifier.contains("resource")
        || identifier.contains("document")
        || identifier.contains("editor")
        || identifier.contains("uri")
    {
        Some(PathRole::ActiveFile)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn explicit_path_signal(node: &crate::uia::UiNode) -> Option<PathSignal> {
    let identifier = node
        .automation_id()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let identifier_is_explicit = [
        "path",
        "filepath",
        "file-path",
        "workspace",
        "resource",
        "documentpath",
        "document-path",
    ]
    .iter()
    .any(|marker| identifier.contains(marker));

    if node.role() == "document" {
        if let Some(value) = node.name().and_then(path_text) {
            return Some(PathSignal {
                value,
                role_hint: Some(PathRole::ActiveFile),
            });
        }
    }

    if !identifier_is_explicit {
        return None;
    }

    let value = node
        .current_value()
        .as_deref()
        .and_then(path_text)
        .or_else(|| node.name().and_then(path_text))?;
    Some(PathSignal {
        value,
        role_hint: path_role_hint(&identifier),
    })
}

#[cfg(target_os = "windows")]
fn append_signals(signals: &mut Vec<PathSignal>, nodes: &[crate::uia::UiNode]) {
    for node in nodes {
        let Some(signal) = explicit_path_signal(node) else {
            continue;
        };
        if signals.iter().any(|existing| {
            existing.value == signal.value && existing.role_hint == signal.role_hint
        }) {
            continue;
        }
        signals.push(signal);
    }
}

#[cfg(target_os = "windows")]
fn discover_uia_path_signals(
    target: &crate::platform::TargetWindow,
) -> Result<Vec<PathSignal>, HostCaptureErrorCode> {
    use crate::uia::{run_on_worker, UiaError, UiaLimits, UiaView, UiaWorkerError};

    let target = target.clone();
    run_on_worker(target.native_handle(), move |session| {
        let limits = UiaLimits {
            max_depth: crate::uia::DEFAULT_MAX_DEPTH,
            max_nodes: crate::uia::DEFAULT_MAX_NODES,
        };
        let content_tree = session.tree(UiaView::Content, limits);
        let control_tree = session.tree(UiaView::Control, limits);
        if !crate::platform::target_is_captureable(&target) {
            return Err(HostCaptureErrorCode::StaleTarget);
        }
        let mut signals = Vec::new();
        append_signals(&mut signals, &content_tree.nodes);
        append_signals(&mut signals, &control_tree.nodes);
        Ok(signals)
    })
    .map_err(|error| match error {
        UiaWorkerError::Operation(code) => code,
        UiaWorkerError::System(UiaError::Unavailable) => HostCaptureErrorCode::Unavailable,
        UiaWorkerError::System(UiaError::Failed) => HostCaptureErrorCode::CaptureFailed,
    })
}

#[cfg(target_os = "windows")]
fn descriptors_from_signals(
    signals: &[PathSignal],
    default_role: PathRole,
    require_document: bool,
) -> Result<Vec<PathDescriptor>, HostCaptureErrorCode> {
    let mut descriptors = Vec::new();
    for signal in signals {
        let (role, expected_kind) = if require_document {
            (PathRole::Document, Some(PathKind::File))
        } else if let Some(role) = signal.role_hint {
            (
                role,
                Some(match role {
                    PathRole::WorkspaceRoot | PathRole::Directory => PathKind::Directory,
                    PathRole::ActiveFile | PathRole::SelectedItem | PathRole::Document => {
                        PathKind::File
                    }
                }),
            )
        } else {
            (default_role, None)
        };

        let result = path::descriptor_from_path(role, &signal.value, expected_kind);
        let descriptor = match result {
            Ok(descriptor) => descriptor,
            Err(PathError::Missing) => continue,
            Err(PathError::PermissionDenied) => return Err(HostCaptureErrorCode::PermissionDenied),
            Err(PathError::WrongType) => return Err(HostCaptureErrorCode::InvalidPath),
            Err(PathError::Invalid) => continue,
        };
        add_descriptor(&mut descriptors, descriptor);
    }

    if descriptors.is_empty() {
        return Err(HostCaptureErrorCode::LocatorUnavailable);
    }
    if require_document {
        if descriptors.len() != 1 {
            return Err(HostCaptureErrorCode::AmbiguousLocator);
        }
        return Ok(descriptors);
    }

    for role in [PathRole::WorkspaceRoot, PathRole::ActiveFile] {
        let count = descriptors
            .iter()
            .filter(|descriptor| descriptor.role == role)
            .count();
        if count > 1 {
            return Err(HostCaptureErrorCode::AmbiguousLocator);
        }
    }
    Ok(descriptors)
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Default)]
struct ExplorerSignals {
    directory: Option<String>,
    selected_paths: Vec<String>,
    selected_names: Vec<String>,
}

#[cfg(target_os = "windows")]
fn explorer_address_node(node: &crate::uia::UiNode) -> Option<String> {
    if !matches!(node.role(), "edit" | "combobox") {
        return None;
    }
    let value = node.current_value().as_deref().and_then(path_text)?;
    let identifier = node
        .automation_id()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = node.name().unwrap_or_default().to_ascii_lowercase();
    let explicit_name = identifier.contains("address")
        || identifier.contains("location")
        || identifier == "41477"
        || name.contains("address")
        || name.contains("location")
        || name == "path";
    if explicit_name || path::is_absolute_path(&value) {
        Some(value)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn explorer_selected_name(node: &crate::uia::UiNode) -> Option<String> {
    if !matches!(node.role(), "listitem" | "dataitem") || node.selected() != Some(true) {
        return None;
    }
    let name = node.name()?.trim();
    if name.is_empty()
        || name.len() > MAX_DISCOVERED_PATH_BYTES
        || name.chars().any(char::is_control)
    {
        return None;
    }
    if path::is_absolute_path(name) {
        return Some(name.to_string());
    }
    if name.contains('\\') || name.contains('/') || name == "." || name == ".." {
        return None;
    }
    Some(name.to_string())
}

#[cfg(target_os = "windows")]
fn discover_explorer_uia_signals(
    target: &crate::platform::TargetWindow,
) -> Result<ExplorerSignals, HostCaptureErrorCode> {
    use crate::uia::{run_on_worker, UiaError, UiaLimits, UiaView, UiaWorkerError};

    let target = target.clone();
    run_on_worker(target.native_handle(), move |session| {
        let limits = UiaLimits {
            max_depth: crate::uia::DEFAULT_MAX_DEPTH,
            max_nodes: crate::uia::DEFAULT_MAX_NODES,
        };
        let content_tree = session.tree(UiaView::Content, limits);
        let control_tree = session.tree(UiaView::Control, limits);
        if !crate::platform::target_is_captureable(&target) {
            return Err(HostCaptureErrorCode::StaleTarget);
        }

        let mut directories = Vec::new();
        for node in control_tree.nodes.iter().chain(content_tree.nodes.iter()) {
            if let Some(value) = explorer_address_node(node) {
                if !directories.contains(&value) {
                    directories.push(value);
                }
            }
        }
        if directories.len() > 1 {
            return Err(HostCaptureErrorCode::AmbiguousLocator);
        }

        let mut selected_names = Vec::new();
        for node in content_tree.nodes.iter() {
            if let Some(name) = explorer_selected_name(node) {
                if !selected_names.contains(&name) {
                    selected_names.push(name);
                }
            }
        }
        Ok(ExplorerSignals {
            directory: directories.into_iter().next(),
            selected_paths: Vec::new(),
            selected_names,
        })
    })
    .map_err(|error| match error {
        UiaWorkerError::Operation(code) => code,
        UiaWorkerError::System(UiaError::Unavailable) => HostCaptureErrorCode::Unavailable,
        UiaWorkerError::System(UiaError::Failed) => HostCaptureErrorCode::CaptureFailed,
    })
}

#[cfg(target_os = "windows")]
fn discover_explorer_signals(
    target: &crate::platform::TargetWindow,
) -> Result<ExplorerSignals, HostCaptureErrorCode> {
    let shell_result = crate::explorer_shell::discover(target);
    match shell_result {
        Err(
            code @ (HostCaptureErrorCode::AmbiguousLocator | HostCaptureErrorCode::StaleTarget),
        ) => return Err(code),
        Err(_) | Ok(None) => discover_explorer_uia_signals(target),
        Ok(Some(shell)) if shell.directory.is_some() => Ok(ExplorerSignals {
            directory: shell.directory,
            selected_paths: shell.selected_paths,
            selected_names: Vec::new(),
        }),
        Ok(Some(shell)) => {
            let mut uia = discover_explorer_uia_signals(target)?;
            for selected_path in shell.selected_paths {
                if !uia.selected_paths.contains(&selected_path) {
                    uia.selected_paths.push(selected_path);
                }
            }
            Ok(uia)
        }
    }
}

#[cfg(target_os = "windows")]
fn selected_item_path(directory: &str, selected_name: &str) -> String {
    if path::is_absolute_path(selected_name) {
        selected_name.to_string()
    } else {
        std::path::Path::new(directory)
            .join(selected_name)
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(target_os = "windows")]
fn capture_office_windows(
    target: &crate::platform::TargetWindow,
    captured_at: u64,
    prog_id: &'static str,
    active_document_property: &'static str,
    source: &'static str,
    role: PathRole,
) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
    let target = target.clone();
    std::thread::Builder::new()
        .name("aside-office-path".to_string())
        .spawn(move || {
            capture_office_on_worker(
                &target,
                captured_at,
                prog_id,
                active_document_property,
                source,
                role,
            )
        })
        .map_err(|_| HostCaptureErrorCode::Unavailable)?
        .join()
        .unwrap_or(Err(HostCaptureErrorCode::CaptureFailed))
}

#[cfg(target_os = "windows")]
fn capture_office_on_worker(
    target: &crate::platform::TargetWindow,
    captured_at: u64,
    prog_id: &str,
    active_document_property: &str,
    source: &'static str,
    role: PathRole,
) -> Result<ExtractedHostContext, HostCaptureErrorCode> {
    use std::mem::ManuallyDrop;

    use windows::core::{IUnknown, Interface, BSTR, GUID, PCWSTR};
    use windows::Win32::System::Com::{
        CLSIDFromProgID, CoInitializeEx, CoUninitialize, IDispatch, COINIT_MULTITHREADED,
        DISPATCH_PROPERTYGET, DISPPARAMS,
    };
    use windows::Win32::System::Ole::GetActiveObject;
    use windows::Win32::System::Variant::{VARIANT, VT_BSTR, VT_I4, VT_I8, VT_UI4, VT_UI8};

    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    if !crate::platform::target_is_captureable(target) {
        return Err(HostCaptureErrorCode::StaleTarget);
    }
    if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
        return Err(HostCaptureErrorCode::Unavailable);
    }
    let _com = ComGuard;

    let prog_id = BSTR::from(prog_id);
    let clsid = unsafe { CLSIDFromProgID(&prog_id) }
        .map_err(|_| HostCaptureErrorCode::LocatorUnavailable)?;
    let mut unknown: Option<IUnknown> = None;
    unsafe { GetActiveObject(&clsid, None, &mut unknown) }
        .map_err(|_| HostCaptureErrorCode::LocatorUnavailable)?;
    let application = unknown
        .ok_or(HostCaptureErrorCode::LocatorUnavailable)?
        .cast::<IDispatch>()
        .map_err(|_| HostCaptureErrorCode::LocatorUnavailable)?;

    let active_window = property_dispatch(&application, "ActiveWindow")?;
    let active_hwnd = property_i64(&property_value(&active_window, "Hwnd")?)
        .ok_or(HostCaptureErrorCode::LocatorUnavailable)?;
    if active_hwnd != target.native_handle() as i64 {
        return Err(HostCaptureErrorCode::StaleTarget);
    }
    if !crate::platform::target_is_current(target) {
        return Err(HostCaptureErrorCode::StaleTarget);
    }

    let document = property_dispatch(&application, active_document_property)?;
    let full_name = property_string(&property_value(&document, "FullName")?)
        .filter(|value| !value.trim().is_empty())
        .ok_or(HostCaptureErrorCode::LocatorUnavailable)?;
    let descriptor = path::descriptor_from_path(role, full_name.trim(), Some(PathKind::File))
        .map_err(map_path_error)?;
    if !crate::platform::target_is_current(target) {
        return Err(HostCaptureErrorCode::StaleTarget);
    }
    let result = path_context(source, captured_at, vec![descriptor]);

    fn property_name(name: &str) -> PCWSTR {
        match name {
            "ActiveWindow" => windows::core::w!("ActiveWindow"),
            "ActiveDocument" => windows::core::w!("ActiveDocument"),
            "ActiveWorkbook" => windows::core::w!("ActiveWorkbook"),
            "Hwnd" => windows::core::w!("Hwnd"),
            "FullName" => windows::core::w!("FullName"),
            _ => PCWSTR::null(),
        }
    }

    fn property_value(dispatch: &IDispatch, name: &str) -> Result<VARIANT, HostCaptureErrorCode> {
        let names = [property_name(name)];
        let mut dispid = 0;
        unsafe {
            dispatch
                .GetIDsOfNames(&GUID::zeroed(), names.as_ptr(), 1, 0, &mut dispid)
                .map_err(|_| HostCaptureErrorCode::LocatorUnavailable)?;
        }
        let params = DISPPARAMS::default();
        let mut value = VARIANT::default();
        unsafe {
            dispatch
                .Invoke(
                    dispid,
                    &GUID::zeroed(),
                    0,
                    DISPATCH_PROPERTYGET,
                    &params,
                    Some(&mut value),
                    None,
                    None,
                )
                .map_err(|_| HostCaptureErrorCode::LocatorUnavailable)?;
        }
        Ok(value)
    }

    fn property_dispatch(
        dispatch: &IDispatch,
        name: &str,
    ) -> Result<IDispatch, HostCaptureErrorCode> {
        let value = property_value(dispatch, name)?;
        IDispatch::try_from(&value).map_err(|_| HostCaptureErrorCode::LocatorUnavailable)
    }

    fn property_string(value: &VARIANT) -> Option<String> {
        if value.vt() != VT_BSTR {
            return None;
        }
        let bstr: &BSTR = unsafe {
            &*(&value.Anonymous.Anonymous.Anonymous.bstrVal as *const ManuallyDrop<BSTR>
                as *const BSTR)
        };
        String::try_from(bstr).ok()
    }

    fn property_i64(value: &VARIANT) -> Option<i64> {
        unsafe {
            match value.vt() {
                VT_I4 => Some(i64::from(value.Anonymous.Anonymous.Anonymous.lVal)),
                VT_I8 => Some(value.Anonymous.Anonymous.Anonymous.llVal),
                VT_UI4 => Some(i64::from(value.Anonymous.Anonymous.Anonymous.ulVal)),
                VT_UI8 => i64::try_from(value.Anonymous.Anonymous.Anonymous.ullVal).ok(),
                _ => None,
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategies_match_only_their_declared_process_identities() {
        let vscode = VsCodePathExtractor;
        let explorer = ExplorerPathExtractor;
        let pdf = PdfPathExtractor;
        let word = WordPathExtractor;
        let excel = ExcelPathExtractor;

        assert!(vscode.matches(&HostTargetSnapshot::synthetic("target", Some("code.exe"))));
        assert!(!vscode.matches(&HostTargetSnapshot::synthetic("target", Some("word.exe"))));
        assert!(explorer.matches(&HostTargetSnapshot::synthetic(
            "target",
            Some("explorer.exe")
        )));
        assert!(pdf.matches(&HostTargetSnapshot::synthetic(
            "target",
            Some("AcroRd32.exe")
        )));
        assert!(word.matches(&HostTargetSnapshot::synthetic(
            "target",
            Some("WINWORD.EXE")
        )));
        assert!(excel.matches(&HostTargetSnapshot::synthetic("target", Some("excel.exe"))));
    }

    #[test]
    fn path_only_context_contains_metadata_and_no_content_block() {
        let context = path_context(
            "Test host",
            10,
            vec![PathDescriptor {
                role: PathRole::Document,
                path: if cfg!(windows) {
                    r"C:\fixture\document.docx".replace('\\', "/")
                } else {
                    "/fixture/document.docx".to_string()
                },
                kind: PathKind::File,
            }],
        )
        .expect("path context");
        assert_eq!(context.blocks.len(), 1);
        assert_eq!(context.descriptors.len(), 1);
        let serialized = serde_json::to_string(&context.blocks[0]).expect("json");
        assert!(serialized.contains("path_only"));
        assert!(!serialized.contains("document contents"));
    }

    #[test]
    fn locator_errors_are_kept_inside_the_sanitized_contract() {
        assert_eq!(
            map_path_error(PathError::PermissionDenied),
            HostCaptureErrorCode::PermissionDenied
        );
        assert_eq!(
            map_path_error(PathError::Missing),
            HostCaptureErrorCode::LocatorUnavailable
        );
        assert_eq!(
            map_path_error(PathError::WrongType),
            HostCaptureErrorCode::InvalidPath
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn absolute_shell_selection_is_not_joined_to_the_directory() {
        assert_eq!(
            selected_item_path(r"C:\workspace", r"C:\workspace\notes.txt"),
            r"C:\workspace\notes.txt"
        );
        assert_eq!(
            selected_item_path(r"C:\workspace", "notes.txt"),
            r"C:\workspace\notes.txt"
        );
    }
}
