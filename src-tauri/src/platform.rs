use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: i32, height: i32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn right(self) -> i32 {
        self.x + self.width
    }

    pub fn bottom(self) -> i32 {
        self.y + self.height
    }

    pub fn nearly_fills(self, area: Self, tolerance: i32) -> bool {
        (self.x - area.x).abs() <= tolerance
            && (self.y - area.y).abs() <= tolerance
            && (self.right() - area.right()).abs() <= tolerance
            && (self.bottom() - area.bottom()).abs() <= tolerance
    }
}

#[derive(Clone, Debug)]
pub struct TargetWindow {
    pub opaque_id: String,
    pub bounds: Rect,
    pub maximized: bool,
    pub monitor: usize,
    pub work_area: Rect,
    #[cfg(target_os = "windows")]
    pub(crate) handle: isize,
    #[cfg(target_os = "windows")]
    pub(crate) process_id: u32,
}

impl TargetWindow {
    pub fn is_workspace_candidate(&self) -> bool {
        self.maximized || self.bounds.nearly_fills(self.work_area, 12)
    }
}

#[derive(Debug)]
pub struct PlatformError(pub String);

impl fmt::Display for PlatformError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{PlatformError, Rect, TargetWindow};
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::mem::size_of;

    type Hwnd = isize;
    type Hmonitor = isize;

    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const SW_RESTORE: i32 = 9;
    const SW_MAXIMIZE: i32 = 3;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOZORDER: u32 = 0x0004;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NativeRect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MonitorInfo {
        cb_size: u32,
        monitor: NativeRect,
        work: NativeRect,
        flags: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetClassNameW(hwnd: Hwnd, class_name: *mut u16, max_count: i32) -> i32;
        fn GetCursorPos(point: *mut Point) -> i32;
        fn GetForegroundWindow() -> Hwnd;
        fn GetMonitorInfoW(monitor: Hmonitor, info: *mut MonitorInfo) -> i32;
        fn GetWindowRect(hwnd: Hwnd, rect: *mut NativeRect) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn IsZoomed(hwnd: Hwnd) -> i32;
        fn MonitorFromPoint(point: Point, flags: u32) -> Hmonitor;
        fn MonitorFromWindow(hwnd: Hwnd, flags: u32) -> Hmonitor;
        fn SetWindowPos(
            hwnd: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
        fn ShowWindow(hwnd: Hwnd, command: i32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcessId() -> u32;
    }

    fn rect_from_native(rect: NativeRect) -> Option<Rect> {
        let width = rect.right.checked_sub(rect.left)?;
        let height = rect.bottom.checked_sub(rect.top)?;
        if width <= 0 || height <= 0 {
            return None;
        }
        Some(Rect::new(rect.left, rect.top, width, height))
    }

    fn monitor_work_area(monitor: Hmonitor) -> Option<Rect> {
        if monitor == 0 {
            return None;
        }
        let mut info = MonitorInfo {
            cb_size: size_of::<MonitorInfo>() as u32,
            monitor: NativeRect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            work: NativeRect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            },
            flags: 0,
        };
        let result = unsafe { GetMonitorInfoW(monitor, &mut info) };
        if result == 0 {
            return None;
        }
        rect_from_native(info.work)
    }

    fn class_name(hwnd: Hwnd) -> String {
        let mut buffer = [0u16; 256];
        let length = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if length <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..length as usize])
    }

    fn is_unsupported_class(class: &str) -> bool {
        matches!(
            class,
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "DV2ControlHost" | "MsgrIMEWindowClass"
        )
    }

    fn opaque_id(hwnd: Hwnd, process_id: u32, class: &str) -> String {
        let mut hasher = DefaultHasher::new();
        hwnd.hash(&mut hasher);
        process_id.hash(&mut hasher);
        class.hash(&mut hasher);
        format!("window-{:#016x}", hasher.finish())
    }

    fn target_from_handle(hwnd: Hwnd) -> Option<TargetWindow> {
        if hwnd == 0 || unsafe { IsWindow(hwnd) } == 0 {
            return None;
        }

        let mut process_id = 0;
        if unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) } == 0
            || process_id == unsafe { GetCurrentProcessId() }
        {
            return None;
        }

        let class = class_name(hwnd);
        if class.is_empty() || is_unsupported_class(&class) {
            return None;
        }

        let mut native_bounds = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut native_bounds) } == 0 {
            return None;
        }
        let bounds = rect_from_native(native_bounds)?;
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let work_area = monitor_work_area(monitor)?;

        Some(TargetWindow {
            opaque_id: opaque_id(hwnd, process_id, &class),
            bounds,
            maximized: unsafe { IsZoomed(hwnd) } != 0,
            monitor: monitor as usize,
            work_area,
            handle: hwnd,
            process_id,
        })
    }

    pub fn foreground_target() -> Option<TargetWindow> {
        target_from_handle(unsafe { GetForegroundWindow() })
    }

    pub fn cursor_work_area() -> Option<Rect> {
        let mut point = Point { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut point) } == 0 {
            return None;
        }
        let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
        monitor_work_area(monitor)
    }

    fn ensure_target(target: &TargetWindow) -> Result<(), PlatformError> {
        if unsafe { IsWindow(target.handle) } == 0 {
            return Err(PlatformError(
                "The original window is no longer available.".into(),
            ));
        }
        let mut process_id = 0;
        if unsafe { GetWindowThreadProcessId(target.handle, &mut process_id) } == 0
            || process_id != target.process_id
        {
            return Err(PlatformError(
                "The original window identity no longer matches.".into(),
            ));
        }
        Ok(())
    }

    fn set_rect(hwnd: Hwnd, rect: Rect) -> Result<(), PlatformError> {
        if rect.width <= 0 || rect.height <= 0 {
            return Err(PlatformError(
                "The requested window bounds are invalid.".into(),
            ));
        }
        let result = unsafe {
            SetWindowPos(
                hwnd,
                0,
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
        };
        if result == 0 {
            return Err(PlatformError(
                "Windows rejected the requested bounds.".into(),
            ));
        }
        Ok(())
    }

    pub fn tile_target(target: &TargetWindow, bounds: Rect) -> Result<(), PlatformError> {
        ensure_target(target)?;
        unsafe {
            ShowWindow(target.handle, SW_RESTORE);
        }
        set_rect(target.handle, bounds)
    }

    pub fn restore_target(target: &TargetWindow) -> Result<(), PlatformError> {
        ensure_target(target)?;
        unsafe {
            ShowWindow(target.handle, SW_RESTORE);
        }
        set_rect(target.handle, target.bounds)?;
        if target.maximized {
            unsafe {
                ShowWindow(target.handle, SW_MAXIMIZE);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub use windows::{cursor_work_area, foreground_target, restore_target, tile_target};

#[cfg(not(target_os = "windows"))]
mod unsupported {
    use super::{PlatformError, Rect, TargetWindow};

    pub fn foreground_target() -> Option<TargetWindow> {
        None
    }

    pub fn cursor_work_area() -> Option<Rect> {
        None
    }

    pub fn tile_target(_: &TargetWindow, _: Rect) -> Result<(), PlatformError> {
        Err(PlatformError(
            "Workspace Mode is only available on Windows.".into(),
        ))
    }

    pub fn restore_target(_: &TargetWindow) -> Result<(), PlatformError> {
        Err(PlatformError(
            "Window restoration is only available on Windows.".into(),
        ))
    }
}

#[cfg(not(target_os = "windows"))]
pub use unsupported::{cursor_work_area, foreground_target, restore_target, tile_target};
