//! Shortcut packs installed on this computer.
//!
//! Like the official app, an installed pack stays available in the card list
//! (the whole pack as a shortcut-group card, and each button as its own card
//! or action) until it's uninstalled. This is app state, not part of the
//! layout: cards made from a pack carry copies of its buttons, so uninstalling
//! a pack doesn't change them.
//!
//! Each pack is kept as `packs/<store id>.json`: the store record it came
//! from plus the unpacked pack (`market::pack`, which checks the download
//! against the store's SHA-256), with images as data URLs.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::market::{Pack, StorePlugin};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPack {
    /// The store record it was installed from (name, version, file, hash).
    pub plugin: StorePlugin,
    pub pack: Pack,
    /// Milliseconds since 1970.
    pub installed_at: u64,
}

pub struct Packs {
    dir: PathBuf,
}

impl Packs {
    pub fn new(dir: PathBuf) -> Self {
        Packs { dir }
    }

    fn path(&self, id: i64) -> PathBuf {
        // Store ids are numbers, so they're safe as file names.
        self.dir.join(format!("{id}.json"))
    }

    /// Installed packs by name. Files that don't parse are skipped.
    pub fn list(&self) -> Vec<InstalledPack> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out: Vec<InstalledPack> = entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| std::fs::read(e.path()).ok())
            .filter_map(|b| serde_json::from_slice(&b).ok())
            .collect();
        out.sort_by(|a, b| {
            a.plugin
                .name
                .to_lowercase()
                .cmp(&b.plugin.name.to_lowercase())
                .then(a.plugin.id.cmp(&b.plugin.id))
        });
        out
    }

    /// Keeps a freshly downloaded pack, replacing an earlier copy of it.
    pub fn save(&self, plugin: StorePlugin, pack: Pack) -> Result<InstalledPack, String> {
        let installed = InstalledPack {
            plugin,
            pack,
            installed_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64),
        };
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&installed).map_err(|e| e.to_string())?;
        let path = self.path(installed.plugin.id);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        Ok(installed)
    }

    pub fn remove(&self, id: i64) -> Result<(), String> {
        match std::fs::remove_file(self.path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::PackButton;
    use serde_json::json;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("ultrabar-packs-{}", uuid::Uuid::new_v4()))
    }

    fn plugin(id: i64, name: &str) -> StorePlugin {
        serde_json::from_value(json!({
            "id": id, "identifier": "x", "name": name, "file": "https://x/p.zip", "sha256": "ab", "versionCode": 2
        }))
        .unwrap()
    }

    fn pack(name: &str) -> Pack {
        Pack {
            name: name.into(),
            identifier: "x".into(),
            version_code: Some(2),
            icon: None,
            buttons: vec![PackButton {
                name: "Mute".into(),
                span_size: 2,
                icon: Some("data:image/png;base64,AA==".into()),
                param: json!({"output": 5, "keys": [226, 4]}),
            }],
        }
    }

    #[test]
    fn installs_lists_and_uninstalls_packs() {
        let dir = temp_dir();
        let packs = Packs::new(dir.clone());
        assert!(packs.list().is_empty());

        packs.save(plugin(48, "Zoom"), pack("Zoom")).unwrap();
        packs.save(plugin(46, "ai websites"), pack("AI")).unwrap();
        let list = packs.list();
        assert_eq!(list.iter().map(|p| p.plugin.id).collect::<Vec<_>>(), vec![46, 48]);
        assert_eq!(list[1].pack.buttons[0].param["keys"], json!([226, 4]));
        assert_eq!(list[1].plugin.version_code, Some(2));

        // Installing again (reload or update) replaces the copy.
        let mut newer = plugin(48, "Zoom");
        newer.version_code = Some(3);
        packs.save(newer, pack("Zoom")).unwrap();
        let list = packs.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].plugin.version_code, Some(3));

        packs.remove(48).unwrap();
        packs.remove(48).unwrap();
        assert_eq!(packs.list().len(), 1);

        // A damaged file doesn't hide the others.
        std::fs::write(dir.join("7.json"), b"{not json").unwrap();
        assert_eq!(packs.list().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
