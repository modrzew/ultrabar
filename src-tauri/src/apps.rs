//! Opening apps for "Open app" actions, and the running-app list the editor
//! offers as a shortcut for choosing one.
//!
//! The official app's "Single Instance" brings a running copy to the front
//! and only starts the app when it isn't running; "New Instance" always
//! starts it (see `docs/protocol.md`, "Start App").

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchMode {
    /// Bring a running copy to the front, or start the app.
    Single,
    /// Start another copy even if one is running.
    New,
}

impl LaunchMode {
    /// The bar's `params.launchMode`. The official app treats 0 as "New
    /// Instance" and anything else as "Single Instance" (it sends 2).
    pub fn from_param(v: Option<i64>) -> Self {
        if v == Some(0) {
            LaunchMode::New
        } else {
            LaunchMode::Single
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunningApp {
    pub name: String,
    /// `.app` bundle on macOS, executable on Windows and Linux.
    pub path: String,
}

/// What the official app shows for a path: the file name without extension.
fn name_from_path(path: &str) -> String {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match file.rfind('.') {
        Some(i) if i > 0 => file[..i].to_string(),
        _ => file.to_string(),
    }
}

/// One entry per app (several windows or processes of the same app are
/// listed once), sorted by name.
fn tidy(apps: Vec<RunningApp>) -> Vec<RunningApp> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<RunningApp> = apps
        .into_iter()
        .filter(|a| !a.path.is_empty() && seen.insert(a.path.to_lowercase()))
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// GUI apps running on this computer, without this app itself
/// (`own_id` is its bundle identifier, used on macOS).
pub async fn running(own_id: &str) -> Result<Vec<RunningApp>, String> {
    imp::running(own_id).await.map(tidy)
}

/// Opens `path` (an app bundle, executable or shortcut) on macOS and Windows.
/// Linux opens files through the opener plugin instead (see `pc_agent`).
#[cfg(any(target_os = "macos", windows))]
pub async fn start(path: &str, mode: LaunchMode) -> Result<(), String> {
    imp::start(path, mode).await
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{LaunchMode, RunningApp};

    /// `open` brings a running app to the front (as the official app's
    /// AppleScript `activate` does) and starts it otherwise; `open -n` starts
    /// another copy. (The official app runs plain `open` for "New Instance"
    /// too, so on macOS its two modes behave the same.)
    pub async fn start(path: &str, mode: LaunchMode) -> Result<(), String> {
        let mut cmd = tokio::process::Command::new("open");
        if mode == LaunchMode::New {
            cmd.arg("-n");
        }
        let out = cmd.arg(path).output().await.map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// Same filter as the official app: running apps with an `.app` bundle
    /// whose Info.plist doesn't set `LSUIElement` (menu bar apps) or
    /// `LSBackgroundOnly`. Read through JavaScript for Automation, which
    /// reaches AppKit without extra permissions.
    const SCRIPT: &str = r#"
ObjC.import('AppKit');
var out = [];
var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
for (var i = 0; i < apps.count; i++) {
  try {
    var a = apps.objectAtIndex(i);
    var url = a.bundleURL;
    if (!url || url.isNil()) continue;
    var path = ObjC.unwrap(url.path);
    if (!path || !path.endsWith('.app')) continue;
    var bundle = $.NSBundle.bundleWithURL(url);
    var info = bundle && !bundle.isNil() ? bundle.infoDictionary : null;
    if (info && !info.isNil()) {
      var ui = info.objectForKey('LSUIElement');
      var bg = info.objectForKey('LSBackgroundOnly');
      if ((!ui.isNil() && ui.boolValue) || (!bg.isNil() && bg.boolValue)) continue;
    }
    out.push({ id: ObjC.unwrap(a.bundleIdentifier) || '', name: ObjC.unwrap(a.localizedName) || '', path: path });
  } catch (e) {}
}
JSON.stringify(out);
"#;

    #[derive(serde::Deserialize)]
    struct Entry {
        id: String,
        name: String,
        path: String,
    }

    pub async fn running(own_id: &str) -> Result<Vec<RunningApp>, String> {
        let out = tokio::process::Command::new("osascript")
            .args(["-l", "JavaScript", "-e", SCRIPT])
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "Couldn't list running apps ({})",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let entries: Vec<Entry> = serde_json::from_slice(&out.stdout)
            .map_err(|_| "Couldn't read the list of running apps".to_string())?;
        Ok(entries
            .into_iter()
            .filter(|e| e.id != own_id)
            .map(|e| RunningApp {
                name: if e.name.is_empty() {
                    super::name_from_path(&e.path)
                } else {
                    e.name
                },
                path: e.path,
            })
            .collect())
    }
}

#[cfg(windows)]
mod imp {
    use super::{LaunchMode, RunningApp};
    use std::collections::HashMap;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, MAX_PATH};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        IPersistFile, STGM_READ,
    };
    use windows::Win32::System::Threading::{
        AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, SLGP_UNCPRIORITY, ShellExecuteW, ShellLink};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GW_OWNER, GetForegroundWindow, GetWindow,
        GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SW_RESTORE,
        SW_SHOWNORMAL, SetForegroundWindow, ShowWindow,
    };
    use windows::core::{BOOL, HSTRING, Interface, PCWSTR, PWSTR, w};

    async fn blocking<T: Send + 'static>(
        f: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| e.to_string())?
    }

    pub async fn start(path: &str, mode: LaunchMode) -> Result<(), String> {
        // The official app compares paths as given, so one picked through its
        // file dialog (forward slashes) never matches a running process.
        let path = path.trim().replace('/', "\\");
        blocking(move || {
            if mode == LaunchMode::Single {
                let target = shortcut_target(&path).unwrap_or_else(|| path.clone());
                if let Some(hwnd) = window_of(&target) {
                    bring_forward(hwnd);
                    return Ok(());
                }
            }
            launch(&path)
        })
        .await
    }

    /// Where a `.lnk` shortcut points (IShellLinkW, as the official app).
    fn shortcut_target(path: &str) -> Option<String> {
        if !path.to_lowercase().ends_with(".lnk") {
            return None;
        }
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            link.cast::<IPersistFile>()
                .ok()?
                .Load(&HSTRING::from(path), STGM_READ)
                .ok()?;
            let mut buf = [0u16; MAX_PATH as usize];
            link.GetPath(&mut buf, std::ptr::null_mut(), SLGP_UNCPRIORITY.0 as u32)
                .ok()?;
            let target = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0)?]);
            (!target.is_empty()).then_some(target)
        }
    }

    fn image_path(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(h);
            r.ok()?;
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    /// Visible top-level windows with a title, with their process ids.
    fn windows_with_titles() -> Vec<(HWND, u32)> {
        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            unsafe {
                let out = &mut *(lparam.0 as *mut Vec<(HWND, u32)>);
                if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(hwnd, Some(&raw mut pid));
                    out.push((hwnd, pid));
                }
            }
            BOOL(1)
        }
        let mut out: Vec<(HWND, u32)> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut out as *mut _ as isize));
        }
        out
    }

    /// The front-most main window (visible, titled, not owned by another
    /// window) of a process running `exe`, compared case-insensitively.
    fn window_of(exe: &str) -> Option<HWND> {
        let exe = exe.to_lowercase();
        let mut paths: HashMap<u32, Option<String>> = HashMap::new();
        windows_with_titles().into_iter().find_map(|(hwnd, pid)| {
            let owned = unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok();
            let path = paths
                .entry(pid)
                .or_insert_with(|| image_path(pid).map(|p| p.to_lowercase()));
            (!owned && path.as_deref() == Some(exe.as_str())).then_some(hwnd)
        })
    }

    /// Restore and focus, attaching to the foreground thread's input so
    /// Windows lets a background app change the focus (as the official app).
    fn bring_forward(hwnd: HWND) {
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let fg = GetWindowThreadProcessId(GetForegroundWindow(), None);
            let me = GetCurrentThreadId();
            let attach = fg != 0 && fg != me;
            if attach {
                let _ = AttachThreadInput(me, fg, true);
            }
            let _ = SetForegroundWindow(hwnd);
            let _ = BringWindowToTop(hwnd);
            if attach {
                let _ = AttachThreadInput(me, fg, false);
            }
        }
    }

    /// ShellExecute "open", which handles `.exe` and `.lnk` alike. Programs
    /// start in their own folder.
    fn launch(path: &str) -> Result<(), String> {
        let dir = std::path::Path::new(path)
            .parent()
            .map(|d| HSTRING::from(d.as_os_str()))
            .unwrap_or_default();
        let dir_arg = if path.to_lowercase().ends_with(".exe") && !dir.is_empty() {
            PCWSTR(dir.as_ptr())
        } else {
            PCWSTR::null()
        };
        let r = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                &HSTRING::from(path),
                PCWSTR::null(),
                dir_arg,
                SW_SHOWNORMAL,
            )
        };
        // Values above 32 mean success.
        if r.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("Windows couldn't open {path} (error {})", r.0 as isize))
        }
    }

    /// Like the official app: processes behind visible, titled top-level
    /// windows.
    pub async fn running(_own_id: &str) -> Result<Vec<RunningApp>, String> {
        blocking(|| {
            let me = unsafe { GetCurrentProcessId() };
            let mut pids: Vec<u32> = windows_with_titles().into_iter().map(|(_, p)| p).collect();
            pids.sort_unstable();
            pids.dedup();
            Ok(pids
                .into_iter()
                .filter(|&p| p != me)
                .filter_map(image_path)
                .map(|path| RunningApp {
                    name: super::name_from_path(&path),
                    path,
                })
                .collect())
        })
        .await
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    //! Linux, best effort: windows listed by `wmctrl` (X11).
    use super::RunningApp;

    pub async fn running(_own_id: &str) -> Result<Vec<RunningApp>, String> {
        let out = tokio::process::Command::new("wmctrl")
            .arg("-lp")
            .output()
            .await
            .map_err(|_| "Listing running apps on Linux needs wmctrl".to_string())?;
        let me = std::process::id();
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(super::wmctrl_pids(&text)
            .into_iter()
            .filter(|&pid| pid != me)
            .filter_map(|pid| std::fs::read_link(format!("/proc/{pid}/exe")).ok())
            .map(|exe| {
                let path = exe.to_string_lossy().to_string();
                RunningApp {
                    name: super::name_from_path(&path),
                    path,
                }
            })
            .collect())
    }
}

/// Process ids from `wmctrl -lp` lines: `<window id> <desktop> <pid> <host> <title>`.
#[cfg(any(test, not(any(target_os = "macos", windows))))]
fn wmctrl_pids(text: &str) -> Vec<u32> {
    text.lines()
        .filter_map(|l| l.split_whitespace().nth(2)?.parse().ok())
        .filter(|&pid| pid > 0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_mode_follows_the_official_numbers() {
        assert_eq!(LaunchMode::from_param(Some(0)), LaunchMode::New);
        assert_eq!(LaunchMode::from_param(Some(2)), LaunchMode::Single);
        assert_eq!(LaunchMode::from_param(Some(1)), LaunchMode::Single);
        assert_eq!(LaunchMode::from_param(None), LaunchMode::Single);
    }

    #[test]
    fn names_come_from_the_file_name() {
        assert_eq!(name_from_path("/Applications/Safari.app"), "Safari");
        assert_eq!(name_from_path("C:\\Program Files\\Mozilla Firefox\\firefox.exe"), "firefox");
        assert_eq!(name_from_path("/usr/bin/gnome-terminal"), "gnome-terminal");
        assert_eq!(name_from_path("/opt/.hidden"), ".hidden");
    }

    #[test]
    fn tidy_lists_each_app_once_by_name() {
        let app = |name: &str, path: &str| RunningApp {
            name: name.into(),
            path: path.into(),
        };
        let out = tidy(vec![
            app("notepad", "C:\\Windows\\notepad.exe"),
            app("Code", "C:\\VS Code\\Code.exe"),
            app("notepad", "c:\\windows\\NOTEPAD.EXE"),
            app("ghost", ""),
        ]);
        assert_eq!(
            out,
            vec![
                app("Code", "C:\\VS Code\\Code.exe"),
                app("notepad", "C:\\Windows\\notepad.exe")
            ]
        );
    }

    #[test]
    fn reads_pids_from_wmctrl() {
        let text = "0x03a00003  0 4242   host Terminal\n0x04000001 -1 0      host Desktop\n0x05000007  0 77 host Files — Home\n";
        assert_eq!(wmctrl_pids(text), vec![4242, 77]);
    }
}
