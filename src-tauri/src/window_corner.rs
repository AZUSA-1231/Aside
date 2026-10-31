use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
mod windows {
    use super::WebviewWindow;
    use std::ffi::c_void;
    use std::mem::size_of;

    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_SYSTEMBACKDROP_TYPE: u32 = 38;
    const DWMWCP_ROUND: u32 = 2;
    const DWMWA_COLOR_NONE: u32 = 0xfffffffe;
    const DWMSBT_TRANSIENTWINDOW: u32 = 3;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            attribute: u32,
            value: *const c_void,
            size: u32,
        ) -> i32;
        fn DwmGetWindowAttribute(hwnd: isize, attribute: u32, value: *mut c_void, size: u32)
            -> i32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            value_type: *mut u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn SystemParametersInfoW(action: u32, parameter: u32, data: *mut c_void, flags: u32)
            -> i32;
    }

    #[repr(C)]
    struct HighContrast {
        size: u32,
        flags: u32,
        scheme: *mut u16,
    }

    pub fn apply(window: &WebviewWindow) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        for (attribute, value) in [
            (DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND),
            (DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE),
        ] {
            let result = unsafe {
                DwmSetWindowAttribute(
                    hwnd,
                    attribute,
                    (&value as *const u32).cast(),
                    size_of::<u32>() as u32,
                )
            };
            if result < 0 {
                return Err(format!(
                    "DWM window attribute {attribute} failed (HRESULT 0x{:08X}).",
                    result as u32
                ));
            }
        }
        Ok(())
    }

    pub fn acrylic_available(window: &WebviewWindow) -> bool {
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let mut contrast = HighContrast {
            size: size_of::<HighContrast>() as u32,
            flags: 0,
            scheme: std::ptr::null_mut(),
        };
        if unsafe {
            SystemParametersInfoW(
                0x0042,
                contrast.size,
                (&mut contrast as *mut HighContrast).cast(),
                0,
            )
        } != 0
            && contrast.flags & 1 != 0
        {
            return false;
        }
        let subkey: Vec<u16> =
            "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
                .encode_utf16()
                .collect();
        let name: Vec<u16> = "EnableTransparency\0".encode_utf16().collect();
        let mut enabled = 1u32;
        let mut size = size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                0x80000001u32 as i32 as isize,
                subkey.as_ptr(),
                name.as_ptr(),
                0x10,
                std::ptr::null_mut(),
                (&mut enabled as *mut u32).cast(),
                &mut size,
            )
        };
        if status == 0 && enabled == 0 {
            return false;
        }
        let mut backdrop = 0u32;
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd.0 as isize,
                DWMWA_SYSTEMBACKDROP_TYPE,
                (&mut backdrop as *mut u32).cast(),
                size_of::<u32>() as u32,
            )
        };
        result >= 0 && backdrop == DWMSBT_TRANSIENTWINDOW
    }
}

#[cfg(target_os = "windows")]
pub use windows::{acrylic_available, apply};

#[cfg(not(target_os = "windows"))]
pub fn apply(_: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn acrylic_available(_: &WebviewWindow) -> bool {
    false
}
