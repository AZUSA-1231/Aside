use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub use crate::context::AsideTurnContext;

pub const RUNTIME_EVENT: &str = "runtime://event";

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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuntimeHistoryMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub status: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEvent {
    Ready {
        provider: String,
        model: String,
    },
    RunStarted {
        request_id: String,
    },
    TextDelta {
        request_id: String,
        delta: String,
    },
    Completed {
        request_id: String,
    },
    Cancelled {
        request_id: String,
    },
    Failed {
        request_id: String,
        message: String,
        retryable: bool,
    },
    SessionWarning {
        request_id: Option<String>,
        message: String,
    },
    HistoryRestored {
        messages: Vec<RuntimeHistoryMessage>,
    },
    RuntimeUnavailable {
        message: String,
    },
}

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
                RuntimeEvent::RuntimeUnavailable {
                    message: "The Aside runtime stopped unexpectedly.".into(),
                },
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
