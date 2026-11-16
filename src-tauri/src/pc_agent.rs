//! Handles requests the bar pushes to this computer (`act 1000000`).
//!
//! The official app executes whatever the bar sends. Here a PC-control
//! request only runs if its payload exactly matches an action that was part
//! of the last layout deployed from this app. Volume and brightness changes
//! (from a Knob module) only go through when the deployed layout binds a knob
//! to them.

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::{AppState, system};

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

    let (enabled, allowed) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        let allowed = match kind.as_str() {
            "PC_CONTROL" => s.allowed_actions.iter().any(|a| same_action(a, &payload)),
            "SET_VOLUME" => knob_allowed(&s.allowed_actions, "pc:volume"),
            "SET_BRIGHTNESS" => knob_allowed(&s.allowed_actions, "pc:bright"),
            _ => true,
        };
        (s.pc_agent_enabled, allowed)
    };
    let blocked = if !enabled {
        Some("PC actions are turned off in Settings")
    } else if !allowed {
        Some("Blocked: this action isn't part of the layout you deployed")
    } else {
        None
    };

    if kind == "MODULE_STATE" {
        // {serialNo, online}: a module was attached or detached.
        let _ = app.emit("module-state", &payload);
    }

    let mut reply = Value::Null;
    let result: Option<Result<(), String>> = match kind.as_str() {
        "PC_CONTROL" => Some(match blocked {
            Some(b) => Err(b.to_string()),
            None => execute(app, &payload).await,
        }),
        // The knob polls these every few seconds. On failure the reply has no
        // value and the bar keeps its own.
        "GET_VOLUME" | "GET_BRIGHTNESS" if enabled => {
            let v = if kind == "GET_VOLUME" {
                system::get_volume().await
            } else {
                system::get_brightness().await
            };
            if let Ok(v) = v {
                reply = json!(v);
            }
            None
        }
        "SET_VOLUME" | "SET_BRIGHTNESS" => {
            let v = payload
                .as_f64()
                .or_else(|| payload.as_str().and_then(|s| s.parse().ok()));
            let r = match (blocked, v) {
                (Some(b), _) => Err(b.to_string()),
                (None, None) => Err("missing value".to_string()),
                (None, Some(v)) => {
                    let v = v.round().clamp(0.0, 100.0) as u8;
                    if kind == "SET_VOLUME" {
                        system::set_volume(v).await
                    } else {
                        system::set_brightness(v).await
                    }
                }
            };
            r.is_err().then_some(r)
        }
        _ => None,
    };
    if let Some(result) = result {
        let _ = app.emit(
            "pc-action",
            PcActionEvent {
                payload: if kind == "PC_CONTROL" {
                    payload
                } else {
                    json!({ "action": kind, "params": payload })
                },
                ok: result.is_ok(),
                error: result.err(),
                at: now_ms(),
            },
        );
    }
    json!({ "type": kind, "payload": reply })
}

/// The deployed layout binds a Knob to this target (`pc:volume`, `pc:bright`).
fn knob_allowed(allowed: &[Value], target: &str) -> bool {
    allowed
        .iter()
        .any(|a| a.get("knob").and_then(|k| k.as_str()) == Some(target))
}

/// Compare what an action does (kind + target), ignoring extra fields the bar
/// may add or drop when it relays the payload.
fn same_action(allowed: &Value, requested: &Value) -> bool {
    let action = |v: &Value| v.get("action").and_then(|a| a.as_str()).map(str::to_string);
    let target = |v: &Value| {
        let p = v.get("params");
        let s = |k: &str| {
            p.and_then(|p| p.get(k))
                .and_then(|x| x.as_str())
                .map(str::to_string)
        };
        if action(v).as_deref() == Some("discord") {
            // What a Discord action does: the operation and its channel or sound.
            return Some(
                ["op", "guild", "channel", "sound"]
                    .map(|k| s(k).unwrap_or_default())
                    .join("|"),
            );
        }
        ["url", "path", "cmd", "text"].iter().find_map(|k| s(k))
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
        "discord" => {
            let params = payload.get("params").cloned().unwrap_or(Value::Null);
            app.state::<AppState>().discord.execute(&params).await
        }
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

    #[test]
    fn discord_actions_match_on_operation_and_target() {
        let allowed = json!({"action": "discord", "params": {"op": "joinVoice", "guild": "1", "channel": "2"}});
        assert!(same_action(
            &allowed,
            &json!({"action": "discord", "params": {"op": "joinVoice", "guild": "1", "channel": "2"}})
        ));
        assert!(!same_action(
            &allowed,
            &json!({"action": "discord", "params": {"op": "joinVoice", "guild": "1", "channel": "3"}})
        ));
        assert!(!same_action(
            &allowed,
            &json!({"action": "discord", "params": {"op": "leaveVoice"}})
        ));
        let mute = json!({"action": "discord", "params": {"op": "toggleMute"}});
        assert!(same_action(&mute, &mute.clone()));
    }
}
