//! Target-bound Windows Shell automation for Explorer metadata.
//!
//! The Shell object model is the authoritative locator for a File Explorer
//! window. This module only returns bounded path strings; the shared path
//! boundary remains responsible for canonicalization and validation.

#[cfg(target_os = "windows")]
mod windows {
    use std::thread;

    use crate::context::HostCaptureErrorCode;
    use crate::platform::TargetWindow;

    const MAX_SHELL_WINDOWS: usize = 128;
    const MAX_SELECTED_ITEMS: usize = 32;
    const MAX_PATH_BYTES: usize = 4_096;

    #[derive(Clone, Debug, Default)]
    pub(crate) struct ExplorerShellSignals {
        pub(crate) directory: Option<String>,
        pub(crate) selected_paths: Vec<String>,
    }

    struct ComGuard;

    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { ::windows::Win32::System::Com::CoUninitialize() };
        }
    }

    pub(crate) fn discover(
        target: &TargetWindow,
    ) -> Result<Option<ExplorerShellSignals>, HostCaptureErrorCode> {
        let target = target.clone();
        thread::Builder::new()
            .name("aside-explorer-shell".to_string())
            .spawn(move || discover_on_worker(&target))
            .map_err(|_| HostCaptureErrorCode::Unavailable)?
            .join()
            .unwrap_or(Err(HostCaptureErrorCode::CaptureFailed))
    }

    fn discover_on_worker(
        target: &TargetWindow,
    ) -> Result<Option<ExplorerShellSignals>, HostCaptureErrorCode> {
        use ::windows::core::Interface;
        use ::windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
        };
        use ::windows::Win32::System::Variant::VARIANT;
        use ::windows::Win32::UI::Shell::{
            Folder2, IShellFolderViewDual, IShellWindows, IWebBrowserApp, ShellWindows,
        };

        if !crate::platform::target_is_captureable(target) {
            return Err(HostCaptureErrorCode::StaleTarget);
        }
        if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
            return Err(HostCaptureErrorCode::Unavailable);
        }
        let _com = ComGuard;

        let shell_windows: IShellWindows =
            unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER) }
                .map_err(|_| HostCaptureErrorCode::Unavailable)?;
        let count = unsafe { shell_windows.Count() }
            .map_err(|_| HostCaptureErrorCode::LocatorUnavailable)?;
        let count = usize::try_from(count).map_err(|_| HostCaptureErrorCode::CaptureFailed)?;
        if count > MAX_SHELL_WINDOWS {
            return Err(HostCaptureErrorCode::CaptureFailed);
        }

        let mut matched_browser: Option<IWebBrowserApp> = None;
        for index in 0..count {
            let index = VARIANT::from(index as i32);
            let dispatch = match unsafe { shell_windows.Item(&index) } {
                Ok(dispatch) => dispatch,
                Err(_) => continue,
            };
            let browser = match dispatch.cast::<IWebBrowserApp>() {
                Ok(browser) => browser,
                Err(_) => continue,
            };
            let hwnd = match unsafe { browser.HWND() } {
                Ok(hwnd) => hwnd.0,
                Err(_) => continue,
            };
            if hwnd != target.native_handle() {
                continue;
            }
            if matched_browser.is_some() {
                return Err(HostCaptureErrorCode::AmbiguousLocator);
            }
            matched_browser = Some(browser);
        }

        let Some(browser) = matched_browser else {
            return Ok(None);
        };
        if !crate::platform::target_is_current(target) {
            return Err(HostCaptureErrorCode::StaleTarget);
        }

        let mut signals = ExplorerShellSignals::default();
        let Ok(document) = (unsafe { browser.Document() }) else {
            return finish_signals(target, signals);
        };
        let Ok(folder_view) = document.cast::<IShellFolderViewDual>() else {
            return finish_signals(target, signals);
        };

        if let Ok(folder) = unsafe { folder_view.Folder() } {
            if let Ok(folder2) = folder.cast::<Folder2>() {
                if let Ok(folder_item) = unsafe { folder2.Self_() } {
                    if let Ok(path) = unsafe { folder_item.Path() } {
                        signals.directory = shell_path(path);
                    }
                }
            }
        }

        if let Ok(selected_items) = unsafe { folder_view.SelectedItems() } {
            let count = unsafe { selected_items.Count() }
                .ok()
                .and_then(|count| usize::try_from(count).ok())
                .unwrap_or(0)
                .min(MAX_SELECTED_ITEMS);
            for index in 0..count {
                let index = VARIANT::from(index as i32);
                let Ok(item) = (unsafe { selected_items.Item(&index) }) else {
                    continue;
                };
                let Ok(path) = (unsafe { item.Path() }) else {
                    continue;
                };
                let Some(path) = shell_path(path) else {
                    continue;
                };
                if !signals.selected_paths.contains(&path) {
                    signals.selected_paths.push(path);
                }
            }
        }

        finish_signals(target, signals)
    }

    fn finish_signals(
        target: &TargetWindow,
        signals: ExplorerShellSignals,
    ) -> Result<Option<ExplorerShellSignals>, HostCaptureErrorCode> {
        if !crate::platform::target_is_current(target) {
            return Err(HostCaptureErrorCode::StaleTarget);
        }
        Ok(Some(signals))
    }

    fn shell_path(value: ::windows::core::BSTR) -> Option<String> {
        let value = String::try_from(&value).ok()?;
        let value = value.trim();
        if value.is_empty()
            || value.len() > MAX_PATH_BYTES
            || value.chars().any(char::is_control)
            || !crate::path::is_absolute_path(value)
        {
            return None;
        }
        Some(value.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::shell_path;

        #[test]
        fn accepts_only_bounded_absolute_shell_paths() {
            assert_eq!(
                shell_path(::windows::core::BSTR::from(r"C:\Users\Yan\notes.txt")),
                Some(r"C:\Users\Yan\notes.txt".to_string())
            );
            assert!(shell_path(::windows::core::BSTR::from("file:///C:/notes.txt")).is_none());
            assert!(shell_path(::windows::core::BSTR::from("notes.txt")).is_none());
            assert!(shell_path(::windows::core::BSTR::from(format!(
                r"C:\{}",
                "x".repeat(4_097)
            )))
            .is_none());
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) use windows::discover;
