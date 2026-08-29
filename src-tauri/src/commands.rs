use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

use crate::platform::{self, Rect, TargetWindow};
use crate::runtime::{RuntimeManager, RuntimeRequest};
use crate::workspace::{self, WorkspaceSnapshot};

pub const AGENT_STATE_EVENT: &str = "agent://state-changed";
pub const NATIVE_ERROR_EVENT: &str = "agent://error";

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
    Floating,
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
    let mut surface = Surface::Floating;
    let mut snapshot = None;

    if let Some(target) = foreground.filter(TargetWindow::is_workspace_candidate) {
        let layout = workspace::workspace_layout(target.work_area);
        let candidate_snapshot = WorkspaceSnapshot::new(target.clone());
        let mut workspace_ready = platform::tile_target(&target, layout.target).is_ok();

        if workspace_ready {
            if let Err(error) = set_agent_bounds(&window, layout.agent) {
                let _ = platform::restore_target(&target);
                emit_error(
                    app,
                    native_error(
                        "workspace",
                        format!("Workspace Mode was unavailable: {}", error.message),
                        true,
                    ),
                );
                workspace_ready = false;
            }
        } else {
            emit_error(
                app,
                native_error(
                    "workspace",
                    "The foreground application could not be resized safely.",
                    true,
                ),
            );
        }

        if workspace_ready {
            surface = Surface::Workspace;
            snapshot = Some(candidate_snapshot);
        } else if let Err(error) = set_agent_bounds(&window, workspace::floating_layout(work_area))
        {
            return Err(native_error(
                "show_agent",
                format!("Aside could not open: {}", error.message),
                true,
            ));
        }
    } else {
        set_agent_bounds(&window, workspace::floating_layout(work_area))?;
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
        native.surface = Surface::Floating;
    }

    let window = agent_window(app)?;
    window
        .hide()
        .map_err(|_| native_error("hide_agent", "Aside could not be hidden.", true))?;
    lock_native(state)?.visibility = Visibility::Hidden;
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
    if let Err(error) = toggle_agent_internal(app, state.inner()) {
        emit_error(app, error);
    }
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
        set_agent_bounds(
            &window,
            workspace::floating_layout(work_area_from_tauri(&window)?),
        )?;
    }
    lock_native(&state)?.surface = Surface::Floating;
    emit_state(&app, &state)
}

#[tauri::command]
pub fn get_active_window_state() -> Result<Option<WindowContext>, NativeError> {
    Ok(platform::foreground_target().as_ref().map(public_context))
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
        .send(&app, RuntimeRequest::Prompt { request_id, text })
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
