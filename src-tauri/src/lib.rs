mod chromium_uia;
mod commands;
mod context;
mod explorer_shell;
mod file_hosts;
mod generic_uia;
mod path;
mod platform;
mod runtime;
mod uia;
mod workspace;

use commands::AppState;
use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("CommandOrControl+Alt+A")
                .expect("invalid Ctrl + Alt + A shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }

                    let app_handle = app.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        commands::toggle_agent_from_shortcut(&app_handle);
                    }) {
                        eprintln!("Aside could not dispatch Ctrl + Alt + A: {error}");
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let state = window.state::<AppState>();
                let _ = commands::hide_agent_internal(window.app_handle(), state.inner());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_agent_state,
            commands::show_agent,
            commands::hide_agent,
            commands::toggle_agent,
            commands::set_pinned,
            commands::enter_workspace_mode,
            commands::exit_workspace_mode,
            commands::get_active_window_state,
            commands::get_active_host,
            commands::capture_active_host_context,
            commands::get_workspace_state,
            commands::move_agent,
            commands::resize_agent,
            commands::runtime_prompt,
            commands::runtime_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aside");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            app_handle.state::<AppState>().runtime.shutdown();
        }
    });
}
