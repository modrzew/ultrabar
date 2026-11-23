//! This computer's output volume (0–100, and muted or not) and display
//! brightness (0–100).
//!
//! The bar asks for these when a Knob module is set to control the computer
//! (`SET_VOLUME`/`GET_VOLUME`, `SET_BRIGHTNESS`/`GET_BRIGHTNESS` pushes). It
//! polls the current value every few seconds while the knob is bound, so the
//! getters have to be cheap. `GET_MUTE`/`SET_MUTE` are answered like the
//! official app does, though no bar firmware sends them yet.

pub async fn get_volume() -> Result<u8, String> {
    imp::get_volume().await
}

pub async fn set_volume(v: u8) -> Result<(), String> {
    imp::set_volume(v.min(100)).await
}

pub async fn get_mute() -> Result<bool, String> {
    imp::get_mute().await
}

pub async fn set_mute(muted: bool) -> Result<(), String> {
    imp::set_mute(muted).await
}

pub async fn get_brightness() -> Result<u8, String> {
    imp::get_brightness().await
}

pub async fn set_brightness(v: u8) -> Result<(), String> {
    imp::set_brightness(v.min(100)).await
}

fn pct(f: f32) -> u8 {
    (f.clamp(0.0, 1.0) * 100.0).round() as u8
}

#[cfg(target_os = "macos")]
mod imp {
    use super::pct;

    async fn osascript(script: &str) -> Result<String, String> {
        let out = tokio::process::Command::new("osascript")
            .args(["-e", script])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    pub async fn get_volume() -> Result<u8, String> {
        let s = osascript("output volume of (get volume settings)").await?;
        // "missing value" when the output device has no volume control.
        s.parse::<u8>()
            .map_err(|_| "This Mac's output device has no volume control".to_string())
    }

    pub async fn set_volume(v: u8) -> Result<(), String> {
        osascript(&format!("set volume output volume {v}"))
            .await
            .map(|_| ())
    }

    pub async fn get_mute() -> Result<bool, String> {
        // "missing value" when the output device can't be muted.
        match osascript("output muted of (get volume settings)").await?.as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err("This Mac's output device can't be muted".into()),
        }
    }

    pub async fn set_mute(muted: bool) -> Result<(), String> {
        osascript(&format!("set volume output muted {muted}"))
            .await
            .map(|_| ())
    }

    // Built-in and Apple displays, through the private DisplayServices
    // framework (what the brightness keys use). External monitors would need
    // DDC/CI, which isn't supported here.
    type GetFn = unsafe extern "C" fn(u32, *mut f32) -> i32;
    type SetFn = unsafe extern "C" fn(u32, f32) -> i32;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGMainDisplayID() -> u32;
    }

    fn display_services() -> Option<(GetFn, SetFn)> {
        use std::sync::OnceLock;
        static FNS: OnceLock<Option<(usize, usize)>> = OnceLock::new();
        let (g, s) = (*FNS.get_or_init(|| unsafe {
            let path =
                c"/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices";
            let h = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY);
            if h.is_null() {
                return None;
            }
            let g = libc::dlsym(h, c"DisplayServicesGetBrightness".as_ptr());
            let s = libc::dlsym(h, c"DisplayServicesSetBrightness".as_ptr());
            (!g.is_null() && !s.is_null()).then_some((g as usize, s as usize))
        }))?;
        // SAFETY: both symbols have these C signatures in DisplayServices.
        unsafe {
            Some((
                std::mem::transmute::<usize, GetFn>(g),
                std::mem::transmute::<usize, SetFn>(s),
            ))
        }
    }

    const UNSUPPORTED: &str =
        "Can't change this display's brightness (only built-in and Apple displays are supported)";

    pub async fn get_brightness() -> Result<u8, String> {
        let (get, _) = display_services().ok_or(UNSUPPORTED)?;
        let mut v = 0f32;
        let rc = unsafe { get(CGMainDisplayID(), &mut v) };
        if rc == 0 {
            Ok(pct(v))
        } else {
            Err(UNSUPPORTED.into())
        }
    }

    pub async fn set_brightness(v: u8) -> Result<(), String> {
        let (_, set) = display_services().ok_or(UNSUPPORTED)?;
        let rc = unsafe { set(CGMainDisplayID(), v as f32 / 100.0) };
        if rc == 0 {
            Ok(())
        } else {
            Err(UNSUPPORTED.into())
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::pct;
    use windows::Win32::Devices::Display::{
        DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
        GetPhysicalMonitorsFromHMONITOR, PHYSICAL_MONITOR, SetMonitorBrightness,
    };
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTOPRIMARY, MonitorFromPoint};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        IMMDeviceEnumerator, MMDeviceEnumerator, eConsole, eRender,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
    };

    /// Runs `f` on a blocking thread with COM initialised.
    async fn com<T: Send + 'static>(
        f: impl FnOnce() -> windows::core::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        tokio::task::spawn_blocking(move || {
            // S_FALSE (already initialised on this thread) is fine too.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            f()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message().to_string())
    }

    fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
        unsafe {
            let devices: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
            device.Activate(CLSCTX_ALL, None)
        }
    }

    pub async fn get_volume() -> Result<u8, String> {
        com(|| unsafe { endpoint()?.GetMasterVolumeLevelScalar() })
            .await
            .map(pct)
    }

    pub async fn set_volume(v: u8) -> Result<(), String> {
        com(move || unsafe {
            endpoint()?.SetMasterVolumeLevelScalar(v as f32 / 100.0, std::ptr::null())
        })
        .await
    }

    pub async fn get_mute() -> Result<bool, String> {
        com(|| unsafe { endpoint()?.GetMute() })
            .await
            .map(|b| b.as_bool())
    }

    pub async fn set_mute(muted: bool) -> Result<(), String> {
        com(move || unsafe { endpoint()?.SetMute(muted, std::ptr::null()) }).await
    }

    const UNSUPPORTED: &str = "The main display doesn't accept brightness changes from Windows (DDC/CI may be turned off in its menu)";

    /// Calls `f` with the primary monitor's physical handle (DDC/CI, as the
    /// official app does). Laptop panels usually don't support this.
    fn with_monitor<T>(
        f: impl FnOnce(windows::Win32::Foundation::HANDLE) -> Option<T>,
    ) -> Option<T> {
        unsafe {
            let hmon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let mut n = 0u32;
            GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, &mut n).ok()?;
            if n == 0 {
                return None;
            }
            let mut mons = vec![PHYSICAL_MONITOR::default(); n as usize];
            GetPhysicalMonitorsFromHMONITOR(hmon, &mut mons).ok()?;
            let out = f(mons[0].hPhysicalMonitor);
            let _ = DestroyPhysicalMonitors(&mons);
            out
        }
    }

    pub async fn get_brightness() -> Result<u8, String> {
        tokio::task::spawn_blocking(|| {
            with_monitor(|h| unsafe {
                let (mut min, mut cur, mut max) = (0u32, 0u32, 0u32);
                if GetMonitorBrightness(h, &mut min, &mut cur, &mut max) == 0 || max <= min {
                    return None;
                }
                Some(pct((cur - min) as f32 / (max - min) as f32))
            })
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| UNSUPPORTED.to_string())
    }

    pub async fn set_brightness(v: u8) -> Result<(), String> {
        tokio::task::spawn_blocking(move || {
            with_monitor(|h| unsafe {
                let (mut min, mut cur, mut max) = (0u32, 0u32, 0u32);
                if GetMonitorBrightness(h, &mut min, &mut cur, &mut max) == 0 || max <= min {
                    return None;
                }
                let target = min + ((max - min) as f32 * v as f32 / 100.0).round() as u32;
                (SetMonitorBrightness(h, target) != 0).then_some(())
            })
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| UNSUPPORTED.to_string())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    //! Linux, for development: PipeWire/PulseAudio and brightnessctl.

    async fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
        let out = tokio::process::Command::new(cmd)
            .args(args)
            .output()
            .await
            .map_err(|e| format!("{cmd} isn't available: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    pub async fn get_volume() -> Result<u8, String> {
        // "Volume: 0.45" (with " [MUTED]" when muted)
        let s = run("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"]).await?;
        let v: f32 = s
            .split_whitespace()
            .nth(1)
            .and_then(|x| x.parse().ok())
            .ok_or("Unexpected wpctl output")?;
        Ok(super::pct(v))
    }

    pub async fn set_volume(v: u8) -> Result<(), String> {
        run(
            "wpctl",
            &["set-volume", "@DEFAULT_AUDIO_SINK@", &format!("{v}%")],
        )
        .await
        .map(|_| ())
    }

    pub async fn get_mute() -> Result<bool, String> {
        let s = run("wpctl", &["get-volume", "@DEFAULT_AUDIO_SINK@"]).await?;
        Ok(s.contains("[MUTED]"))
    }

    pub async fn set_mute(muted: bool) -> Result<(), String> {
        let v = if muted { "1" } else { "0" };
        run("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", v])
            .await
            .map(|_| ())
    }

    pub async fn get_brightness() -> Result<u8, String> {
        let cur: f32 = run("brightnessctl", &["get"])
            .await?
            .trim()
            .parse()
            .map_err(|_| "Unexpected brightnessctl output")?;
        let max: f32 = run("brightnessctl", &["max"])
            .await?
            .trim()
            .parse()
            .map_err(|_| "Unexpected brightnessctl output")?;
        if max <= 0.0 {
            return Err("No backlight found".into());
        }
        Ok(super::pct(cur / max))
    }

    pub async fn set_brightness(v: u8) -> Result<(), String> {
        run("brightnessctl", &["set", &format!("{v}%")])
            .await
            .map(|_| ())
    }
}
