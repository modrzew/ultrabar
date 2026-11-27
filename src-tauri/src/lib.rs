mod apps;
mod connection;
mod discord;
mod discovery;
mod icons;
mod market;
mod metrics;
mod packs;
mod pc_agent;
mod protocol;
mod screen;
mod store;
mod system;
mod tls;
mod tray;
mod typing;

use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use connection::{ConnHandle, ConnState, RequestError, Status};
use discovery::FoundBar;
use store::{Settings, Store};

pub struct AppState {
    pub store: Store,
    pub settings: Mutex<Settings>,
    pub status: Mutex<Status>,
    conn: Mutex<Option<ConnHandle>>,
    icons: Arc<icons::IconServer>,
    pub discord: discord::Discord,
    packs: packs::Packs,
}

impl AppState {
    fn conn(&self) -> Option<ConnHandle> {
        self.conn.lock().unwrap().clone()
    }

    fn replace_conn(&self, next: Option<ConnHandle>) {
        if let Some(old) = std::mem::replace(&mut *self.conn.lock().unwrap(), next) {
            old.stop();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    client_id: String,
    hostname: String,
    version: String,
    pc_agent_enabled: bool,
    close_to_tray: bool,
    icon_port: u16,
}

#[tauri::command]
fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    let s = state.settings.lock().unwrap();
    AppInfo {
        client_id: s.client_id.clone(),
        hostname: gethostname::gethostname().to_string_lossy().to_string(),
        version: app.package_info().version.to_string(),
        pc_agent_enabled: s.pc_agent_enabled,
        close_to_tray: s.close_to_tray,
        icon_port: state.icons.port(),
    }
}

#[tauri::command]
async fn discover_bars(
    timeout_ms: Option<u64>,
    extra: Option<Vec<String>>,
) -> Result<Vec<FoundBar>, String> {
    let extra: Vec<Ipv4Addr> = extra
        .unwrap_or_default()
        .iter()
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2500).clamp(300, 15000));
    discovery::discover(timeout, &extra)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn bar_status(state: State<'_, AppState>) -> Status {
    state.status.lock().unwrap().clone()
}

/// Select a bar and (re)connect to it. With `pair`, immediately ask the bar
/// to approve this computer if we don't hold a token for it yet.
#[tauri::command]
fn connect_bar(
    app: AppHandle,
    state: State<'_, AppState>,
    bar: FoundBar,
    pair: bool,
) -> Result<(), String> {
    let saved = {
        let mut s = state.settings.lock().unwrap();
        s.upsert_bar(&bar);
        s.current_bar = Some(bar.serial_no.clone());
        state.store.save_settings(&s).map_err(|e| e.to_string())?;
        s.current().cloned().expect("just inserted")
    };
    state.replace_conn(Some(connection::spawn(app, saved, pair)));
    Ok(())
}

#[tauri::command]
fn pair_bar(state: State<'_, AppState>) -> Result<(), String> {
    state.conn().ok_or("No bar selected")?.pair();
    Ok(())
}

#[tauri::command]
fn reconnect_bar(state: State<'_, AppState>) -> Result<(), String> {
    state.conn().ok_or("No bar selected")?.reconnect();
    Ok(())
}

/// Disconnect and forget the current bar's pairing on this computer.
#[tauri::command]
fn forget_bar(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.replace_conn(None);
    {
        let mut s = state.settings.lock().unwrap();
        if let Some(serial) = s.current_bar.take() {
            s.bars.retain(|b| b.serial_no != serial);
        }
        state.store.save_settings(&s).map_err(|e| e.to_string())?;
    }
    let idle = Status::idle();
    *state.status.lock().unwrap() = idle.clone();
    let _ = app.emit("bar-status", &idle);
    Ok(())
}

#[tauri::command]
async fn bar_request(
    state: State<'_, AppState>,
    act: i64,
    data: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, RequestError> {
    let conn = state.conn().ok_or(RequestError {
        code: -2,
        message: "No bar selected".into(),
    })?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(8000));
    conn.request(act, data, timeout).await
}

/// Make the bar redraw its home screen (best effort; see `screen`).
#[tauri::command]
async fn refresh_bar_screen(state: State<'_, AppState>) -> Result<(), String> {
    let ip = state
        .status
        .lock()
        .unwrap()
        .bar
        .as_ref()
        .map(|b| b.ip.clone())
        .ok_or("No bar selected")?;
    screen::reload_home_screen(&ip).await
}

/// Apps in the vendor's store (the bar downloads and installs them itself),
/// optionally matching a search.
#[tauri::command]
async fn store_apps(keyword: Option<String>) -> Result<Vec<market::StoreApp>, String> {
    market::apps(keyword.as_deref()).await
}

/// Shortcut packs ("plugins") in the vendor's store, optionally matching a search.
#[tauri::command]
async fn store_plugins(keyword: Option<String>) -> Result<Vec<market::StorePlugin>, String> {
    market::plugins(keyword.as_deref()).await
}

/// The store's latest version of an installed app (null: not in the store).
#[tauri::command]
async fn store_app_latest(package: String) -> Result<Option<market::StoreApp>, String> {
    market::latest_app(&package).await
}

/// The cloud icon library's filters (group, category, style).
#[tauri::command]
async fn icon_library_tags() -> Result<market::IconTags, String> {
    market::icon_tags().await
}

/// One page of the cloud icon library.
#[tauri::command]
async fn icon_library_page(query: market::IconQuery) -> Result<market::IconPage, String> {
    market::icon_page(&query).await
}

/// A picked library icon as a data URL.
#[tauri::command]
async fn icon_library_image(url: String) -> Result<String, String> {
    market::icon_image(&url).await
}

/// Shortcut packs installed on this computer.
#[tauri::command]
fn installed_packs(state: State<'_, AppState>) -> Vec<packs::InstalledPack> {
    state.packs.list()
}

/// Downloads a pack (checked against the store's hash) and keeps it. Also
/// reloads or updates an installed one, given its latest store record.
#[tauri::command]
async fn install_pack(
    state: State<'_, AppState>,
    plugin: market::StorePlugin,
) -> Result<packs::InstalledPack, String> {
    let pack = market::pack(&plugin.file, &plugin.sha256, plugin.icon.as_deref()).await?;
    state.packs.save(plugin, pack)
}

#[tauri::command]
fn uninstall_pack(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    state.packs.remove(id)
}

#[tauri::command]
fn load_doc(state: State<'_, AppState>) -> Option<Value> {
    state.store.load_doc()
}

#[tauri::command]
fn save_doc(state: State<'_, AppState>, doc: Value) -> Result<(), String> {
    state.store.save_doc(&doc).map_err(|e| e.to_string())
}

/// Replace the PC-control allowlist with the actions of a successful deploy.
#[tauri::command]
fn set_allowed_actions(state: State<'_, AppState>, actions: Vec<Value>) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    s.allowed_actions = actions;
    state.store.save_settings(&s).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_pc_agent_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    s.pc_agent_enabled = enabled;
    state.store.save_settings(&s).map_err(|e| e.to_string())
}

/// Keep running with a tray icon when the window is closed.
#[tauri::command]
fn set_close_to_tray(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    tray::set_enabled(&app, enabled).map_err(|e| format!("Couldn't add the tray icon: {e}"))?;
    let mut s = state.settings.lock().unwrap();
    s.close_to_tray = enabled;
    state.store.save_settings(&s).map_err(|e| e.to_string())
}

/// Run a PC-control action locally (the "Test" button in the editor).
#[tauri::command]
async fn test_pc_action(app: AppHandle, payload: Value) -> Result<(), String> {
    pc_agent::execute(&app, &payload).await
}

/// GUI apps running on this computer, for choosing an "Open app" target.
#[tauri::command]
async fn running_apps(app: AppHandle) -> Result<Vec<apps::RunningApp>, String> {
    apps::running(&app.config().identifier).await
}

/// The bar's Home Assistant app reports on its own web page whether it's
/// logged in to Home Assistant (no session token needed for this one).
#[tauri::command]
async fn ha_logged_in(state: State<'_, AppState>, port: u16) -> Result<bool, String> {
    let ip = state
        .status
        .lock()
        .unwrap()
        .bar
        .as_ref()
        .map(|b| b.ip.clone())
        .ok_or("No bar selected")?;
    let body: Value = market::client()
        .get(format!("http://{ip}:{port}/status"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(body.get("data").and_then(|d| d.as_bool()).unwrap_or(false))
}

#[tauri::command]
async fn discord_status(state: State<'_, AppState>) -> Result<discord::Status, String> {
    Ok(state.discord.status().await)
}

#[tauri::command]
async fn discord_set_app(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<discord::Status, String> {
    state.discord.set_app(client_id, client_secret).await;
    Ok(state.discord.status().await)
}

/// Discord shows an "Authorize" prompt; this waits for the user to answer.
#[tauri::command]
async fn discord_sign_in(state: State<'_, AppState>) -> Result<discord::Status, String> {
    state.discord.sign_in().await
}

#[tauri::command]
async fn discord_sign_out(state: State<'_, AppState>) -> Result<discord::Status, String> {
    state.discord.sign_out().await;
    Ok(state.discord.status().await)
}

/// Connect to the Discord app if needed and report whether it works.
#[tauri::command]
async fn discord_check(state: State<'_, AppState>) -> Result<discord::Status, String> {
    state.discord.check().await
}

#[tauri::command]
async fn discord_voice_channels(state: State<'_, AppState>) -> Result<Vec<discord::Guild>, String> {
    state.discord.voice_channels().await
}

#[tauri::command]
async fn discord_sounds(state: State<'_, AppState>) -> Result<Vec<discord::Sound>, String> {
    state.discord.sounds().await
}

/// Store a PNG image (data URL or base64) for the bar; returns its id.
#[tauri::command]
fn store_icon(state: State<'_, AppState>, data: String) -> Result<String, String> {
    state.icons.put(&data)
}

/// Where the bar loads stored images from this computer:
/// `<base><id>.png`. Used by firmware without the asset upload, and when an
/// upload fails.
#[tauri::command]
fn icon_http_base(state: State<'_, AppState>) -> Result<String, String> {
    let port = state.icons.port();
    if port == 0 {
        return Err("The icon server isn't running".into());
    }
    let ip = state
        .status
        .lock()
        .unwrap()
        .local_ip
        .clone()
        .or_else(lan_ip)
        .ok_or("Couldn't determine this computer's network address")?;
    Ok(format!("http://{ip}:{port}/i/"))
}

/// Replace this app's images on the bar (launcher 1.0.9+) with the given
/// stored ones. They're then reachable as `file://ultrabar-app/image/<id>.png`.
#[tauri::command]
async fn upload_bar_images(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    let ip = state
        .status
        .lock()
        .unwrap()
        .bar
        .as_ref()
        .map(|b| b.ip.clone())
        .ok_or("No bar selected")?;
    let zip = state.icons.zip(&ids)?;
    screen::upload_images(&ip, &zip).await
}

/// Export/import of the layout file at a path the user picked in a dialog.
#[tauri::command]
fn write_json_file(path: String, value: Value) -> Result<(), String> {
    if !path.to_lowercase().ends_with(".json") {
        return Err("Choose a .json file".into());
    }
    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_json_file(path: String) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "That file isn't valid JSON".to_string())
}

fn lan_ip() -> Option<String> {
    if_addrs::get_if_addrs()
        .ok()?
        .into_iter()
        .find_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) if !i.is_loopback() && !v4.ip.is_link_local() => {
                Some(v4.ip.to_string())
            }
            _ => None,
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered first so a second launch exits before setting anything
        // up. It brings this window to the front instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_window(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // The app updates itself from the GitHub releases, then relaunches into the new version.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir");
            let store = Store::new(dir.clone());
            let settings = store.load_settings();
            let icons = icons::IconServer::new(dir.join("icons"));
            tauri::async_runtime::spawn(icons.clone().serve());

            let current = settings.current().cloned();
            if settings.close_to_tray
                && let Err(e) = tray::set_enabled(app.handle(), true)
            {
                eprintln!("tray: {e}");
            }
            app.manage(AppState {
                store,
                settings: Mutex::new(settings),
                status: Mutex::new(Status::idle()),
                conn: Mutex::new(None),
                icons,
                discord: discord::Discord::new(dir.clone()),
                packs: packs::Packs::new(dir.join("packs")),
            });

            // Reconnect to the last bar on launch.
            if let Some(bar) = current {
                let state = app.state::<AppState>();
                let mut st = state.status.lock().unwrap();
                st.state = ConnState::Connecting;
                st.bar = Some(bar.clone());
                drop(st);
                state.replace_conn(Some(connection::spawn(app.handle().clone(), bar, false)));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && tray::active(window.app_handle())
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            discover_bars,
            bar_status,
            connect_bar,
            pair_bar,
            reconnect_bar,
            forget_bar,
            bar_request,
            refresh_bar_screen,
            store_apps,
            store_plugins,
            store_app_latest,
            installed_packs,
            install_pack,
            uninstall_pack,
            icon_library_tags,
            icon_library_page,
            icon_library_image,
            load_doc,
            save_doc,
            set_allowed_actions,
            set_pc_agent_enabled,
            set_close_to_tray,
            test_pc_action,
            running_apps,
            ha_logged_in,
            discord_status,
            discord_set_app,
            discord_sign_in,
            discord_sign_out,
            discord_check,
            discord_voice_channels,
            discord_sounds,
            store_icon,
            icon_http_base,
            upload_bar_images,
            write_json_file,
            read_json_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            // Clicking the Dock icon while the window is hidden in the menu bar.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = _event
            {
                tray::show_window(_app);
            }
        });
}
