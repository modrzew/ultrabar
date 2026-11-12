//! Wire format of the UltraBar command channel: one JSON object per line.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub mod act {
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
    fn requests_omit_empty_fields_and_end_with_newline() {
        let line = Envelope::request("3".into(), act::HEARTBEAT, None).to_line();
        assert_eq!(line, "{\"id\":\"3\",\"act\":20}\n");
    }
}
