//! Native output identity for app-local volume profiles. No system volume is changed.

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void, CStr};
    use std::sync::{mpsc, OnceLock};
    use tauri::Manager;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }
    const fn address(selector: &[u8; 4], scope: &[u8; 4]) -> Address {
        Address {
            selector: u32::from_be_bytes(*selector),
            scope: u32::from_be_bytes(*scope),
            element: 0,
        }
    }
    const DEFAULT: Address = address(b"dOut", b"glob");
    const SOURCE: Address = address(b"ssrc", b"outp");
    type Listener = unsafe extern "C" fn(u32, u32, *const Address, *mut c_void) -> i32;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
        fn AudioObjectAddPropertyListener(
            object: u32,
            address: *const Address,
            listener: Listener,
            context: *mut c_void,
        ) -> i32;
        fn AudioObjectRemovePropertyListener(
            object: u32,
            address: *const Address,
            listener: Listener,
            context: *mut c_void,
        ) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetLength(value: *const c_void) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(
            value: *const c_void,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(value: *const c_void);
    }

    /// All callers use Core Audio scalar or CFString properties with their exact ABI types.
    unsafe fn property<T: Copy>(object: u32, address: Address) -> Option<T> {
        let mut result = std::mem::MaybeUninit::<T>::uninit();
        let mut size = std::mem::size_of::<T>() as u32;
        let status = AudioObjectGetPropertyData(
            object,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            result.as_mut_ptr().cast(),
        );
        (status == 0 && size as usize == std::mem::size_of::<T>()).then(|| result.assume_init())
    }

    fn string(object: u32, selector: &[u8; 4]) -> Option<String> {
        // Core Audio transfers ownership of these CFString properties to the caller.
        unsafe {
            let value: *const c_void = property(object, address(selector, b"glob"))?;
            if value.is_null() {
                return None;
            }
            const UTF8: u32 = 0x08000100;
            let capacity = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), UTF8) + 1;
            if capacity <= 0 {
                CFRelease(value);
                return None;
            }
            let mut bytes = vec![0u8; capacity as usize];
            let ok = CFStringGetCString(value, bytes.as_mut_ptr().cast(), capacity, UTF8) != 0;
            CFRelease(value);
            ok.then(|| {
                CStr::from_ptr(bytes.as_ptr().cast())
                    .to_string_lossy()
                    .into_owned()
            })
        }
    }

    fn device() -> Option<u32> {
        // kAudioObjectSystemObject is 1; this property returns an AudioDeviceID.
        unsafe { property(1, DEFAULT) }.filter(|id| *id != 0)
    }

    pub fn current() -> Option<serde_json::Value> {
        let device = device()?;
        let uid = string(device, b"uid ")?;
        let name = string(device, b"lnam")?;
        let source: Option<u32> = unsafe { property(device, SOURCE) };
        let transport: Option<u32> = unsafe { property(device, address(b"tran", b"glob")) };
        // A built-in analogue jack can share a device UID with the speakers.
        // Include its data source so plugging headphones in gets a distinct profile.
        let built_in = transport == Some(u32::from_be_bytes(*b"bltn"));
        let speakers = built_in
            && (source
                .map(|s| s == u32::from_be_bytes(*b"ispk"))
                .unwrap_or_else(|| name.to_lowercase().contains("speakers")));
        Some(serde_json::json!({
            "id": format!("{uid}:{}", source.map(|s| s.to_string()).unwrap_or_default()),
            "name": name,
            "builtInSpeakers": speakers,
        }))
    }

    #[cfg(test)]
    mod tests {
        #[test]
        #[ignore = "needs a live Mac audio output"]
        fn identifies_live_output_with_a_persistent_profile_key() {
            let first = super::current().expect("no default output");
            let second = super::current().expect("default output disappeared");
            assert_eq!(first["id"], second["id"]);
            assert!(!first["id"].as_str().unwrap().is_empty());
            assert!(!first["name"].as_str().unwrap().is_empty());
            assert!(first["builtInSpeakers"].is_boolean());
        }
    }

    static CHANGES: OnceLock<mpsc::Sender<()>> = OnceLock::new();
    unsafe extern "C" fn changed(_: u32, _: u32, _: *const Address, _: *mut c_void) -> i32 {
        if let Some(tx) = CHANGES.get() {
            let _ = tx.send(());
        }
        0
    }

    struct Watch {
        device: u32,
        address: Address,
    }
    impl Watch {
        fn new(device: u32, address: Address) -> Option<Self> {
            let status = unsafe {
                AudioObjectAddPropertyListener(device, &address, changed, std::ptr::null_mut())
            };
            (status == 0).then_some(Self { device, address })
        }
    }
    impl Drop for Watch {
        fn drop(&mut self) {
            unsafe {
                AudioObjectRemovePropertyListener(
                    self.device,
                    &self.address,
                    changed,
                    std::ptr::null_mut(),
                );
            }
        }
    }

    pub fn start(app: tauri::AppHandle) {
        let (tx, rx) = mpsc::channel();
        if CHANGES.set(tx).is_err() {
            return;
        }
        std::thread::spawn(move || {
            let Some(_default) = Watch::new(1, DEFAULT) else {
                log::warn!("Could not watch the default audio output");
                return;
            };
            let mut watched = None;
            let mut _source = None;
            loop {
                let next = device();
                if next != watched {
                    _source = next.and_then(|id| Watch::new(id, SOURCE));
                    watched = next;
                }
                let output = current();
                if let Some(window) = app.get_webview_window("main") {
                    let detail = serde_json::to_string(&output).unwrap_or_else(|_| "null".into());
                    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('homearpa-audio-output',{{detail:{detail}}}))"));
                }
                if rx.recv().is_err() {
                    break;
                }
            }
        });
    }
}

pub fn current() -> Option<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        mac::current()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub fn start(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    mac::start(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn initialization_script() -> &'static str {
    if cfg!(target_os = "macos") {
        "window.__homearpaOutputVolumeEnabled = true;"
    } else {
        ""
    }
}
