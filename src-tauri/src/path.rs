//! Validated, metadata-only path boundary for host locators.
//!
//! A host adapter may discover a path, but this module is the only place that
//! turns that untrusted signal into a descriptor. Canonicalization resolves
//! symlinks and Windows reparse points, so the descriptor names the resolved
//! target rather than preserving an alternate spelling.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::context::{PathDescriptor, PathKind, PathRole};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PathError {
    Invalid,
    Missing,
    WrongType,
    PermissionDenied,
}

pub(crate) fn descriptor_from_path(
    role: PathRole,
    candidate: &str,
    expected_kind: Option<PathKind>,
) -> Result<PathDescriptor, PathError> {
    let canonical = canonicalize_path(candidate)?;
    let kind = path_kind(&canonical)?;
    if expected_kind.is_some_and(|expected| expected != kind) {
        return Err(PathError::WrongType);
    }

    Ok(PathDescriptor {
        role,
        path: serialize_windows_path(&canonical)?,
        kind,
    })
}

pub(crate) fn canonicalize_path(candidate: &str) -> Result<PathBuf, PathError> {
    validate_text(candidate)?;
    if !is_absolute_path(candidate) {
        return Err(PathError::Invalid);
    }

    fs::symlink_metadata(candidate).map_err(map_io_error)?;
    fs::canonicalize(candidate).map_err(map_io_error)
}

pub(crate) fn serialize_windows_path(path: &Path) -> Result<String, PathError> {
    let raw = path.to_str().ok_or(PathError::Invalid)?;
    let without_extended_prefix = if let Some(unc_path) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc_path}")
    } else if let Some(path) = raw.strip_prefix(r"\\?\") {
        path.to_string()
    } else {
        raw.to_string()
    };
    let normalized = without_extended_prefix.replace('\\', "/");
    validate_text(&normalized)?;
    if !is_absolute_path(&normalized) {
        return Err(PathError::Invalid);
    }
    Ok(normalized)
}

pub(crate) fn is_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    let drive_path = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let unc_path = value.starts_with(r"\\") || value.starts_with("//");
    drive_path || unc_path || Path::new(value).is_absolute()
}

fn path_kind(path: &Path) -> Result<PathKind, PathError> {
    let metadata = fs::metadata(path).map_err(map_io_error)?;
    if metadata.is_file() {
        Ok(PathKind::File)
    } else if metadata.is_dir() {
        Ok(PathKind::Directory)
    } else {
        Err(PathError::WrongType)
    }
}

fn validate_text(value: &str) -> Result<(), PathError> {
    let max_length = context_limits().max_path_length;
    if value.is_empty() || value.len() > max_length || value.chars().any(char::is_control) {
        return Err(PathError::Invalid);
    }
    Ok(())
}

fn map_io_error(error: io::Error) -> PathError {
    match error.kind() {
        io::ErrorKind::NotFound => PathError::Missing,
        io::ErrorKind::PermissionDenied => PathError::PermissionDenied,
        _ => PathError::Invalid,
    }
}

struct ContextLimits {
    max_path_length: usize,
}

fn context_limits() -> &'static ContextLimits {
    static LIMITS: std::sync::OnceLock<ContextLimits> = std::sync::OnceLock::new();
    LIMITS.get_or_init(|| {
        let value: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/context-limits.json"
        )))
        .expect("shared context limits must be valid JSON");
        ContextLimits {
            max_path_length: value["maxPathLength"]
                .as_u64()
                .expect("maxPathLength must be an integer") as usize,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "aside-path-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    #[test]
    fn canonicalizes_existing_file_and_directory_without_file_bytes() {
        let root = fixture_root();
        fs::create_dir_all(root.join("nested")).expect("fixture directory");
        fs::write(root.join("nested").join("note.txt"), b"fixture").expect("fixture file");

        let directory = descriptor_from_path(
            PathRole::WorkspaceRoot,
            &root.join("nested").join("..").to_string_lossy(),
            Some(PathKind::Directory),
        )
        .expect("directory descriptor");
        let file = descriptor_from_path(
            PathRole::ActiveFile,
            &root.join("nested").join("note.txt").to_string_lossy(),
            Some(PathKind::File),
        )
        .expect("file descriptor");

        assert_eq!(directory.role, PathRole::WorkspaceRoot);
        assert_eq!(directory.kind, PathKind::Directory);
        assert_eq!(file.role, PathRole::ActiveFile);
        assert_eq!(file.kind, PathKind::File);
        assert!(is_absolute_path(&directory.path));
        assert!(is_absolute_path(&file.path));
        assert!(!directory.path.contains(".."));
        assert!(!file.path.contains("note.txt\0"));

        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn rejects_relative_missing_wrong_type_and_overlong_candidates() {
        assert_eq!(
            descriptor_from_path(PathRole::Document, "relative.docx", None),
            Err(PathError::Invalid)
        );

        let missing = if cfg!(windows) {
            r"C:\aside\does-not-exist\missing.docx".to_string()
        } else {
            "/aside/does-not-exist/missing.docx".to_string()
        };
        assert_eq!(
            descriptor_from_path(PathRole::Document, &missing, None),
            Err(PathError::Missing)
        );

        let root = fixture_root();
        fs::create_dir_all(&root).expect("fixture directory");
        assert_eq!(
            descriptor_from_path(
                PathRole::ActiveFile,
                &root.to_string_lossy(),
                Some(PathKind::File)
            ),
            Err(PathError::WrongType)
        );
        let long_candidate = if cfg!(windows) {
            format!(r"C:\{}", "x".repeat(context_limits().max_path_length))
        } else {
            format!("/{}", "x".repeat(context_limits().max_path_length))
        };
        assert_eq!(
            descriptor_from_path(PathRole::Directory, &long_candidate, None),
            Err(PathError::Invalid)
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[cfg(unix)]
    #[test]
    fn resolves_symlink_to_the_canonical_target() {
        let root = fixture_root();
        fs::create_dir_all(&root).expect("fixture directory");
        let target = root.join("target.txt");
        let link = root.join("link.txt");
        fs::write(&target, b"fixture").expect("fixture file");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");

        let descriptor = descriptor_from_path(PathRole::Document, &link.to_string_lossy(), None)
            .expect("symlink descriptor");
        let target_descriptor =
            descriptor_from_path(PathRole::Document, &target.to_string_lossy(), None)
                .expect("target descriptor");
        assert_eq!(descriptor.path, target_descriptor.path);

        fs::remove_dir_all(root).expect("remove fixture");
    }
}
