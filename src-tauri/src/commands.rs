use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::{fs, io};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

use crate::context::{self, HostCaptureResult, HostTargetSnapshot, HostView};
use crate::platform::{self, Rect, TargetWindow};
use crate::runtime::{AsideTurnContext, RuntimeManager, RuntimeRequest};
use crate::workspace::{self, WorkspaceSnapshot};

pub const AGENT_STATE_EVENT: &str = "agent://state-changed";
pub const NATIVE_ERROR_EVENT: &str = "agent://error";
pub const HOST_CAPTURE_EVENT: &str = "host://capture-completed";

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    #[default]
    Hidden,
    Visible,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    #[default]
    Side,
    Workspace,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentState {
    pub visibility: Visibility,
    pub surface: Surface,
    pub pinned: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub operation: String,
    pub recoverable: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowContext {
    pub target_id: String,
    pub application_id: Option<String>,
    pub monitor_id: String,
    pub bounds: PublicRect,
    pub maximized: bool,
    pub workspace_candidate: bool,
    pub work_area: PublicRect,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCaptureResponse {
    #[serde(flatten)]
    pub result: HostCaptureResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formatted_json: Option<String>,
}

#[derive(Default)]
pub struct AppState {
    pub native: Mutex<NativeState>,
    pub operation: Mutex<()>,
    pub runtime: RuntimeManager,
}

#[derive(Default)]
pub struct NativeState {
    visibility: Visibility,
    surface: Surface,
    pinned: bool,
    workspace: Option<WorkspaceSnapshot>,
}

impl NativeState {
    fn snapshot(&self) -> AgentState {
        AgentState {
            visibility: self.visibility,
            surface: self.surface,
            pinned: self.pinned,
        }
    }
}

fn native_error(operation: &str, message: impl Into<String>, recoverable: bool) -> NativeError {
    NativeError {
        operation: operation.to_string(),
        recoverable,
        message: message.into(),
    }
}

fn lock_native<'a>(state: &'a AppState) -> Result<MutexGuard<'a, NativeState>, NativeError> {
    state
        .native
        .lock()
        .map_err(|_| native_error("state", "Aside state is unavailable.", false))
}

fn lock_operation<'a>(state: &'a AppState) -> Result<MutexGuard<'a, ()>, NativeError> {
    state
        .operation
        .lock()
        .map_err(|_| native_error("state", "Aside operations are unavailable.", false))
}

fn emit_state(app: &AppHandle, state: &AppState) -> Result<AgentState, NativeError> {
    let snapshot = lock_native(state)?.snapshot();
    let _ = app.emit(AGENT_STATE_EVENT, snapshot.clone());
    Ok(snapshot)
}

fn emit_error(app: &AppHandle, error: NativeError) {
    let _ = app.emit(NATIVE_ERROR_EVENT, error);
}

fn agent_window(app: &AppHandle) -> Result<WebviewWindow, NativeError> {
    app.get_webview_window("main")
        .ok_or_else(|| native_error("window", "The Aside panel window is not available.", false))
}

fn set_agent_bounds(window: &WebviewWindow, bounds: Rect) -> Result<(), NativeError> {
    if bounds.width <= 0 || bounds.height <= 0 {
        return Err(native_error(
            "window_bounds",
            "The requested Aside bounds are invalid.",
            true,
        ));
    }
    window
        .set_size(PhysicalSize::new(bounds.width as u32, bounds.height as u32))
        .map_err(|_| native_error("resize_agent", "Aside could not be resized.", true))?;
    window
        .set_position(PhysicalPosition::new(bounds.x, bounds.y))
        .map_err(|_| native_error("move_agent", "Aside could not be positioned.", true))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn agent_native_handle(window: &WebviewWindow) -> Result<isize, NativeError> {
    window
        .hwnd()
        .map(|handle| handle.0 as isize)
        .map_err(|_| native_error("window", "The Aside panel handle is unavailable.", true))
}

#[cfg(not(target_os = "windows"))]
fn agent_native_handle(_: &WebviewWindow) -> Result<isize, NativeError> {
    Err(native_error(
        "window",
        "Native window placement is only available on Windows.",
        true,
    ))
}

fn set_agent_native_bounds(window: &WebviewWindow, bounds: Rect) -> Result<(), NativeError> {
    #[cfg(target_os = "windows")]
    {
        let handle = agent_native_handle(window)?;
        platform::set_window_rect(handle, bounds)
            .map_err(|error| native_error("window_bounds", error.to_string(), true))
    }

    #[cfg(not(target_os = "windows"))]
    {
        set_agent_bounds(window, bounds)
    }
}

fn set_side_bounds(window: &WebviewWindow, work_area: Rect) -> Result<(), NativeError> {
    let side_bounds = workspace::side_layout(work_area).agent;
    match set_agent_native_bounds(window, side_bounds) {
        Ok(()) => Ok(()),
        Err(native_failure) => set_agent_bounds(window, side_bounds).map_err(|fallback_error| {
            native_error(
                "side",
                format!(
                    "Aside could not occupy the full-height Side rail: {} ({})",
                    native_failure.message, fallback_error.message
                ),
                true,
            )
        }),
    }
}

fn work_area_from_tauri(window: &WebviewWindow) -> Result<Rect, NativeError> {
    if let Some(work_area) = platform::cursor_work_area() {
        return Ok(work_area);
    }

    let monitor = window
        .current_monitor()
        .map_err(|_| native_error("monitor", "The active display could not be detected.", true))?
        .or(window.primary_monitor().map_err(|_| {
            native_error(
                "monitor",
                "The primary display could not be detected.",
                true,
            )
        })?);
    let monitor = monitor
        .ok_or_else(|| native_error("monitor", "No usable display was found for Aside.", true))?;
    let work_area = monitor.work_area();
    Ok(Rect::new(
        work_area.position.x,
        work_area.position.y,
        work_area.size.width as i32,
        work_area.size.height as i32,
    ))
}

fn public_rect(rect: Rect) -> PublicRect {
    PublicRect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    }
}

fn public_context(target: &TargetWindow) -> WindowContext {
    WindowContext {
        target_id: target.opaque_id.clone(),
        application_id: target.application_id.clone(),
        monitor_id: format!("monitor-{:#016x}", target.monitor),
        bounds: public_rect(target.bounds),
        maximized: target.maximized,
        workspace_candidate: target.is_workspace_candidate(),
        work_area: public_rect(target.work_area),
    }
}

fn show_agent_locked(app: &AppHandle, state: &AppState) -> Result<AgentState, NativeError> {
    if matches!(lock_native(state)?.visibility, Visibility::Visible) {
        return emit_state(app, state);
    }

    let window = agent_window(app)?;
    let foreground = platform::foreground_target();
    let work_area = foreground
        .as_ref()
        .map(|target| target.work_area)
        .unwrap_or(work_area_from_tauri(&window)?);
    let mut surface = Surface::Side;
    let mut snapshot = None;

    if let Some(target) = foreground.filter(TargetWindow::is_workspace_candidate) {
        let layout = workspace::side_layout(target.work_area);
        let candidate_snapshot = WorkspaceSnapshot::new(target.clone());
        let workspace_result = agent_native_handle(&window).and_then(|agent_handle| {
            platform::tile_target_with_agent(&target, layout.target, agent_handle, layout.agent)
                .map_err(|error| native_error("workspace", error.to_string(), true))
        });
        let workspace_ready = workspace_result.is_ok();

        if workspace_ready {
            surface = Surface::Workspace;
            snapshot = Some(candidate_snapshot);
        } else {
            if let Err(error) = workspace_result {
                let _ = platform::restore_target(&target);
                emit_error(
                    app,
                    native_error(
                        "workspace",
                        format!("Workspace Mode was unavailable: {}", error.message),
                        true,
                    ),
                );
            }
            set_side_bounds(&window, work_area)?;
        }
    } else {
        set_side_bounds(&window, work_area)?;
    }

    let pinned = lock_native(state)?.pinned;
    if window.set_always_on_top(pinned).is_err() {
        emit_error(
            app,
            native_error(
                "pin",
                "Aside opened, but its Pin state could not be applied.",
                true,
            ),
        );
    }
    window
        .show()
        .map_err(|_| native_error("show_agent", "Aside could not be shown.", true))?;
    if window.set_focus().is_err() {
        emit_error(
            app,
            native_error(
                "focus_agent",
                "Aside opened but could not receive focus.",
                true,
            ),
        );
    }

    {
        let mut native = lock_native(state)?;
        native.visibility = Visibility::Visible;
        native.surface = surface;
        native.workspace = snapshot;
    }
    emit_state(app, state)
}

pub(crate) fn hide_agent_locked(
    app: &AppHandle,
    state: &AppState,
) -> Result<AgentState, NativeError> {
    if matches!(lock_native(state)?.visibility, Visibility::Hidden) {
        return emit_state(app, state);
    }

    let snapshot = lock_native(state)?.workspace.clone();
    if let Some(snapshot) = snapshot {
        if let Err(error) = platform::restore_target(&snapshot.target) {
            emit_error(
                app,
                native_error("workspace_restore", error.to_string(), true),
            );
        }
        let mut native = lock_native(state)?;
        native.workspace = None;
        native.surface = Surface::Side;
    }

    let window = agent_window(app)?;
    window
        .hide()
        .map_err(|_| native_error("hide_agent", "Aside could not be hidden.", true))?;
    {
        let mut native = lock_native(state)?;
        native.visibility = Visibility::Hidden;
        native.surface = Surface::Side;
    }
    emit_state(app, state)
}

pub(crate) fn hide_agent_internal(
    app: &AppHandle,
    state: &AppState,
) -> Result<AgentState, NativeError> {
    let _operation = lock_operation(state)?;
    hide_agent_locked(app, state)
}

pub(crate) fn toggle_agent_internal(
    app: &AppHandle,
    state: &AppState,
) -> Result<AgentState, NativeError> {
    let _operation = lock_operation(state)?;
    let visible = matches!(lock_native(state)?.visibility, Visibility::Visible);
    if visible {
        hide_agent_locked(app, state)
    } else {
        show_agent_locked(app, state)
    }
}

pub(crate) fn toggle_agent_from_shortcut(app: &AppHandle) {
    let state = app.state::<AppState>();
    let should_capture = match lock_native(state.inner()) {
        Ok(native) => matches!(native.visibility, Visibility::Hidden),
        Err(error) => {
            emit_error(app, error);
            return;
        }
    };
    if should_capture {
        match context::snapshot_foreground_target() {
            Some(target) => {
                let app_handle = app.clone();
                std::thread::spawn(move || {
                    emit_host_capture(
                        &app_handle,
                        capture_with_artifact(&app_handle, context::capture_target_context(target)),
                    );
                });
            }
            None => emit_host_capture(
                app,
                capture_with_artifact(app, context::capture_foreground_context()),
            ),
        }
    }
    if let Err(error) = toggle_agent_internal(app, state.inner()) {
        emit_error(app, error);
    }
}

fn capture_file_path(app: &AppHandle, capture_id: &str) -> Result<PathBuf, NativeError> {
    let capture_directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| {
            native_error(
                "host_capture_save",
                "Aside's local data directory could not be resolved.",
                true,
            )
        })?
        .join("captures");
    fs::create_dir_all(&capture_directory).map_err(|_| {
        native_error(
            "host_capture_save",
            "The captured context directory could not be created.",
            true,
        )
    })?;
    Ok(capture_directory.join(format!("{capture_id}.json")))
}

struct SavedCapture {
    path: String,
    formatted_json: String,
}

fn save_capture_file(
    app: &AppHandle,
    attachment: &crate::context::AsideHostAttachment,
) -> Result<SavedCapture, NativeError> {
    let path = capture_file_path(app, &attachment.id)?;
    let value = serde_json::to_value(attachment).map_err(|_| {
        native_error(
            "host_capture_save",
            "The captured context could not be encoded as JSON.",
            true,
        )
    })?;
    let mut formatted_json = format_json(&value, 0, None);
    formatted_json.push('\n');
    fs::write(&path, formatted_json.as_bytes()).map_err(|error| {
        let message = match error.kind() {
            io::ErrorKind::PermissionDenied => {
                "The captured JSON file could not be written because access was denied."
            }
            _ => "The captured JSON file could not be written.",
        };
        native_error("host_capture_save", message, true)
    })?;
    Ok(SavedCapture {
        path: path.to_string_lossy().into_owned(),
        formatted_json,
    })
}

fn format_json(value: &serde_json::Value, level: usize, key: Option<&str>) -> String {
    match value {
        serde_json::Value::Array(values) => {
            if values.is_empty() {
                return "[]".to_string();
            }
            if key == Some("fields") {
                return serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string());
            }

            let indent = "  ".repeat(level);
            let child_indent = "  ".repeat(level + 1);
            if key == Some("nodes") {
                let nodes = values
                    .iter()
                    .map(|node| {
                        format!(
                            "{}{}",
                            child_indent,
                            serde_json::to_string(node).unwrap_or_else(|_| "null".to_string())
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",\n");
                return format!("[\n{nodes}\n{indent}]");
            }

            let items = values
                .iter()
                .map(|item| format!("{}{}", child_indent, format_json(item, level + 1, None)))
                .collect::<Vec<_>>()
                .join(",\n");
            format!("[\n{items}\n{indent}]")
        }
        serde_json::Value::Object(entries) => {
            if entries.is_empty() {
                return "{}".to_string();
            }

            let indent = "  ".repeat(level);
            let child_indent = "  ".repeat(level + 1);
            let fields = entries
                .iter()
                .map(|(entry_key, entry_value)| {
                    format!(
                        "{}{}: {}",
                        child_indent,
                        serde_json::to_string(entry_key).unwrap_or_else(|_| "\"\"".to_string()),
                        format_json(entry_value, level + 1, Some(entry_key.as_str()))
                    )
                })
                .collect::<Vec<_>>()
                .join(",\n");
            format!("{{\n{fields}\n{indent}}}")
        }
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

fn capture_with_artifact(app: &AppHandle, result: HostCaptureResult) -> HostCaptureResponse {
    let saved = result.attachment.as_ref().and_then(|attachment| {
        match save_capture_file(app, attachment) {
            Ok(saved) => Some(saved),
            Err(error) => {
                emit_error(app, error);
                None
            }
        }
    });
    HostCaptureResponse {
        result,
        file_path: saved.as_ref().map(|capture| capture.path.clone()),
        formatted_json: saved.map(|capture| capture.formatted_json),
    }
}

fn emit_host_capture(app: &AppHandle, result: HostCaptureResponse) {
    let _ = app.emit(HOST_CAPTURE_EVENT, result);
}

#[tauri::command]
pub fn get_agent_state(state: State<'_, AppState>) -> Result<AgentState, NativeError> {
    Ok(lock_native(&state)?.snapshot())
}

#[tauri::command]
pub fn show_agent(app: AppHandle, state: State<'_, AppState>) -> Result<AgentState, NativeError> {
    let _operation = lock_operation(&state)?;
    show_agent_locked(&app, &state)
}

#[tauri::command]
pub fn hide_agent(app: AppHandle, state: State<'_, AppState>) -> Result<AgentState, NativeError> {
    hide_agent_internal(&app, &state)
}

#[tauri::command]
pub fn toggle_agent(app: AppHandle, state: State<'_, AppState>) -> Result<AgentState, NativeError> {
    toggle_agent_internal(&app, state.inner())
}

#[tauri::command]
pub fn set_pinned(
    app: AppHandle,
    state: State<'_, AppState>,
    pinned: bool,
) -> Result<AgentState, NativeError> {
    let _operation = lock_operation(&state)?;
    let window = agent_window(&app)?;
    window
        .set_always_on_top(pinned)
        .map_err(|_| native_error("pin", "Aside could not change its Pin state.", true))?;
    lock_native(&state)?.pinned = pinned;
    emit_state(&app, &state)
}

#[tauri::command]
pub fn enter_workspace_mode(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentState, NativeError> {
    let _operation = lock_operation(&state)?;
    if matches!(lock_native(&state)?.visibility, Visibility::Hidden) {
        return show_agent_locked(&app, &state);
    }
    emit_state(&app, &state)
}

#[tauri::command]
pub fn exit_workspace_mode(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentState, NativeError> {
    let _operation = lock_operation(&state)?;
    let snapshot = lock_native(&state)?.workspace.clone();
    let side_work_area = snapshot.as_ref().map(|snapshot| snapshot.target.work_area);
    if let Some(snapshot) = snapshot {
        if let Err(error) = platform::restore_target(&snapshot.target) {
            emit_error(
                &app,
                native_error("workspace_restore", error.to_string(), true),
            );
        }
        lock_native(&state)?.workspace = None;
    }
    if matches!(lock_native(&state)?.visibility, Visibility::Visible) {
        let window = agent_window(&app)?;
        let work_area = match side_work_area {
            Some(work_area) => work_area,
            None => work_area_from_tauri(&window)?,
        };
        set_side_bounds(&window, work_area)?;
    }
    lock_native(&state)?.surface = Surface::Side;
    emit_state(&app, &state)
}

#[tauri::command]
pub fn get_active_window_state() -> Result<Option<WindowContext>, NativeError> {
    Ok(platform::foreground_target().as_ref().map(public_context))
}

#[tauri::command]
pub fn get_active_host() -> Result<HostView, NativeError> {
    Ok(context::classify_foreground_host())
}

#[tauri::command]
pub fn capture_active_host_context(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<HostCaptureResponse, NativeError> {
    let _operation = lock_operation(&state)?;
    let workspace_target = lock_native(&state)?
        .workspace
        .as_ref()
        .map(|snapshot| snapshot.target.clone());

    if let Some(target) = workspace_target {
        return Ok(capture_with_artifact(
            &app,
            context::capture_target_context(HostTargetSnapshot::from_target(target)),
        ));
    }

    let was_visible = matches!(lock_native(&state)?.visibility, Visibility::Visible);
    if was_visible {
        hide_agent_locked(&app, state.inner())?;
    }

    let result = context::capture_foreground_context();

    if was_visible {
        if let Err(error) = show_agent_locked(&app, &state) {
            emit_error(
                &app,
                native_error("show_agent", error.message, error.recoverable),
            );
        }
    }

    Ok(capture_with_artifact(&app, result))
}

#[tauri::command]
pub fn get_workspace_state(state: State<'_, AppState>) -> Result<WorkspaceState, NativeError> {
    Ok(WorkspaceState {
        active: lock_native(&state)?.workspace.is_some(),
    })
}

#[tauri::command]
pub fn move_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    x: i32,
    y: i32,
) -> Result<AgentState, NativeError> {
    let _operation = lock_operation(&state)?;
    agent_window(&app)?
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|_| native_error("move_agent", "Aside could not be moved.", true))?;
    emit_state(&app, &state)
}

#[tauri::command]
pub fn resize_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    width: u32,
    height: u32,
) -> Result<AgentState, NativeError> {
    let _operation = lock_operation(&state)?;
    let width = width.clamp(
        workspace::MIN_PANEL_WIDTH as u32,
        workspace::MAX_PANEL_WIDTH as u32,
    );
    let height = height.clamp(
        workspace::MIN_PANEL_HEIGHT as u32,
        workspace::MAX_PANEL_HEIGHT as u32,
    );
    agent_window(&app)?
        .set_size(PhysicalSize::new(width, height))
        .map_err(|_| native_error("resize_agent", "Aside could not be resized.", true))?;
    emit_state(&app, &state)
}

#[tauri::command]
pub fn runtime_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    text: String,
    context: Option<AsideTurnContext>,
) -> Result<(), NativeError> {
    if request_id.is_empty()
        || request_id.len() > 128
        || text.trim().is_empty()
        || text.len() > 20_000
    {
        return Err(native_error(
            "conversation",
            "The message could not be sent because its input was invalid.",
            true,
        ));
    }
    state
        .runtime
        .send(
            &app,
            RuntimeRequest::Prompt {
                request_id,
                text,
                context,
            },
        )
        .map_err(|message| native_error("conversation", message, true))
}

#[tauri::command]
pub fn runtime_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), NativeError> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err(native_error(
            "conversation_cancel",
            "The conversation request could not be cancelled.",
            true,
        ));
    }
    state
        .runtime
        .send(&app, RuntimeRequest::Cancel { request_id })
        .map_err(|message| native_error("conversation_cancel", message, true))
}

#[cfg(test)]
mod tests {
    use super::format_json;
    use serde_json::json;

    #[test]
    fn capture_json_keeps_nodes_compact_and_round_trippable() {
        let value = json!({
            "blocks": [{
                "type": "json",
                "data": {
                    "fields": ["role", "name", "bounds"],
                    "nodes": [
                        ["document", "GitHub", {"x": 1, "y": 2}],
                        ["link", "Issues", {"x": 3, "y": 4}]
                    ]
                }
            }]
        });

        let rendered = format_json(&value, 0, None);
        let parsed: serde_json::Value = serde_json::from_str(&rendered).expect("valid JSON");
        assert_eq!(parsed, value);

        let node_lines: Vec<&str> = rendered
            .lines()
            .filter(|line| line.contains("[\"document\"") || line.contains("[\"link\""))
            .collect();
        assert_eq!(node_lines.len(), 2);
        assert!(node_lines
            .iter()
            .all(|line| line.trim_end().ends_with("],") || line.trim_end().ends_with(']')));
        assert!(rendered.contains("\"fields\": [\"role\",\"name\",\"bounds\"]"));
    }
}
