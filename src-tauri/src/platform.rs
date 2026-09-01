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
    pub application_id: Option<String>,
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

    #[cfg(target_os = "windows")]
    pub(crate) fn native_handle(&self) -> isize {
        self.handle
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn native_process_id(&self) -> u32 {
        self.process_id
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
    use std::ffi::c_void;
    use std::hash::{Hash, Hasher};
    use std::mem::size_of;
    use std::path::Path;

    type Hwnd = isize;
    type Hmonitor = isize;

    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const SW_RESTORE: i32 = 9;
    const SW_MAXIMIZE: i32 = 3;
    const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
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
        fn IsIconic(hwnd: Hwnd) -> i32;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
        fn IsZoomed(hwnd: Hwnd) -> i32;
        fn MonitorFromPoint(point: Point, flags: u32) -> Hmonitor;
        fn MonitorFromWindow(hwnd: Hwnd, flags: u32) -> Hmonitor;
        fn BeginDeferWindowPos(number_of_windows: i32) -> isize;
        fn DeferWindowPos(
            defer_handle: isize,
            hwnd: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> isize;
        fn EndDeferWindowPos(defer_handle: isize) -> i32;
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
        fn CloseHandle(handle: Hwnd) -> i32;
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Hwnd;
        fn QueryFullProcessImageNameW(
            process: Hwnd,
            flags: u32,
            file_name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmGetWindowAttribute(
            hwnd: Hwnd,
            attribute: u32,
            value: *mut c_void,
            value_size: u32,
        ) -> i32;
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

    fn application_id(process_id: u32) -> Option<String> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process == 0 {
            return None;
        }

        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let result =
            unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
        unsafe {
            CloseHandle(process);
        }
        if result == 0 || length == 0 {
            return None;
        }

        Path::new(&String::from_utf16_lossy(&buffer[..length as usize]))
            .file_name()?
            .to_str()
            .map(str::to_ascii_lowercase)
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
            application_id: application_id(process_id),
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

    pub fn target_is_current(target: &TargetWindow) -> bool {
        ensure_target(target).is_ok()
    }

    pub fn target_is_captureable(target: &TargetWindow) -> bool {
        ensure_target(target).is_ok()
            && unsafe { IsWindowVisible(target.handle) } != 0
            && unsafe { IsIconic(target.handle) } == 0
            && target.bounds.width > 0
            && target.bounds.height > 0
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

    fn extended_frame_bounds(hwnd: Hwnd) -> Option<Rect> {
        let mut native_bounds = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&mut native_bounds as *mut NativeRect).cast::<c_void>(),
                size_of::<NativeRect>() as u32,
            )
        };
        if result != 0 {
            return None;
        }
        rect_from_native(native_bounds)
    }

    fn visible_to_outer_rect(outer: Rect, visible: Rect, frame: Rect) -> Option<Rect> {
        let left_inset = i64::from(frame.x) - i64::from(outer.x);
        let top_inset = i64::from(frame.y) - i64::from(outer.y);
        let right_inset = i64::from(outer.right()) - i64::from(frame.right());
        let bottom_inset = i64::from(outer.bottom()) - i64::from(frame.bottom());
        let x = i64::from(visible.x) - left_inset;
        let y = i64::from(visible.y) - top_inset;
        let width = i64::from(visible.width) + left_inset + right_inset;
        let height = i64::from(visible.height) + top_inset + bottom_inset;

        Some(Rect::new(
            i32::try_from(x).ok()?,
            i32::try_from(y).ok()?,
            i32::try_from(width).ok()?,
            i32::try_from(height).ok()?,
        ))
        .filter(|rect| rect.width > 0 && rect.height > 0)
    }

    fn outer_rect_for_visible_rect(hwnd: Hwnd, visible: Rect) -> Rect {
        let mut native_bounds = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut native_bounds) } == 0 {
            return visible;
        }
        let Some(outer) = rect_from_native(native_bounds) else {
            return visible;
        };
        let Some(frame) = extended_frame_bounds(hwnd) else {
            return visible;
        };
        visible_to_outer_rect(outer, visible, frame).unwrap_or(visible)
    }

    fn set_rect(hwnd: Hwnd, rect: Rect) -> Result<(), PlatformError> {
        if hwnd == 0 || rect.width <= 0 || rect.height <= 0 {
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
                SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER,
            )
        };
        if result == 0 {
            return Err(PlatformError(
                "Windows rejected the requested bounds.".into(),
            ));
        }
        Ok(())
    }

    fn set_rects(rects: &[(Hwnd, Rect)]) -> Result<(), PlatformError> {
        if rects.is_empty() {
            return Ok(());
        }
        if rects
            .iter()
            .any(|(hwnd, rect)| *hwnd == 0 || rect.width <= 0 || rect.height <= 0)
        {
            return Err(PlatformError(
                "The requested window bounds are invalid.".into(),
            ));
        }

        let defer_handle = unsafe { BeginDeferWindowPos(rects.len() as i32) };
        if defer_handle != 0 {
            let mut current = defer_handle;
            for (hwnd, rect) in rects {
                let next = unsafe {
                    DeferWindowPos(
                        current,
                        *hwnd,
                        0,
                        rect.x,
                        rect.y,
                        rect.width,
                        rect.height,
                        SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER,
                    )
                };
                if next == 0 {
                    current = 0;
                    break;
                }
                current = next;
            }
            if current != 0 && unsafe { EndDeferWindowPos(current) } != 0 {
                return Ok(());
            }
        }

        for (hwnd, rect) in rects {
            set_rect(*hwnd, *rect)?;
        }
        Ok(())
    }

    pub fn set_window_rect(hwnd: isize, bounds: Rect) -> Result<(), PlatformError> {
        set_rect(hwnd, bounds)
    }

    pub fn tile_target_with_agent(
        target: &TargetWindow,
        visible_target_bounds: Rect,
        agent_handle: isize,
        agent_bounds: Rect,
    ) -> Result<(), PlatformError> {
        ensure_target(target)?;
        if agent_handle == 0 {
            return Err(PlatformError(
                "The Aside panel handle is unavailable.".into(),
            ));
        }
        unsafe {
            ShowWindow(target.handle, SW_RESTORE);
        }
        let target_bounds = outer_rect_for_visible_rect(target.handle, visible_target_bounds);
        set_rects(&[(target.handle, target_bounds), (agent_handle, agent_bounds)])
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
pub use windows::{
    cursor_work_area, foreground_target, restore_target, set_window_rect, target_is_captureable,
    target_is_current, tile_target_with_agent,
};

#[cfg(not(target_os = "windows"))]
mod unsupported {
    use super::{PlatformError, Rect, TargetWindow};

    pub fn foreground_target() -> Option<TargetWindow> {
        None
    }

    pub fn target_is_current(_: &TargetWindow) -> bool {
        false
    }

    pub fn target_is_captureable(_: &TargetWindow) -> bool {
        false
    }

    pub fn cursor_work_area() -> Option<Rect> {
        None
    }

    pub fn set_window_rect(_: isize, _: Rect) -> Result<(), PlatformError> {
        Err(PlatformError(
            "Native window placement is only available on Windows.".into(),
        ))
    }

    pub fn tile_target_with_agent(
        _: &TargetWindow,
        _: Rect,
        _: isize,
        _: Rect,
    ) -> Result<(), PlatformError> {
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
pub use unsupported::{
    cursor_work_area, foreground_target, restore_target, set_window_rect, target_is_captureable,
    target_is_current, tile_target_with_agent,
};
