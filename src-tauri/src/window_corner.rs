//! Prefer Windows 11's native rounded corners without a binary window region.
use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
pub fn apply(window: &WebviewWindow) -> Result<(), String> {
    use std::ffi::c_void;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            attribute: u32,
            value: *const c_void,
            value_size: u32,
        ) -> i32;
    }

    // DWMWA_WINDOW_CORNER_PREFERENCE requires Windows 11 build 22000+.
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;

    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    let preference = DWMWCP_ROUND;
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &preference as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    if result < 0 {
        return Err(format!(
            "DWM rounded-corner preference failed (HRESULT 0x{:08X}).",
            result as u32
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn apply(_: &WebviewWindow) -> Result<(), String> {
    Ok(())
}
