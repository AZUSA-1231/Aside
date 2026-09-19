use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
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
    fn runtime_path(app: &AppHandle) -> PathBuf {
        resolve_runtime_path(
            std::env::var_os("ASIDE_RUNTIME_PATH").map(PathBuf::from),
            resource_root(app).as_deref(),
            Path::new(env!("CARGO_MANIFEST_DIR")),
        )
    }

    fn node_command(app: &AppHandle) -> PathBuf {
        resolve_node_path(
            std::env::var_os("ASIDE_NODE_PATH").map(PathBuf::from),
            resource_root(app).as_deref(),
        )
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
        let mut child = Command::new(&node)
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

#[cfg(test)]
mod tests {
    use super::*;

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
