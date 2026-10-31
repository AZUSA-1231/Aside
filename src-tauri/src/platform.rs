use std::fmt;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PlacementPoint {
    x: i32,
    y: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PlacementRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct WindowPlacement {
    length: u32,
    flags: u32,
    show_command: u32,
    minimum_position: PlacementPoint,
    maximum_position: PlacementPoint,
    normal_position: PlacementRect,
}

#[derive(Clone, Debug)]
pub struct WindowSnapshot {
    pub target: TargetWindow,
    pub placement: WindowPlacement,
}

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

#[derive(Default)]
pub(crate) struct CaptureFocus {
    target: Option<TargetWindow>,
}

impl CaptureFocus {
    const fn new() -> Self {
        Self { target: None }
    }

    fn observe(&mut self, own_process: bool, target: Option<TargetWindow>) {
        if !own_process {
            self.target = target;
        }
    }

    pub(crate) fn snapshot(&self) -> Option<TargetWindow> {
        self.target.clone()
    }
}

impl TargetWindow {
    pub fn is_workspace_candidate(&self) -> bool {
        self.maximized
            || self.bounds.nearly_fills(self.work_area, 12)
            || (self.bounds.x <= self.work_area.x
                && self.bounds.y <= self.work_area.y
                && self.bounds.right() >= self.work_area.right()
                && self.bounds.bottom() >= self.work_area.bottom())
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
    use super::CaptureFocus;
    use super::{PlatformError, Rect, TargetWindow, WindowPlacement, WindowSnapshot};
    use std::cell::Cell;
    use std::collections::hash_map::DefaultHasher;
    use std::ffi::c_void;
    use std::hash::{Hash, Hasher};
    use std::mem::size_of;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    type Hwnd = isize;
    type Hmonitor = isize;

    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOZORDER: u32 = 0x0004;
    const SW_SHOWNOACTIVATE: u32 = 4;
    const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    const EVENT_SYSTEM_FOREGROUND: u32 = 3;
    const WINEVENT_OUTOFCONTEXT: u32 = 0;
    const WINEVENT_SKIPOWNPROCESS: u32 = 2;

    static CAPTURE_FOCUS: Mutex<CaptureFocus> = Mutex::new(CaptureFocus::new());
    static TRACKING_ACTIVE: AtomicBool = AtomicBool::new(false);

    thread_local! {
        static FOREGROUND_HOOK: Cell<isize> = const { Cell::new(0) };
    }

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
        fn GetWindowPlacement(hwnd: Hwnd, placement: *mut WindowPlacement) -> i32;
        fn GetWindowThreadProcessId(hwnd: Hwnd, process_id: *mut u32) -> u32;
        fn IsIconic(hwnd: Hwnd) -> i32;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn IsWindowVisible(hwnd: Hwnd) -> i32;
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
        fn SetWindowPlacement(hwnd: Hwnd, placement: *const WindowPlacement) -> i32;
        fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        fn SetWinEventHook(
            event_min: u32,
            event_max: u32,
            module: isize,
            callback: unsafe extern "system" fn(isize, u32, Hwnd, i32, i32, u32, u32),
            process_id: u32,
            thread_id: u32,
            flags: u32,
        ) -> isize;
        fn UnhookWinEvent(hook: isize) -> i32;
    }

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmGetWindowAttribute(hwnd: Hwnd, attribute: u32, value: *mut c_void, size: u32) -> i32;
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
        let bounds = visible_bounds(hwnd).or_else(|| rect_from_native(native_bounds))?;
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
        let handle = unsafe { GetForegroundWindow() };
        observe_foreground(handle);
        target_from_handle(handle)
    }

    fn observe_foreground(handle: Hwnd) {
        if handle == 0 {
            return;
        }
        let mut process_id = 0;
        unsafe { GetWindowThreadProcessId(handle, &mut process_id) };
        let own_process = process_id == unsafe { GetCurrentProcessId() };
        let target = if own_process {
            None
        } else {
            target_from_handle(handle)
        };
        if let Ok(mut focus) = CAPTURE_FOCUS.lock() {
            focus.observe(own_process, target);
        }
    }

    unsafe extern "system" fn foreground_changed(
        _: isize,
        _: u32,
        handle: Hwnd,
        _: i32,
        _: i32,
        _: u32,
        _: u32,
    ) {
        observe_foreground(handle);
    }

    pub fn start_foreground_tracking() -> Result<(), PlatformError> {
        FOREGROUND_HOOK.with(|slot| {
            if slot.get() != 0 {
                return Ok(());
            }
            let hook = unsafe {
                SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    0,
                    foreground_changed,
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            };
            if hook == 0 {
                return Err(PlatformError(
                    "External foreground tracking could not be started.".into(),
                ));
            }
            slot.set(hook);
            TRACKING_ACTIVE.store(true, Ordering::Release);
            observe_foreground(unsafe { GetForegroundWindow() });
            Ok(())
        })
    }

    pub fn stop_foreground_tracking() -> Result<(), PlatformError> {
        FOREGROUND_HOOK.with(|slot| {
            let hook = slot.get();
            if hook != 0 && unsafe { UnhookWinEvent(hook) } == 0 {
                return Err(PlatformError(
                    "External foreground tracking could not be stopped.".into(),
                ));
            }
            slot.set(0);
            TRACKING_ACTIVE.store(false, Ordering::Release);
            if let Ok(mut focus) = CAPTURE_FOCUS.lock() {
                focus.observe(false, None);
            }
            Ok(())
        })
    }

    pub fn latest_capture_target() -> Result<Option<TargetWindow>, PlatformError> {
        if !TRACKING_ACTIVE.load(Ordering::Acquire) {
            return Err(PlatformError(
                "External foreground tracking is unavailable. Restart Aside to retry.".into(),
            ));
        }
        observe_foreground(unsafe { GetForegroundWindow() });
        let target = CAPTURE_FOCUS
            .lock()
            .map_err(|_| {
                PlatformError("The latest external foreground target is unavailable.".into())
            })?
            .snapshot();
        Ok(target.map(|target| {
            if ensure_target(&target).is_ok() {
                target_from_handle(target.handle)
                    .filter(|current| current.opaque_id == target.opaque_id)
                    .unwrap_or(target)
            } else {
                target
            }
        }))
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
            || opaque_id(target.handle, process_id, &class_name(target.handle)) != target.opaque_id
        {
            return Err(PlatformError(
                "The original window identity no longer matches.".into(),
            ));
        }
        Ok(())
    }

    fn visible_bounds(hwnd: Hwnd) -> Option<Rect> {
        let mut bounds = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let result = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&mut bounds as *mut NativeRect).cast(),
                size_of::<NativeRect>() as u32,
            )
        };
        (result >= 0).then(|| rect_from_native(bounds)).flatten()
    }

    fn outer_bounds(hwnd: Hwnd) -> Option<Rect> {
        let mut bounds = NativeRect {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        (unsafe { GetWindowRect(hwnd, &mut bounds) } != 0)
            .then(|| rect_from_native(bounds))
            .flatten()
    }

    pub fn snapshot_target(target: TargetWindow) -> Result<WindowSnapshot, PlatformError> {
        ensure_target(&target)?;
        let mut placement = WindowPlacement {
            length: size_of::<WindowPlacement>() as u32,
            ..WindowPlacement::default()
        };
        if unsafe { GetWindowPlacement(target.handle, &mut placement) } == 0 {
            return Err(PlatformError(
                "The original window placement could not be saved.".into(),
            ));
        }
        Ok(WindowSnapshot { target, placement })
    }

    pub fn tile_target(snapshot: &WindowSnapshot, bounds: Rect) -> Result<(), PlatformError> {
        ensure_target(&snapshot.target)?;
        let hwnd = snapshot.target.handle;
        if unsafe { IsWindowVisible(hwnd) } == 0 || unsafe { IsIconic(hwnd) } != 0 {
            return Err(PlatformError(
                "The original window is no longer visible.".into(),
            ));
        }
        let mut placement = snapshot.placement;
        placement.show_command = SW_SHOWNOACTIVATE;
        placement.flags = 0;
        if unsafe { SetWindowPlacement(hwnd, &placement) } == 0 {
            return Err(PlatformError(
                "The original window could not leave its maximized state.".into(),
            ));
        }
        set_window_rect(hwnd, bounds)?;
        let actual = visible_bounds(hwnd).or_else(|| outer_bounds(hwnd));
        if !actual.is_some_and(|actual| actual.nearly_fills(bounds, 2)) {
            return Err(PlatformError(
                "The original application did not accept the 80/20 layout.".into(),
            ));
        }
        Ok(())
    }

    pub fn restore_target(snapshot: &WindowSnapshot) -> Result<(), PlatformError> {
        if !target_is_current(&snapshot.target) {
            return Ok(());
        }
        if unsafe { SetWindowPlacement(snapshot.target.handle, &snapshot.placement) } == 0 {
            return Err(PlatformError(
                "The original window placement could not be restored. Hide Aside again to retry."
                    .into(),
            ));
        }
        if (unsafe { IsZoomed(snapshot.target.handle) } != 0) != snapshot.target.maximized {
            return Err(PlatformError(
                "Windows did not restore the original maximized state. Hide Aside again to retry."
                    .into(),
            ));
        }
        Ok(())
    }

    pub fn focus_target(target: &TargetWindow) -> Result<(), PlatformError> {
        if target_is_current(target) {
            if unsafe { SetForegroundWindow(target.handle) } == 0 {
                return Err(PlatformError("The original layout was restored, but Windows did not return focus to that application.".into()));
            }
        }
        Ok(())
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

    pub fn set_window_rect(hwnd: isize, bounds: Rect) -> Result<(), PlatformError> {
        set_rect(hwnd, bounds)?;
        let outer = outer_bounds(hwnd)
            .ok_or_else(|| PlatformError("Aside's window bounds are unavailable.".into()))?;
        let frame = visible_bounds(hwnd).unwrap_or(outer);
        let corrected = super::outer_rect_for_visible(outer, frame, bounds)
            .ok_or_else(|| PlatformError("Aside's window frame is invalid.".into()))?;
        set_rect(hwnd, corrected)
    }
}

#[cfg(target_os = "windows")]
pub use windows::{
    cursor_work_area, focus_target, foreground_target, latest_capture_target, restore_target,
    set_window_rect, snapshot_target, start_foreground_tracking, stop_foreground_tracking,
    target_is_captureable, target_is_current, tile_target,
};

#[cfg(not(target_os = "windows"))]
mod unsupported {
    use super::{PlatformError, Rect, TargetWindow, WindowSnapshot};

    pub fn foreground_target() -> Option<TargetWindow> {
        None
    }

    pub fn start_foreground_tracking() -> Result<(), PlatformError> {
        Ok(())
    }

    pub fn stop_foreground_tracking() -> Result<(), PlatformError> {
        Ok(())
    }

    pub fn latest_capture_target() -> Result<Option<TargetWindow>, PlatformError> {
        Ok(None)
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

    pub fn snapshot_target(_: TargetWindow) -> Result<WindowSnapshot, PlatformError> {
        Err(PlatformError(
            "Native window placement is only available on Windows.".into(),
        ))
    }

    pub fn tile_target(_: &WindowSnapshot, _: Rect) -> Result<(), PlatformError> {
        Err(PlatformError(
            "Native window placement is only available on Windows.".into(),
        ))
    }

    pub fn restore_target(_: &WindowSnapshot) -> Result<(), PlatformError> {
        Ok(())
    }

    pub fn focus_target(_: &TargetWindow) -> Result<(), PlatformError> {
        Ok(())
    }

    pub fn set_window_rect(_: isize, _: Rect) -> Result<(), PlatformError> {
        Err(PlatformError(
            "Native window placement is only available on Windows.".into(),
        ))
    }
}

#[cfg(not(target_os = "windows"))]
pub use unsupported::{
    cursor_work_area, focus_target, foreground_target, latest_capture_target, restore_target,
    set_window_rect, snapshot_target, start_foreground_tracking, stop_foreground_tracking,
    target_is_captureable, target_is_current, tile_target,
};

fn outer_rect_for_visible(outer: Rect, frame: Rect, visible: Rect) -> Option<Rect> {
    let left = i64::from(frame.x) - i64::from(outer.x);
    let top = i64::from(frame.y) - i64::from(outer.y);
    let right = i64::from(outer.right()) - i64::from(frame.right());
    let bottom = i64::from(outer.bottom()) - i64::from(frame.bottom());
    let bounds = Rect::new(
        i32::try_from(i64::from(visible.x) - left).ok()?,
        i32::try_from(i64::from(visible.y) - top).ok()?,
        i32::try_from(i64::from(visible.width) + left + right).ok()?,
        i32::try_from(i64::from(visible.height) + top + bottom).ok()?,
    );
    (bounds.width > 0 && bounds.height > 0).then_some(bounds)
}

#[cfg(test)]
mod tests {
    use super::{
        outer_rect_for_visible, CaptureFocus, Rect, TargetWindow, WindowPlacement, WindowSnapshot,
    };
    use crate::workspace::Restoration;

    fn external_window(identity: &str) -> TargetWindow {
        TargetWindow {
            opaque_id: identity.into(),
            application_id: Some("explorer.exe".into()),
            bounds: Rect::new(40, 40, 800, 600),
            maximized: false,
            monitor: 0,
            work_area: Rect::new(0, 0, 1920, 1040),
            #[cfg(target_os = "windows")]
            handle: 0,
            #[cfg(target_os = "windows")]
            process_id: 0,
        }
    }

    #[test]
    fn capture_follows_external_focus_and_retains_it_when_aside_gets_focus() {
        let mut focus = CaptureFocus::new();
        focus.observe(true, None);
        assert!(focus.snapshot().is_none());
        focus.observe(false, Some(external_window("first-folder")));
        focus.observe(true, None);
        assert_eq!(focus.snapshot().unwrap().opaque_id, "first-folder");
        focus.observe(false, Some(external_window("second-folder")));
        focus.observe(true, None);
        assert_eq!(focus.snapshot().unwrap().opaque_id, "second-folder");
    }

    #[test]
    fn unsupported_external_focus_clears_the_previous_capture_target() {
        let mut focus = CaptureFocus::new();
        focus.observe(false, Some(external_window("old-folder")));
        focus.observe(false, None);
        focus.observe(true, None);
        assert!(focus.snapshot().is_none());
    }

    #[test]
    fn another_focus_change_cannot_redirect_an_in_progress_capture() {
        let mut focus = CaptureFocus::new();
        focus.observe(false, Some(external_window("captured-folder")));
        let captured = focus.snapshot().unwrap();
        focus.observe(false, Some(external_window("later-folder")));
        assert_eq!(captured.opaque_id, "captured-folder");
        assert_eq!(focus.snapshot().unwrap().opaque_id, "later-folder");
    }

    #[test]
    fn changing_capture_focus_preserves_the_original_restore_target_and_retry() {
        let original = external_window("summoned-from");
        let mut restoration = Restoration::default();
        restoration
            .remember(WindowSnapshot {
                target: original.clone(),
                placement: WindowPlacement::default(),
            })
            .unwrap();
        let mut focus = CaptureFocus::new();
        focus.observe(false, Some(original));
        focus.observe(false, Some(external_window("captured-later")));
        assert!(restoration.restore(|_| Err("retry")).is_err());
        assert_eq!(
            restoration.original().unwrap().target.opaque_id,
            "summoned-from"
        );
        restoration
            .restore::<()>(|snapshot| {
                assert_eq!(snapshot.target.opaque_id, "summoned-from");
                Ok(())
            })
            .unwrap();
        assert_eq!(focus.snapshot().unwrap().opaque_id, "captured-later");
    }

    #[test]
    fn fullscreen_candidate_includes_the_taskbar_area_but_ordinary_windows_do_not() {
        let mut target = TargetWindow {
            opaque_id: "fullscreen".into(),
            application_id: None,
            bounds: Rect::new(0, 0, 1920, 1080),
            maximized: false,
            monitor: 0,
            work_area: Rect::new(0, 0, 1920, 1040),
            #[cfg(target_os = "windows")]
            handle: 0,
            #[cfg(target_os = "windows")]
            process_id: 0,
        };
        assert!(target.is_workspace_candidate());
        target.bounds = Rect::new(40, 40, 800, 600);
        assert!(!target.is_workspace_candidate());
    }

    #[test]
    fn visible_tiling_accounts_for_invisible_resize_borders() {
        let outer = Rect::new(-8, 0, 1936, 1048);
        let frame = Rect::new(0, 0, 1920, 1040);
        let visible = Rect::new(-1920, 40, 1536, 1040);
        assert_eq!(
            outer_rect_for_visible(outer, frame, visible),
            Some(Rect::new(-1928, 40, 1552, 1048))
        );
    }

    #[test]
    fn borderless_windows_keep_the_exact_partition() {
        let rect = Rect::new(0, 0, 1000, 800);
        let visible = Rect::new(40, -900, 800, 900);
        assert_eq!(outer_rect_for_visible(rect, rect, visible), Some(visible));
    }
}
