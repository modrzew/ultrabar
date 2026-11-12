//! Handles requests the bar pushes to this computer (`act 1000000`).
//!
//! The official app executes whatever the bar sends. Here a PC-control
//! request only runs if its payload exactly matches an action that was part
//! of the last layout deployed from this app.

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::AppState;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PcActionEvent {
    payload: Value,
    ok: bool,
    error: Option<String>,
    at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Returns the `data` for the reply envelope.
pub async fn handle(app: &AppHandle, data: Value) -> Value {
    let kind = data
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let payload = data.get("payload").cloned().unwrap_or(Value::Null);

    if kind == "PC_CONTROL" {
        let (enabled, allowed) = {
            let state = app.state::<AppState>();
            let s = state.settings.lock().unwrap();
            (
                s.pc_agent_enabled,
                s.allowed_actions.iter().any(|a| same_action(a, &payload)),
            )
        };
        let result = if !enabled {
            Err("PC actions are turned off in Settings".to_string())
        } else if !allowed {
            Err("Blocked: this action isn't part of the layout you deployed".to_string())
        } else {
            execute(app, &payload).await
        };
        let _ = app.emit(
            "pc-action",
            PcActionEvent {
                payload,
                ok: result.is_ok(),
                error: result.err(),
                at: now_ms(),
            },
        );
    }
    json!({ "type": kind, "payload": Value::Null })
}

/// Compare what an action does (kind + target), ignoring extra fields the bar
/// may add or drop when it relays the payload.
fn same_action(allowed: &Value, requested: &Value) -> bool {
    let action = |v: &Value| v.get("action").and_then(|a| a.as_str()).map(str::to_string);
    let target = |v: &Value| {
        let p = v.get("params");
        ["url", "path", "cmd", "text"].iter().find_map(|k| {
            p.and_then(|p| p.get(*k))
                .and_then(|x| x.as_str())
                .map(str::to_string)
        })
    };
    action(allowed).is_some()
        && action(allowed) == action(requested)
        && target(allowed) == target(requested)
}

fn param<'a>(payload: &'a Value, key: &str) -> Result<&'a str, String> {
    payload
        .get("params")
        .and_then(|p| p.get(key))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("missing `{key}`"))
}

pub async fn execute(app: &AppHandle, payload: &Value) -> Result<(), String> {
    let action = payload.get("action").and_then(|a| a.as_str()).unwrap_or("");
    match action {
        "openBrowser" => {
            let url = param(payload, "url")?;
            let url = if url.contains("://") {
                url.to_string()
            } else {
                format!("https://{url}")
            };
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| e.to_string())
        }
        "openFile" | "startApp" => {
            let path = param(payload, "path")?;
            app.opener()
                .open_path(path, None::<&str>)
                .map_err(|e| e.to_string())
        }
        "execCmd" => {
            let cmd = param(payload, "cmd")?;
            #[cfg(windows)]
            let spawned = tokio::process::Command::new("cmd")
                .args(["/C", cmd])
                .spawn();
            #[cfg(not(windows))]
            let spawned = tokio::process::Command::new("/bin/sh")
                .args(["-c", cmd])
                .spawn();
            spawned.map(|_| ()).map_err(|e| e.to_string())
        }
        "inputText" => type_text(param(payload, "text")?).await,
        other => Err(format!("unsupported action `{other}`")),
    }
}

#[cfg(target_os = "macos")]
async fn type_text(text: &str) -> Result<(), String> {
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

#[cfg(target_os = "linux")]
async fn type_text(text: &str) -> Result<(), String> {
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

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
async fn type_text(_text: &str) -> Result<(), String> {
    Err("typing text isn't supported on this platform yet".into())
}

#[cfg(test)]
mod tests {
    use super::same_action;
    use serde_json::json;

    #[test]
    fn matches_on_action_and_target_only() {
        let allowed = json!({"action": "startApp", "params": {"path": "/Applications/Safari.app", "launchMode": 0}});
        let relayed = json!({"action": "startApp", "params": {"path": "/Applications/Safari.app"}});
        assert!(same_action(&allowed, &relayed));
        let other = json!({"action": "startApp", "params": {"path": "/Applications/Terminal.app"}});
        assert!(!same_action(&allowed, &other));
        let different_kind =
            json!({"action": "execCmd", "params": {"cmd": "/Applications/Safari.app"}});
        assert!(!same_action(&allowed, &different_kind));
        assert!(!same_action(&json!({}), &json!({})));
    }
}
