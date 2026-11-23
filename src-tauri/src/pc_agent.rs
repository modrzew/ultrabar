//! Handles requests the bar pushes to this computer (`act 1000000`).
//!
//! The official app executes whatever the bar sends. Here a PC-control
//! request only runs if its payload exactly matches an action that was part
//! of the last layout deployed from this app. Volume, mute and brightness
//! changes (from a Knob module) only go through when the deployed layout
//! binds a knob to them. Readings (volume, mute, brightness and the system
//! cards' CPU, memory, storage and network numbers) are answered whenever
//! the agent is turned on.

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::apps::LaunchMode;
use crate::{AppState, metrics, system, typing};

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
    let mut payload = data.get("payload").cloned().unwrap_or(Value::Null);

    // The official app echoes the whole request back.
    if kind == "TEST" {
        return data;
    }

    let (enabled, allowed) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        let allowed = match kind.as_str() {
            "PC_CONTROL" => {
                let ok = s.allowed_actions.iter().any(|a| same_action(a, &payload));
                if ok {
                    payload = with_launch_mode(&s.allowed_actions, payload);
                }
                ok
            }
            "SET_VOLUME" | "SET_MUTE" => knob_allowed(&s.allowed_actions, "pc:volume"),
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
        "GET_MUTE" if enabled => {
            if let Ok(m) = system::get_mute().await {
                reply = json!(m);
            }
            None
        }
        // System cards poll these every few seconds; they aren't logged.
        "CPU" | "MEMORY" | "STORAGE" if enabled => {
            let v = match kind.as_str() {
                "CPU" => metrics::cpu(),
                "MEMORY" => metrics::memory().await,
                _ => metrics::storage().await,
            };
            if let Some(v) = v {
                reply = json!(v);
            }
            None
        }
        "NETWORK" if enabled => {
            if let Some(n) = metrics::network().await {
                reply = json!(n);
            }
            None
        }
        "SET_MUTE" => {
            let r = match (blocked, mute_value(&payload)) {
                (Some(b), _) => Err(b.to_string()),
                (None, None) => Err("missing value".to_string()),
                (None, Some(m)) => system::set_mute(m).await,
            };
            r.is_err().then_some(r)
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

/// `SET_MUTE`'s payload: the official app reads a boolean; numbers and
/// strings are accepted too.
fn mute_value(payload: &Value) -> Option<bool> {
    match payload {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_f64().map(|v| v != 0.0),
        Value::String(s) => match s.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// Decides what `launchMode` 0 means for an allowed `startApp` request.
/// Versions of this app before the launch-mode choice deployed every app
/// with 0 and meant "open it", which was "bring it to the front" in effect.
/// Bars still holding those layouts keep that behaviour: 0 only means "new
/// instance" when the deploy marked the action with `newInstance`.
fn with_launch_mode(allowed: &[Value], mut payload: Value) -> Value {
    let is_start = payload.get("action").and_then(|a| a.as_str()) == Some("startApp");
    let mode = payload.pointer("/params/launchMode").and_then(|m| m.as_i64());
    if !is_start || LaunchMode::from_param(mode) != LaunchMode::New {
        return payload;
    }
    let marked_new = allowed.iter().any(|a| {
        same_action(a, &payload) && a.get("newInstance").and_then(|n| n.as_bool()) == Some(true)
    });
    if !marked_new && let Some(params) = payload.get_mut("params").and_then(|p| p.as_object_mut()) {
        params.insert("launchMode".into(), json!(2));
    }
    payload
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
        "openFile" => {
            let path = param(payload, "path")?;
            app.opener()
                .open_path(path, None::<&str>)
                .map_err(|e| e.to_string())
        }
        "startApp" => {
            let path = param(payload, "path")?;
            let mode = LaunchMode::from_param(
                payload.pointer("/params/launchMode").and_then(|m| m.as_i64()),
            );
            #[cfg(any(target_os = "macos", windows))]
            return crate::apps::start(path, mode).await;
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                let _ = mode;
                app.opener()
                    .open_path(path, None::<&str>)
                    .map_err(|e| e.to_string())
            }
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
        "inputText" => typing::type_text(param(payload, "text")?).await,
        "discord" => {
            let params = payload.get("params").cloned().unwrap_or(Value::Null);
            app.state::<AppState>().discord.execute(&params).await
        }
        other => Err(format!("unsupported action `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::{mute_value, same_action, with_launch_mode};
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

    #[test]
    fn launch_mode_zero_needs_a_new_instance_deploy() {
        let path = "/Applications/Safari.app";
        let req = |mode: i64| json!({"action": "startApp", "params": {"path": path, "launchMode": mode}});
        let mode = |v: &serde_json::Value| v["params"]["launchMode"].as_i64();

        // Deployed by an earlier version: every app had launchMode 0.
        let legacy = vec![req(0)];
        assert_eq!(mode(&with_launch_mode(&legacy, req(0))), Some(2));

        // Deployed with "New instance".
        let mut new = req(0);
        new["newInstance"] = json!(true);
        assert_eq!(mode(&with_launch_mode(&[new.clone()], req(0))), Some(0));

        // "Single instance" requests are left alone either way.
        assert_eq!(mode(&with_launch_mode(&[new], req(2))), Some(2));

        // Other actions are untouched.
        let cmd = json!({"action": "execCmd", "params": {"cmd": "ls"}});
        assert_eq!(with_launch_mode(&legacy, cmd.clone()), cmd);
    }

    #[test]
    fn mute_accepts_bools_and_numbers() {
        assert_eq!(mute_value(&json!(true)), Some(true));
        assert_eq!(mute_value(&json!(false)), Some(false));
        assert_eq!(mute_value(&json!(1)), Some(true));
        assert_eq!(mute_value(&json!(0)), Some(false));
        assert_eq!(mute_value(&json!("true")), Some(true));
        assert_eq!(mute_value(&json!(null)), None);
        assert_eq!(mute_value(&json!("maybe")), None);
    }
}
