//! Typing text into whatever app has focus ("Type text" actions).

#[cfg(target_os = "macos")]
pub async fn type_text(text: &str) -> Result<(), String> {
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("tell application \"System Events\" to keystroke \"{escaped}\"");
    let out = tokio::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "macOS refused to type text. Allow ultrabar under System Settings › Privacy & Security › Accessibility. ({})",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Like the official app: puts the text on the clipboard and presses Ctrl+V
/// with `SendInput`. Line breaks and tabs are pasted as they are, and the
/// clipboard keeps the text afterwards (the official app doesn't restore it
/// either; restoring it right away could race the paste).
#[cfg(windows)]
pub async fn type_text(text: &str) -> Result<(), String> {
    let text = text.to_string();
    tokio::task::spawn_blocking(move || win::paste(&text))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
mod win {
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
        VIRTUAL_KEY, VK_CONTROL, VK_V,
    };

    pub fn paste(text: &str) -> Result<(), String> {
        set_clipboard(text)?;
        let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let keys = [
            key(VK_CONTROL, false),
            key(VK_V, false),
            key(VK_V, true),
            key(VK_CONTROL, true),
        ];
        let sent = unsafe { SendInput(&keys, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize == keys.len() {
            Ok(())
        } else {
            Err("Windows didn't accept the Ctrl+V keystroke (an app running as administrator may have focus)".into())
        }
    }

    fn set_clipboard(text: &str) -> Result<(), String> {
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        // Another app may hold the clipboard for a moment.
        let mut opened = false;
        for _ in 0..10 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !opened {
            return Err("Another app is using the clipboard".into());
        }
        let r = unsafe {
            (|| -> windows::core::Result<()> {
                EmptyClipboard()?;
                let mem = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2)?;
                let ptr = GlobalLock(mem) as *mut u16;
                if ptr.is_null() {
                    let _ = GlobalFree(Some(mem));
                    return Err(windows::core::Error::from_thread());
                }
                std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
                let _ = GlobalUnlock(mem);
                // The clipboard owns the memory once this succeeds.
                if let Err(e) = SetClipboardData(u32::from(CF_UNICODETEXT.0), Some(HANDLE(mem.0))) {
                    let _ = GlobalFree(Some(mem));
                    return Err(e);
                }
                Ok(())
            })()
        };
        let _ = unsafe { CloseClipboard() };
        r.map_err(|e| format!("Couldn't put the text on the clipboard: {}", e.message()))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub async fn type_text(text: &str) -> Result<(), String> {
    tokio::process::Command::new("xdotool")
        .args(["type", "--", text])
        .status()
        .await
        .map_err(|e| format!("xdotool not available: {e}"))
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err("xdotool failed".into())
            }
        })
}
