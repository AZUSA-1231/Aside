use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

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
    ApplySettings {
        credential_values: serde_json::Value,
    },
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

/// Where the staged runtime and the bundled Node live inside a bundle.
///
/// The staged tree is copied in by `scripts/stage-runtime.mjs`, which lays out:
///
/// ```text
/// <resources>/runtime/src/*.mjs        the Aside runtime
/// <resources>/runtime/skills/*         bundled skills
/// <resources>/runtime/node_modules/*   its dependency closure
/// <resources>/node/node.exe            the bundled Node
/// ```
///
/// `src/` is a sibling of `node_modules/` on purpose: Node resolves bare
/// specifiers by walking up from the importing file, so a runtime at
/// `runtime/src/protocol.mjs` finds `runtime/node_modules` without any
/// resolution hook or `NODE_PATH`.
const RUNTIME_RESOURCE_DIR: &str = "runtime";
const NODE_RESOURCE_DIR: &str = "node";

/// The bundled resource directory, or `None` in a development build.
///
/// `None` is the ordinary case under `tauri dev` and under `cargo test`, where
/// no bundle has been staged. Callers fall back to the source tree rather than
/// failing, so development does not require running the staging script first.
fn resource_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

/// The bundled Node executable name for this platform.
fn bundled_node_relative_path() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(NODE_RESOURCE_DIR).join("node.exe")
    } else {
        PathBuf::from(NODE_RESOURCE_DIR).join("bin").join("node")
    }
}

/// Resolves the runtime entry point.
///
/// Order: explicit override, then the installed bundle, then the source tree.
/// The override stays first so a developer can point a packaged build at a
/// working tree, which is a recovery path and not a normal installation
/// requirement.
fn resolve_runtime_path(
    override_path: Option<PathBuf>,
    resources: Option<&Path>,
    manifest_dir: &Path,
) -> PathBuf {
    if let Some(path) = override_path {
        return path;
    }
    if let Some(root) = resources {
        let packaged = root
            .join(RUNTIME_RESOURCE_DIR)
            .join("src")
            .join("protocol.mjs");
        if packaged.is_file() {
            return packaged;
        }
    }
    manifest_dir
        .join("..")
        .join("agent-runtime")
        .join("src")
        .join("protocol.mjs")
}

/// Resolves the Node executable.
///
/// Order: explicit override, then the bundled binary, then `node` from `PATH`.
///
/// The `PATH` fallback is deliberate and is not a packaging shortcut. A bundle
/// that is missing its Node should fail with a message naming the expected
/// location, and on a machine that happens to have a usable Node it is better
/// to start than to refuse — the version check in the runtime itself is what
/// decides whether the Node found is good enough.
fn resolve_node_path(override_path: Option<PathBuf>, resources: Option<&Path>) -> PathBuf {
    if let Some(path) = override_path {
        return path;
    }
    if let Some(root) = resources {
        let bundled = root.join(bundled_node_relative_path());
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from("node")
}

struct RuntimeProcess {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

#[derive(Default)]
struct RuntimeConfiguration {
    generation: u64,
    running: bool,
    unavailable: bool,
    revision: Option<String>,
    apply_state: Option<String>,
    apply_error: Option<String>,
}

impl RuntimeConfiguration {
    fn start(&mut self) -> u64 {
        self.generation += 1;
        self.running = true;
        self.unavailable = false;
        self.revision = None;
        self.apply_state = None;
        self.apply_error = None;
        self.generation
    }

    fn observe(&mut self, generation: u64, event: &RuntimeEvent) -> bool {
        if generation != self.generation || !self.running {
            return false;
        }
        if event.get("type").and_then(serde_json::Value::as_str) == Some("ready") {
            self.unavailable = false;
            self.revision = event
                .get("configuration_revision")
                .and_then(serde_json::Value::as_str)
                .filter(|revision| {
                    revision.len() == 64
                        && revision
                            .bytes()
                            .all(|character| character.is_ascii_hexdigit())
                })
                .map(str::to_owned);
        }
        if event.get("type").and_then(serde_json::Value::as_str) == Some("runtime_unavailable") {
            self.unavailable = true;
        }
        if event["type"] == "configuration_status" {
            self.apply_state = event["state"].as_str().map(str::to_owned);
            self.apply_error = if event["state"] == "failed" {
                Some("The saved configuration could not be applied. Check provider, model and endpoint settings.".into())
            } else {
                None
            };
        }
        true
    }

    fn snapshot(&self, effective_revision: &str) -> serde_json::Value {
        let status = if self.generation == 0 {
            "not_started"
        } else if !self.running || self.unavailable {
            "unavailable"
        } else if self.apply_state.as_deref() == Some("applying") {
            "applying"
        } else if self.apply_state.as_deref() == Some("pending") {
            "pending"
        } else if let Some(revision) = &self.revision {
            if revision == effective_revision {
                "loaded"
            } else {
                "pending"
            }
        } else {
            "starting"
        };
        serde_json::json!({
            "state": status,
            "loaded_revision": self.revision,
            "mode": "idle_rebuild",
            "last_apply_error": self.apply_error,
        })
    }
}

pub struct RuntimeManager {
    process: Mutex<RuntimeProcess>,
    configuration: Arc<Mutex<RuntimeConfiguration>>,
}

impl Default for RuntimeManager {
    fn default() -> Self {
        Self {
            process: Mutex::new(RuntimeProcess {
                child: None,
                stdin: None,
            }),
            configuration: Arc::new(Mutex::new(RuntimeConfiguration::default())),
        }
    }
}

impl RuntimeManager {
    fn runtime_path(app: &AppHandle) -> PathBuf {
        resolve_runtime_path(
            std::env::var_os("ASIDE_RUNTIME_PATH").map(PathBuf::from),
            resource_root(app).as_deref(),
            Path::new(env!("CARGO_MANIFEST_DIR")),
        )
    }

    pub(crate) fn node_command(app: &AppHandle) -> PathBuf {
        resolve_node_path(
            std::env::var_os("ASIDE_NODE_PATH").map(PathBuf::from),
            resource_root(app).as_deref(),
        )
    }

    pub(crate) fn settings_control_path(app: &AppHandle) -> PathBuf {
        Self::runtime_path(app).with_file_name("settings-control.mjs")
    }

    pub fn configuration_state(&self, effective_revision: &str) -> serde_json::Value {
        self.configuration.lock()
            .map(|configuration| configuration.snapshot(effective_revision))
            .unwrap_or_else(|_| serde_json::json!({ "state": "unavailable", "loaded_revision": null, "mode": "idle_rebuild" }))
    }

    fn start_locked(&self, app: &AppHandle, process: &mut RuntimeProcess) -> Result<(), String> {
        let runtime_path = Self::runtime_path(app);
        if !runtime_path.is_file() {
            return Err(format!(
                "Aside's runtime was not found at {}. The installation may be incomplete.",
                runtime_path.display()
            ));
        }

        let node = Self::node_command(app);
        let mut command = Command::new(&node);
        crate::settings::configure_workspace(
            &mut command,
            crate::settings::default_workspace(app).as_deref(),
        );
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .arg(&runtime_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                // Naming the resolved path is the difference between a
                // diagnosable failure and a mystery: "the bundled runtime is
                // missing" and "the user's Node is too old" look identical to a
                // generic message.
                format!(
                    "Node.js could not be started from {}. {}",
                    node.display(),
                    error
                )
            })?;
        let mut stdin = match child.stdin.take() {
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

        let initialization = crate::credentials::read_api_keys()
            .map(|keys| {
                serde_json::json!({ "type": "initialize", "credential_values": keys }).to_string()
            })
            .map_err(str::to_owned)
            .and_then(|message| {
                stdin
                    .write_all(format!("{message}\n").as_bytes())
                    .map_err(|_| {
                        "Aside could not initialize its private configuration channel.".to_string()
                    })
            });
        if let Err(error) = initialization {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }

        let generation = match self.configuration.lock() {
            Ok(mut configuration) => configuration.start(),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The Aside runtime configuration state is unavailable.".to_string());
            }
        };
        let configuration = Arc::clone(&self.configuration);
        let app_handle = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(event) = serde_json::from_str::<RuntimeEvent>(&line) {
                    let current = configuration
                        .lock()
                        .map(|mut state| state.observe(generation, &event))
                        .unwrap_or(false);
                    if current {
                        let _ = app_handle.emit(RUNTIME_EVENT, event);
                    }
                }
            }
            let current = configuration
                .lock()
                .map(|mut state| {
                    if state.generation != generation || !state.running {
                        return false;
                    }
                    state.running = false;
                    true
                })
                .unwrap_or(false);
            if !current {
                return;
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
        if process
            .child
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .flatten()
            .is_some()
        {
            process.stdin = None;
            process.child = None;
        }
        if process.stdin.is_none() {
            self.start_locked(app, &mut process)?;
            if matches!(request, RuntimeRequest::ApplySettings { .. }) {
                return Ok(());
            }
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
            if let Ok(mut configuration) = self.configuration.lock() {
                configuration.running = false;
            }
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
            if let Ok(mut configuration) = self.configuration.lock() {
                configuration.running = false;
            }
            process.stdin = None;
            if let Some(mut child) = process.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_state_tracks_queue_completion_and_retained_revision_after_failure() {
        let mut state = RuntimeConfiguration::default();
        let generation = state.start();
        let old = "a".repeat(64);
        let new = "b".repeat(64);
        state.observe(
            generation,
            &serde_json::json!({ "type": "ready", "configuration_revision": old }),
        );
        state.observe(
            generation,
            &serde_json::json!({ "type": "configuration_status", "state": "pending" }),
        );
        assert_eq!(state.snapshot(&new)["state"], "pending");
        state.observe(
            generation,
            &serde_json::json!({ "type": "configuration_status", "state": "applying" }),
        );
        assert_eq!(state.snapshot(&new)["state"], "applying");
        state.observe(generation, &serde_json::json!({ "type": "configuration_status", "state": "failed", "message": "private-error" }));
        assert_eq!(state.snapshot(&new)["loaded_revision"], old);
        assert!(!state.snapshot(&new).to_string().contains("private-error"));
        state.observe(
            generation,
            &serde_json::json!({ "type": "ready", "configuration_revision": new }),
        );
        state.observe(
            generation,
            &serde_json::json!({ "type": "configuration_status", "state": "applied" }),
        );
        assert_eq!(state.snapshot(&new)["state"], "loaded");
        assert!(state.snapshot(&new)["last_apply_error"].is_null());
    }

    #[test]
    fn configuration_reports_actual_loaded_and_pending_revisions() {
        let mut state = RuntimeConfiguration::default();
        let revision = "a".repeat(64);
        assert_eq!(state.snapshot(&revision)["state"], "not_started");
        let generation = state.start();
        assert_eq!(state.snapshot(&revision)["state"], "starting");
        assert!(state.observe(
            generation,
            &serde_json::json!({ "type": "ready", "configuration_revision": revision })
        ));
        assert_eq!(state.snapshot(&revision)["state"], "loaded");
        assert_eq!(state.snapshot(&"b".repeat(64))["state"], "pending");
        state.running = false;
        assert_eq!(state.snapshot(&revision)["state"], "unavailable");
    }

    #[test]
    fn obsolete_runtime_events_cannot_mark_a_new_configuration_loaded() {
        let mut state = RuntimeConfiguration::default();
        let old = state.start();
        let current = state.start();
        let event =
            serde_json::json!({ "type": "ready", "configuration_revision": "a".repeat(64) });
        assert!(!state.observe(old, &event));
        assert_eq!(state.snapshot(&"a".repeat(64))["state"], "starting");
        assert!(state.observe(current, &event));
        assert_eq!(state.snapshot(&"a".repeat(64))["state"], "loaded");
    }

    #[test]
    fn startup_failure_is_unavailable_and_does_not_hide_recoverable_errors() {
        let mut state = RuntimeConfiguration::default();
        let generation = state.start();
        assert!(state.observe(generation, &serde_json::json!({ "type": "runtime_unavailable", "message": "Invalid configuration." })));
        assert_eq!(state.snapshot(&"a".repeat(64))["state"], "unavailable");
        assert!(state.observe(
            generation,
            &serde_json::json!({ "type": "failed", "request_id": "retry", "retryable": true })
        ));
    }

    /// A unique scratch directory. Created lazily so a test that never writes
    /// does not leave one behind.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aside-runtime-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn stage_runtime(resources: &Path) -> PathBuf {
        let entry = resources
            .join(RUNTIME_RESOURCE_DIR)
            .join("src")
            .join("protocol.mjs");
        std::fs::create_dir_all(entry.parent().expect("parent")).expect("runtime src dir");
        std::fs::write(&entry, "// staged").expect("write entry");
        entry
    }

    fn stage_node(resources: &Path) -> PathBuf {
        let node = resources.join(bundled_node_relative_path());
        std::fs::create_dir_all(node.parent().expect("parent")).expect("node dir");
        std::fs::write(&node, "binary").expect("write node");
        node
    }

    #[test]
    fn runtime_override_outranks_the_installed_bundle() {
        let resources = scratch("override-runtime");
        stage_runtime(&resources);
        let override_path = PathBuf::from(r"C:\elsewhere\protocol.mjs");

        let resolved = resolve_runtime_path(
            Some(override_path.clone()),
            Some(resources.as_path()),
            Path::new(r"C:\manifest"),
        );

        assert_eq!(resolved, override_path);
    }

    #[test]
    fn runtime_resolves_inside_the_installed_bundle() {
        let resources = scratch("installed-runtime");
        let staged = stage_runtime(&resources);

        let resolved =
            resolve_runtime_path(None, Some(resources.as_path()), Path::new(r"C:\manifest"));

        // The packaged path must win over the source tree; otherwise an
        // installed build would depend on a directory that is not shipped.
        assert_eq!(resolved, staged);
    }

    #[test]
    fn runtime_falls_back_to_the_source_tree_for_development() {
        // No resources at all, as under `tauri dev` and `cargo test`.
        let resolved = resolve_runtime_path(None, None, Path::new(r"C:\manifest"));

        assert!(resolved.ends_with("protocol.mjs"));
        assert!(resolved.starts_with(r"C:\manifest"));
    }

    #[test]
    fn runtime_falls_back_when_the_bundle_is_incomplete() {
        // A resource directory that exists but does not contain the runtime is
        // the failure an incomplete installation produces. Falling back keeps
        // development working; the caller still reports honestly if the
        // fallback is also missing.
        let resources = scratch("incomplete-runtime");

        let resolved =
            resolve_runtime_path(None, Some(resources.as_path()), Path::new(r"C:\manifest"));

        assert!(resolved.starts_with(r"C:\manifest"));
    }

    #[test]
    fn node_override_outranks_the_bundled_binary() {
        let resources = scratch("override-node");
        stage_node(&resources);

        let resolved = resolve_node_path(
            Some(PathBuf::from(r"C:\elsewhere\node.exe")),
            Some(resources.as_path()),
        );

        assert_eq!(resolved, PathBuf::from(r"C:\elsewhere\node.exe"));
    }

    #[test]
    fn node_resolves_to_the_bundled_binary() {
        let resources = scratch("bundled-node");
        let staged = stage_node(&resources);

        let resolved = resolve_node_path(None, Some(resources.as_path()));

        assert_eq!(resolved, staged);
    }

    #[test]
    fn node_falls_back_to_path_when_nothing_is_bundled() {
        let resources = scratch("bare-node");

        let resolved = resolve_node_path(None, Some(resources.as_path()));

        // A bare name, resolved by the OS against PATH. Refusing instead would
        // turn a usable machine into a broken installation; the runtime's own
        // version check is what decides whether the Node found is good enough.
        assert_eq!(resolved, PathBuf::from("node"));
    }
}
