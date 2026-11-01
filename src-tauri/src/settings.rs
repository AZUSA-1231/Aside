use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::commands::AppState;
use crate::runtime::RuntimeManager;

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: u64 = 256 * 1024;

#[derive(Default)]
pub struct SettingsManager {
    operation: Mutex<()>,
}

#[derive(Debug, Serialize)]
pub struct SettingsCommandError {
    operation: &'static str,
    code: String,
    message: String,
    recoverable: bool,
}

fn failure(code: &str, message: &str) -> SettingsCommandError {
    SettingsCommandError {
        operation: "settings",
        code: code.into(),
        message: message.into(),
        recoverable: true,
    }
}

fn decode_response(bytes: &[u8]) -> Result<Value, SettingsCommandError> {
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(failure(
            "settings_invalid_response",
            "The settings response exceeds its supported size.",
        ));
    }
    let response: Value = serde_json::from_slice(bytes).map_err(|_| {
        failure(
            "settings_invalid_response",
            "Aside received an invalid settings response.",
        )
    })?;
    if response["ok"] == true && response["settings"].is_object() {
        return Ok(response["settings"].clone());
    }
    let code = response["error"]["code"]
        .as_str()
        .filter(|code| {
            code.len() <= 64
                && code
                    .bytes()
                    .all(|character| character.is_ascii_alphanumeric() || character == b'_')
        })
        .unwrap_or("settings_unavailable");
    let message = response["error"]["message"]
        .as_str()
        .filter(|message| message.len() <= 1024)
        .unwrap_or("Aside could not complete the settings operation.");
    Err(failure(code, message))
}

fn run_control(node: &Path, helper: &Path, request: &Value) -> Result<Value, SettingsCommandError> {
    if !helper.is_file() {
        return Err(failure(
            "settings_helper_missing",
            "Aside's settings helper is missing from the runtime installation.",
        ));
    }
    let payload = serde_json::to_vec(request).map_err(|_| {
        failure(
            "settings_invalid_request",
            "The settings request could not be encoded.",
        )
    })?;
    if payload.len() > MAX_REQUEST_BYTES {
        return Err(failure(
            "settings_request_too_large",
            "The settings request is too large.",
        ));
    }
    let mut command = Command::new(node);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .arg(helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            failure(
                "settings_start_failed",
                "Aside could not start its settings helper. Check the Node installation.",
            )
        })?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(failure(
                "settings_unavailable",
                "The settings response stream is unavailable.",
            ));
        }
    };
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let sent = child
        .stdin
        .take()
        .ok_or_else(|| {
            failure(
                "settings_unavailable",
                "The settings input stream is unavailable.",
            )
        })
        .and_then(|mut stdin| {
            stdin.write_all(&payload).map_err(|_| {
                failure(
                    "settings_unavailable",
                    "The settings helper did not accept its request.",
                )
            })
        });
    let timeout = if request["operation"] == "test_connection" {
        25
    } else {
        10
    };
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let completion =
        if let Err(error) = sent {
            Err(error)
        } else {
            loop {
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => break Ok(()),
                    Ok(Some(_)) => {
                        break Err(failure(
                            "settings_unavailable",
                            "The settings helper stopped before completing its request.",
                        ))
                    }
                    Err(_) => {
                        break Err(failure(
                            "settings_unavailable",
                            "The settings helper status is unavailable.",
                        ))
                    }
                    Ok(None) if Instant::now() >= deadline => break Err(failure(
                        "settings_timeout",
                        "The settings operation timed out. Reload settings before retrying a save.",
                    )),
                    Ok(None) => thread::sleep(Duration::from_millis(10)),
                }
            }
        };
    if completion.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let bytes = reader
        .join()
        .map_err(|_| {
            failure(
                "settings_unavailable",
                "The settings response could not be read.",
            )
        })?
        .map_err(|_| {
            failure(
                "settings_unavailable",
                "The settings response could not be read.",
            )
        })?;
    completion?;
    decode_response(&bytes)
}

async fn execute(app: AppHandle, mut request: Value) -> Result<Value, SettingsCommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let manager = app.state::<SettingsManager>();
        let _operation = manager.operation.lock().map_err(|_| {
            failure(
                "settings_unavailable",
                "Aside's settings state is unavailable.",
            )
        })?;
        let (keys, credential_errors) = if request["operation"] == "catalog" {
            (json!({}), Vec::new())
        } else if request["operation"] == "test_connection" {
            (crate::credentials::read_api_keys().map_err(|message| failure("credential_store_unavailable", message))?, Vec::new())
        } else { crate::credentials::read_api_keys_status() };
        request["credential_values"] = keys;
        let mut settings = run_control(
            &RuntimeManager::node_command(&app),
            &RuntimeManager::settings_control_path(&app),
            &request,
        )?;
        if request["operation"] == "catalog" || request["operation"] == "test_connection" {
            return Ok(settings);
        }
        for provider in credential_errors {
            settings["credentials"][provider]["storage_error"] = json!(true);
            settings["credentials"][provider]["stored"] = json!(true);
            if let Some(diagnostics) = settings["diagnostics"].as_array_mut() {
                diagnostics.push(json!({ "code": format!("credential_store_{provider}"), "field": "credential", "message": format!("Windows could not read the {provider} credential. Replace or remove its stored key before applying or testing.") }));
            }
        }
        let revision = settings["effective_revision"].as_str().unwrap_or_default();
        let application = app
            .state::<AppState>()
            .runtime
            .configuration_state(revision);
        settings["application"] = application;
        Ok(settings)
    })
    .await
    .map_err(|_| {
        failure(
            "settings_unavailable",
            "The settings operation could not be completed.",
        )
    })?
}

#[tauri::command]
pub async fn set_api_key(
    app: AppHandle,
    provider: String,
    key: Option<String>,
) -> Result<Value, SettingsCommandError> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<SettingsManager>();
        let _operation = manager.operation.lock().map_err(|_| {
            failure(
                "settings_unavailable",
                "Aside's settings state is unavailable.",
            )
        })?;
        crate::credentials::write_api_key(&provider, key.as_deref())
            .map_err(|message| failure("credential_write_failed", message))
    })
    .await
    .map_err(|_| {
        failure(
            "credential_write_failed",
            "The credential operation could not be completed.",
        )
    })??;
    get_settings(app).await
}

#[tauri::command]
pub async fn get_provider_catalog(
    app: AppHandle,
    provider: String,
) -> Result<Value, SettingsCommandError> {
    crate::credentials::validate_provider(&provider)
        .map_err(|message| failure("settings_invalid_provider", message))?;
    execute(app, json!({ "operation": "catalog", "provider": provider })).await
}

#[tauri::command]
pub async fn test_api_connection(app: AppHandle) -> Result<Value, SettingsCommandError> {
    execute(app, json!({ "operation": "test_connection" })).await
}

#[tauri::command]
pub async fn apply_settings(app: AppHandle) -> Result<Value, SettingsCommandError> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let keys = crate::credentials::read_api_keys().map_err(|message| failure("credential_store_unavailable", message))?;
        handle.state::<AppState>().runtime.send(&handle, crate::runtime::RuntimeRequest::ApplySettings { credential_values: keys })
            .map_err(|_| failure("settings_apply_failed", "Aside could not request configuration application. Try again or restart Aside."))
    }).await.map_err(|_| failure("settings_apply_failed", "The application request could not be completed."))??;
    get_settings(app).await
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<Value, SettingsCommandError> {
    execute(app, json!({ "operation": "get" })).await
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    document: Value,
    expected_revision: String,
) -> Result<Value, SettingsCommandError> {
    execute(app, json!({ "operation": "save", "document": document, "expected_revision": expected_revision })).await
}

#[tauri::command]
pub async fn import_legacy_settings(
    app: AppHandle,
    expected_revision: String,
) -> Result<Value, SettingsCommandError> {
    execute(
        app,
        json!({ "operation": "import_legacy", "expected_revision": expected_revision }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_errors_do_not_echo_invalid_helper_output() {
        let error = decode_response(b"invalid private-value").unwrap_err();
        assert_eq!(error.code, "settings_invalid_response");
        assert!(!error.message.contains("private-value"));
        assert_eq!(decode_response(br#"{"ok":false,"error":{"code":"settings_conflict","message":"Reload before saving."}}"#).unwrap_err().code, "settings_conflict");
    }

    #[test]
    fn response_must_contain_a_settings_object() {
        assert!(decode_response(br#"{"ok":true,"settings":null}"#).is_err());
        assert_eq!(
            decode_response(br#"{"ok":true,"settings":{"revision":"missing"}}"#).unwrap()
                ["revision"],
            "missing"
        );
    }

    #[test]
    fn control_process_transfers_payloads_larger_than_a_pipe_buffer() {
        let root = std::env::temp_dir().join(format!("aside-settings-pipe-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let helper = root.join("control.mjs");
        std::fs::write(&helper, "let text = ''; for await (const chunk of process.stdin) text += chunk; process.stdout.write(JSON.stringify({ ok: true, settings: { received: JSON.parse(text) } }));").unwrap();
        let request = json!({ "operation": "save", "payload": "transport-test".repeat(1500) });
        let response = run_control(Path::new("node"), &helper, &request);
        std::fs::remove_file(&helper).unwrap();
        std::fs::remove_dir(&root).unwrap();
        assert_eq!(response.unwrap()["received"], request);
    }
}
