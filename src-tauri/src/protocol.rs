//! Wire format of the UltraBar command channel: one JSON object per line.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub mod act {
    /// Error reply, e.g. for an opcode the bar doesn't know (see `Envelope::unknown_act_for`).
    pub const ERROR: i64 = 10;
    pub const HEARTBEAT: i64 = 20;
    pub const AUTH: i64 = 100;
    pub const REQUEST_TOKEN: i64 = 101;
    /// Bar → PC requests (PC control, etc.).
    pub const PUSH: i64 = 1_000_000;
}

/// The bar's frame decoder drops lines longer than this (including the newline).
pub const MAX_LINE: usize = 8192;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(
        default,
        deserialize_with = "lenient_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    #[serde(default)]
    pub act: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msg: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl Envelope {
    pub fn request(id: String, act: i64, data: Option<Value>) -> Self {
        Envelope {
            id: Some(id),
            act,
            code: None,
            msg: None,
            data,
        }
    }

    pub fn is_ok(&self) -> bool {
        self.code == Some(200)
    }

    pub fn message(&self) -> String {
        match &self.msg {
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => match &self.data {
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            },
        }
    }

    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).expect("envelope serializes");
        s.push('\n');
        s
    }

    /// Whether this message is the reply to a request sent with `act` and the
    /// same id. Progress events reuse the request's id: installing an app
    /// (30600) streams 30601 events under its id, the first one before the reply.
    pub fn answers(&self, act: i64) -> bool {
        self.act == act || self.act == 0
    }

    /// Firmware 1.0.9 answers an opcode it doesn't know with
    /// `{"act":10,"code":200,"id":"<request id> act error"}`. Returns that request id.
    pub fn unknown_act_for(&self) -> Option<&str> {
        if self.act != act::ERROR {
            return None;
        }
        self.id.as_deref()?.strip_suffix(" act error")
    }
}

/// Parses one line from the bar.
///
/// Launcher 1.0.9 sends bar → PC pushes in an internal wrapper that hub 1.0.1
/// passes through unchanged: `{"target":"CLIENT_REPLY","data":{"payload":"<envelope as
/// JSON text>",…}}`. The envelope inside is the usual one, so unwrap it.
pub fn parse_line(line: &str) -> Option<Envelope> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("act").is_none()
        && v.get("target").is_some()
        && let Some(inner) = v
            .get("data")
            .and_then(|d| d.get("payload"))
            .and_then(|p| p.as_str())
    {
        return serde_json::from_str(inner).ok();
    }
    serde_json::from_value(v).ok()
}

fn lenient_id<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        Some(Value::String(s)) => Some(s),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_replies_with_string_or_numeric_ids() {
        let e: Envelope =
            serde_json::from_str(r#"{"act":1000,"code":200,"data":[],"id":"60456","timestamp":1}"#)
                .unwrap();
        assert_eq!(e.id.as_deref(), Some("60456"));
        assert!(e.is_ok());
        let e: Envelope =
            serde_json::from_str(r#"{"act":100,"code":-1,"msg":"auth_fail","id":7}"#).unwrap();
        assert_eq!(e.id.as_deref(), Some("7"));
        assert!(!e.is_ok());
        assert_eq!(e.message(), "auth_fail");
    }

    #[test]
    fn unwraps_pushes_from_launcher_1_0_9() {
        // Captured from a bar running launcher 1.0.9 with hub 1.0.1.
        let line = r#"{"data":{"integratedId":"tcp","payload":"{\"act\":1000000,\"data\":{\"payload\":{\"action\":\"execCmd\",\"params\":{\"cmd\":\"echo hi\"}},\"type\":\"PC_CONTROL\"},\"id\":\"sys.push.b8e82d8f\"}","response":true},"target":"CLIENT_REPLY"}"#;
        let e = parse_line(line).unwrap();
        assert_eq!(e.act, act::PUSH);
        assert_eq!(e.id.as_deref(), Some("sys.push.b8e82d8f"));
        let data = e.data.unwrap();
        assert_eq!(data["type"], "PC_CONTROL");
        assert_eq!(data["payload"]["params"]["cmd"], "echo hi");
    }

    #[test]
    fn parses_plain_lines_unchanged() {
        let e = parse_line(r#"{"act":1000000,"code":200,"id":"sys.push.1","data":{"type":"PC_CONTROL","payload":{}}}"#).unwrap();
        assert_eq!(e.act, act::PUSH);
        let e = parse_line(r#"{"act":30102,"code":200,"data":{"netId":32},"id":"576b"}"#).unwrap();
        assert_eq!(e.act, 30102);
        assert!(parse_line("not json").is_none());
    }

    #[test]
    fn recognises_unknown_opcode_replies() {
        let e = parse_line(r#"{"act":10,"code":200,"id":"17 act error","timestamp":1}"#).unwrap();
        assert_eq!(e.unknown_act_for(), Some("17"));
        let e = parse_line(r#"{"act":1103,"code":-1,"id":"19","msg":"profile id error"}"#).unwrap();
        assert_eq!(e.unknown_act_for(), None);
    }

    #[test]
    fn progress_events_are_not_replies() {
        // Captured from launcher 1.0.9 while installing an app (request id "am3").
        let event = parse_line(r#"{"act":30601,"code":200,"data":{"packageName":"com.ultrabar.whitenoise","result":"DOWNLOADING","type":"STATUS"},"id":"am3","timestamp":1794478530413}"#).unwrap();
        let reply = parse_line(
            r#"{"act":30600,"code":200,"data":"success","id":"am3","timestamp":1794478530418}"#,
        )
        .unwrap();
        assert!(!event.answers(30600));
        assert!(reply.answers(30600));
    }

    #[test]
    fn requests_omit_empty_fields_and_end_with_newline() {
        let line = Envelope::request("3".into(), act::HEARTBEAT, None).to_line();
        assert_eq!(line, "{\"id\":\"3\",\"act\":20}\n");
    }
}
