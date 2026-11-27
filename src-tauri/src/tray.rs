//! Optional tray icon (Windows notification area, macOS menu bar). While it's
//! on, closing the window hides it instead of quitting, so computer actions
//! and the icon server keep working for the bar.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const ID: &str = "main";

pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Whether closing the window should hide it. Only while the tray icon
/// exists, so the window can always be brought back.
pub fn active(app: &AppHandle) -> bool {
    app.tray_by_id(ID).is_some()
}

pub fn set_enabled(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
    if !enabled {
        app.remove_tray_by_id(ID);
        return Ok(());
    }
    if active(app) {
        return Ok(());
    }
    let show = MenuItem::with_id(app, "tray-show", "Show ultrabar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit ultrabar", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id(ID)
        .tooltip("ultrabar")
        .menu(&menu)
        // Menu-bar icons open their menu on click; on Windows a click shows the window.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
