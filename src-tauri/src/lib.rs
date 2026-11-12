mod connection;
mod discovery;
mod icons;
mod pc_agent;
mod protocol;
mod store;
mod tls;

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

/// Run a PC-control action locally (the "Test" button in the editor).
#[tauri::command]
async fn test_pc_action(app: AppHandle, payload: Value) -> Result<(), String> {
    pc_agent::execute(&app, &payload).await
}

/// Store a PNG icon and return the URL the bar should load it from.
#[tauri::command]
fn publish_icon(state: State<'_, AppState>, data: String) -> Result<String, String> {
    let hash = state.icons.put(&data)?;
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
    Ok(format!("http://{ip}:{port}/i/{hash}.png"))
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir");
            let store = Store::new(dir.clone());
            let settings = store.load_settings();
            let icons = icons::IconServer::new(dir.join("icons"));
            tauri::async_runtime::spawn(icons.clone().serve());

            let current = settings.current().cloned();
            app.manage(AppState {
                store,
                settings: Mutex::new(settings),
                status: Mutex::new(Status::idle()),
                conn: Mutex::new(None),
                icons,
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
        .invoke_handler(tauri::generate_handler![
            app_info,
            discover_bars,
            bar_status,
            connect_bar,
            pair_bar,
            reconnect_bar,
            forget_bar,
            bar_request,
            load_doc,
            save_doc,
            set_allowed_actions,
            set_pc_agent_enabled,
            test_pc_action,
            publish_icon,
            write_json_file,
            read_json_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
