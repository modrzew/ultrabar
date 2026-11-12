//! Small JSON files in the app's data directory: connection settings (client
//! identity, paired bars, PC-agent allowlist) and the user's layout document.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::discovery::FoundBar;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedBar {
    pub serial_no: String,
    pub ip: String,
    pub tcp_port: u16,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ver: Option<String>,
    #[serde(default, skip_serializing)]
    pub token: Option<String>,
}

/// On-disk form keeps the token; `SavedBar`'s Serialize (sent to the UI) does not.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedBarDisk {
    serial_no: String,
    ip: String,
    tcp_port: u16,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    ver: Option<String>,
    #[serde(default)]
    token: Option<String>,
}

impl From<&FoundBar> for SavedBar {
    fn from(f: &FoundBar) -> Self {
        SavedBar {
            serial_no: f.serial_no.clone(),
            ip: f.ip.clone(),
            tcp_port: f.tcp_port,
            name: f.name.clone(),
            ver: f.ver.clone(),
            token: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub client_id: String,
    pub bars: Vec<SavedBar>,
    pub current_bar: Option<String>,
    pub pc_agent_enabled: bool,
    pub allowed_actions: Vec<Value>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SettingsDisk {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    bars: Vec<SavedBarDisk>,
    #[serde(default)]
    current_bar: Option<String>,
    #[serde(default = "yes")]
    pc_agent_enabled: bool,
    #[serde(default)]
    allowed_actions: Vec<Value>,
}

fn yes() -> bool {
    true
}

impl Settings {
    pub fn current(&self) -> Option<&SavedBar> {
        let serial = self.current_bar.as_ref()?;
        self.bars.iter().find(|b| &b.serial_no == serial)
    }

    pub fn bar_mut(&mut self, serial: &str) -> Option<&mut SavedBar> {
        self.bars.iter_mut().find(|b| b.serial_no == serial)
    }

    pub fn upsert_bar(&mut self, found: &FoundBar) {
        match self.bar_mut(&found.serial_no) {
            Some(b) => {
                b.ip = found.ip.clone();
                b.tcp_port = found.tcp_port;
                if found.name.is_some() {
                    b.name = found.name.clone();
                }
                if found.ver.is_some() {
                    b.ver = found.ver.clone();
                }
            }
            None => self.bars.push(SavedBar::from(found)),
        }
    }
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Store { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn write_atomic(&self, name: &str, contents: &[u8]) -> std::io::Result<()> {
        let tmp = self.dir.join(format!("{name}.tmp"));
        std::fs::write(&tmp, contents)?;
        std::fs::rename(tmp, self.dir.join(name))
    }

    pub fn load_settings(&self) -> Settings {
        let disk: SettingsDisk = std::fs::read(self.dir.join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| SettingsDisk {
                pc_agent_enabled: true,
                ..Default::default()
            });
        let mut s = Settings {
            client_id: disk.client_id,
            bars: disk
                .bars
                .into_iter()
                .map(|b| SavedBar {
                    serial_no: b.serial_no,
                    ip: b.ip,
                    tcp_port: b.tcp_port,
                    name: b.name,
                    ver: b.ver,
                    token: b.token,
                })
                .collect(),
            current_bar: disk.current_bar,
            pc_agent_enabled: disk.pc_agent_enabled,
            allowed_actions: disk.allowed_actions,
        };
        if s.client_id.is_empty() {
            s.client_id = uuid::Uuid::new_v4().to_string();
            let _ = self.save_settings(&s);
        }
        s
    }

    pub fn save_settings(&self, s: &Settings) -> std::io::Result<()> {
        let disk = SettingsDisk {
            client_id: s.client_id.clone(),
            bars: s
                .bars
                .iter()
                .map(|b| SavedBarDisk {
                    serial_no: b.serial_no.clone(),
                    ip: b.ip.clone(),
                    tcp_port: b.tcp_port,
                    name: b.name.clone(),
                    ver: b.ver.clone(),
                    token: b.token.clone(),
                })
                .collect(),
            current_bar: s.current_bar.clone(),
            pc_agent_enabled: s.pc_agent_enabled,
            allowed_actions: s.allowed_actions.clone(),
        };
        self.write_atomic("settings.json", &serde_json::to_vec_pretty(&disk)?)
    }

    pub fn load_doc(&self) -> Option<Value> {
        let bytes = std::fs::read(self.dir.join("layout.json")).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn save_doc(&self, doc: &Value) -> std::io::Result<()> {
        self.write_atomic("layout.json", &serde_json::to_vec(doc)?)
    }
}
