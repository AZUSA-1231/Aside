use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub use crate::context::AsideTurnContext;

pub const RUNTIME_EVENT: &str = "runtime://event";

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    Deny,
    Cancel,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PermissionIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Workspace hint forwarded to the agent runtime for validation and
/// canonicalization. Accepts a path string or a `{ path, kind?, source?,
/// expires_at? }` object; the runtime owns the actual resolution.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum AsideWorkspaceHint {
    Path(String),
    Descriptor {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expires_at: Option<u64>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeRequest {
    Prompt {
        request_id: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<AsideTurnContext>,
    },
    Cancel {
        request_id: String,
    },
    PermissionResponse {
        request_id: String,
        permission_id: String,
        decision: PermissionDecision,
        #[serde(skip_serializing_if = "Option::is_none")]
        identity: Option<PermissionIdentity>,
    },
    SetWorkspace {
        #[serde(skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        workspace: AsideWorkspaceHint,
    },
    ClearWorkspace {
        #[serde(skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
    },
}

/// Runtime events are Aside-owned serialized contracts produced by the agent
/// runtime. Tauri forwards them verbatim to React; the typed request/event
/// vocabulary lives in the JS runtime and the React contracts. Tauri owns
/// process lifecycle and IPC forwarding only, never path authority, provider
/// message construction, tool execution, or permission decisions.
pub type RuntimeEvent = serde_json::Value;

struct RuntimeProcess {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

pub struct RuntimeManager {
    process: Mutex<RuntimeProcess>,
}

impl Default for RuntimeManager {
    fn default() -> Self {
        Self {
            process: Mutex::new(RuntimeProcess {
                child: None,
                stdin: None,
            }),
        }
    }
}

impl RuntimeManager {
    fn runtime_path() -> PathBuf {
        std::env::var_os("ASIDE_RUNTIME_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("agent-runtime")
                    .join("src")
                    .join("protocol.mjs")
            })
    }

    fn node_command() -> String {
        std::env::var("ASIDE_NODE_PATH").unwrap_or_else(|_| "node".to_string())
    }

    fn start_locked(&self, app: &AppHandle, process: &mut RuntimeProcess) -> Result<(), String> {
        let runtime_path = Self::runtime_path();
        if !runtime_path.is_file() {
            return Err(format!(
                "The Aside runtime was not found at {}. Set ASIDE_RUNTIME_PATH for a packaged build.",
                runtime_path.display()
            ));
        }

        let mut child = Command::new(Self::node_command())
            .arg(runtime_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Node.js could not start the Aside runtime.".to_string())?;
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The Aside runtime input could not be opened.".to_string());
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The Aside runtime output could not be opened.".to_string());
            }
        };

        let app_handle = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(event) = serde_json::from_str::<RuntimeEvent>(&line) {
                    let _ = app_handle.emit(RUNTIME_EVENT, event);
                }
            }
            let _ = app_handle.emit(
                RUNTIME_EVENT,
                serde_json::json!({
                    "type": "runtime_unavailable",
                    "message": "The Aside runtime stopped unexpectedly.",
                }),
            );
        });

        process.stdin = Some(stdin);
        process.child = Some(child);
        Ok(())
    }

    pub fn send(&self, app: &AppHandle, request: RuntimeRequest) -> Result<(), String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "The Aside runtime state is unavailable.".to_string())?;
        if process.stdin.is_none() {
            self.start_locked(app, &mut process)?;
        }

        let line = serde_json::to_string(&request)
            .map_err(|_| "The Aside runtime request could not be encoded.".to_string())?;
        let result = process
            .stdin
            .as_mut()
            .ok_or_else(|| "The Aside runtime input is unavailable.".to_string())
            .and_then(|stdin| {
                stdin
                    .write_all(format!("{line}\n").as_bytes())
                    .and_then(|_| stdin.flush())
                    .map_err(|_| "The Aside runtime did not accept the request.".to_string())
            });

        if result.is_err() {
            process.stdin = None;
            if let Some(mut child) = process.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        result
    }

    pub fn shutdown(&self) {
        if let Ok(mut process) = self.process.lock() {
            process.stdin = None;
            if let Some(mut child) = process.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
