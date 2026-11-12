//! The vendor's app and plugin store.
//!
//! Apps: the bar installs them itself (act 30600 with a package name; it looks
//! the APK up in the same catalog), so this app only needs the listing.
//!
//! Plugins: zips with a `config.json` that lists shortcut buttons (the same
//! `PC_CONTROL` params this app deploys) plus their icons. They're downloaded
//! here, checked against the catalog's SHA-256 and unpacked in memory.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const API: &str = "https://gatewayssl.dev.aiks360.com/api/v1/base-service/pub/";
/// `appType` of bar apps in the store; also sent with the install request.
pub const APP_TYPE: i64 = 100;
const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 10;
const MAX_PACK: usize = 20 << 20;
const MAX_CONFIG: u64 = 1 << 20;
const MAX_IMAGE: u64 = 2 << 20;

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        // reqwest is built without a crypto provider; use the one the rest of the app uses.
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .user_agent(concat!("ultrabar/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("HTTP client builds")
    })
}

fn net_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "The store didn't answer in time.".into()
    } else if e.is_connect() {
        "Couldn't reach the store. Check your internet connection.".into()
    } else if let Some(s) = e.status() {
        format!("The store answered with an error (HTTP {}).", s.as_u16())
    } else {
        format!("Couldn't load from the store: {e}")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreApp {
    pub application: String,
    #[serde(default)]
    pub app_name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub desc: Option<String>,
    #[serde(default)]
    pub version_name: Option<String>,
    #[serde(default)]
    pub version_code: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorePlugin {
    pub id: i64,
    #[serde(default)]
    pub identifier: String,
    pub name: String,
    #[serde(default)]
    pub desc: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    pub file: String,
    pub sha256: String,
    #[serde(default)]
    pub version_name: Option<String>,
    #[serde(default)]
    pub version_code: Option<i64>,
    /// 0 = shortcut pack, the only kind the store has (and this app knows).
    #[serde(default)]
    pub plugin_type: i64,
}

/// Records from one page of a store listing (`{state, msg, data: {records, total}}`).
/// Entries that don't parse are skipped rather than failing the whole list.
fn page<T: for<'de> Deserialize<'de>>(body: &Value) -> Result<(Vec<T>, Option<u64>), String> {
    let Some(data) = body.get("data").filter(|d| d.is_object()) else {
        let msg = body.get("msg").and_then(Value::as_str).unwrap_or("no data");
        return Err(format!("The store returned an unexpected answer ({msg})."));
    };
    let records = data
        .get("records")
        .and_then(Value::as_array)
        .map(|r| {
            r.iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    Ok((records, data.get("total").and_then(Value::as_u64)))
}

async fn all_pages<T, F, Fut>(mut fetch: F) -> Result<Vec<T>, String>
where
    T: for<'de> Deserialize<'de>,
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = Result<Value, String>>,
{
    let mut out = Vec::new();
    for pi in 1..=MAX_PAGES {
        let body = fetch(pi).await?;
        let (mut records, total) = page::<T>(&body)?;
        let n = body["data"]["records"].as_array().map_or(0, Vec::len);
        out.append(&mut records);
        if n < PAGE_SIZE || total.is_some_and(|t| (pi * PAGE_SIZE) as u64 >= t) {
            break;
        }
    }
    Ok(out)
}

pub async fn apps() -> Result<Vec<StoreApp>, String> {
    let url = format!("{API}apps/{APP_TYPE}/fetchListV2");
    all_pages(|pi| {
        let req = client()
            .post(&url)
            .header("Accept-Language", "en")
            .json(&json!({ "pi": pi, "ps": PAGE_SIZE }));
        async move {
            let r = req
                .send()
                .await
                .map_err(net_err)?
                .error_for_status()
                .map_err(net_err)?;
            r.json::<Value>().await.map_err(net_err)
        }
    })
    .await
}

pub async fn plugins() -> Result<Vec<StorePlugin>, String> {
    let url = format!("{API}plugin/page");
    let list: Vec<StorePlugin> = all_pages(|pi| {
        let req = client()
            .get(format!("{url}?pi={pi}&ps={PAGE_SIZE}"))
            .header("Accept-Language", "en");
        async move {
            let r = req
                .send()
                .await
                .map_err(net_err)?
                .error_for_status()
                .map_err(net_err)?;
            r.json::<Value>().await.map_err(net_err)
        }
    })
    .await?;
    Ok(list.into_iter().filter(|p| p.plugin_type == 0).collect())
}

async fn get_bytes(url: &str, max: usize) -> Result<Vec<u8>, String> {
    let u = reqwest::Url::parse(url).map_err(|_| format!("Invalid download address: {url}"))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(format!("Unsupported download address: {url}"));
    }
    let mut r = client()
        .get(u)
        .send()
        .await
        .map_err(net_err)?
        .error_for_status()
        .map_err(net_err)?;
    if r.content_length().is_some_and(|n| n > max as u64) {
        return Err("The download is too large.".into());
    }
    let mut out = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(net_err)? {
        out.extend_from_slice(&chunk);
        if out.len() > max {
            return Err("The download is too large.".into());
        }
    }
    Ok(out)
}

/// A shortcut pack ready for the UI. Images are data URLs.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub name: String,
    pub identifier: String,
    pub version_code: Option<i64>,
    pub icon: Option<String>,
    pub buttons: Vec<PackButton>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackButton {
    pub name: String,
    pub span_size: i64,
    pub icon: Option<String>,
    /// As in the pack: `{output: 5, keys}` or `{output: 10, payload}`.
    pub param: Value,
}

/// An image referenced by the pack: inside the zip (`file://…`) or on the web.
#[derive(Debug, Clone, PartialEq)]
enum Img {
    Data(String),
    Remote(String),
    Missing,
}

#[derive(Debug)]
struct RawPack {
    name: String,
    identifier: String,
    version_code: Option<i64>,
    icon: Img,
    buttons: Vec<(String, i64, Img, Value)>,
}

fn data_url(bytes: &[u8]) -> Option<String> {
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        return None;
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

fn read_entry<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
    max: u64,
) -> Option<Vec<u8>> {
    let entry = zip.by_name(name).ok()?;
    if entry.size() > max {
        return None;
    }
    let mut buf = Vec::new();
    entry.take(max + 1).read_to_end(&mut buf).ok()?;
    (buf.len() as u64 <= max).then_some(buf)
}

fn image_ref<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, src: Option<&str>) -> Img {
    let Some(src) = src.map(str::trim).filter(|s| !s.is_empty()) else {
        return Img::Missing;
    };
    if let Some(path) = src.strip_prefix("file://") {
        let path = path.trim_start_matches('/');
        return read_entry(zip, path, MAX_IMAGE)
            .and_then(|b| data_url(&b))
            .map_or(Img::Missing, Img::Data);
    }
    if src.starts_with("http://") || src.starts_with("https://") {
        return Img::Remote(src.to_string());
    }
    Img::Missing
}

/// Checks the download against the catalog's hash and reads `config.json`.
fn open_pack(bytes: Vec<u8>, sha256: &str) -> Result<RawPack, String> {
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if sha256.trim().is_empty() || !digest.eq_ignore_ascii_case(sha256.trim()) {
        return Err(
            "The downloaded pack doesn't match the store's checksum, so it wasn't used.".into(),
        );
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "The pack isn't a valid zip file.".to_string())?;
    let config =
        read_entry(&mut zip, "config.json", MAX_CONFIG).ok_or("The pack has no config.json.")?;
    let config: Value =
        serde_json::from_slice(&config).map_err(|_| "The pack's config.json isn't valid JSON.")?;
    let str_of = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();

    let icon = image_ref(&mut zip, config.get("icon").and_then(Value::as_str));
    let mut buttons = Vec::new();
    for b in config
        .get("button")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(param) = b.get("param").filter(|p| p.is_object()) else {
            continue;
        };
        let span = b
            .get("spanSize")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .clamp(1, 2);
        let img = image_ref(&mut zip, b.get("icon").and_then(Value::as_str));
        buttons.push((str_of(b, "name"), span, img, param.clone()));
    }
    Ok(RawPack {
        name: str_of(&config, "name"),
        identifier: str_of(&config, "identifier"),
        version_code: config.get("versionCode").and_then(Value::as_i64),
        icon,
        buttons,
    })
}

/// Downloads, verifies and unpacks a shortcut pack. Icons hosted on the web
/// are fetched too, so the pack works without the store afterwards.
/// `fallback_icon` (the catalog's icon) is used when the pack has none.
pub async fn pack(file: &str, sha256: &str, fallback_icon: Option<&str>) -> Result<Pack, String> {
    let raw = open_pack(get_bytes(file, MAX_PACK).await?, sha256)?;
    let pack_icon = match (&raw.icon, fallback_icon) {
        (Img::Missing, Some(u)) if u.starts_with("http") => Img::Remote(u.to_string()),
        (i, _) => i.clone(),
    };

    let remote: HashSet<String> = std::iter::once(&pack_icon)
        .chain(raw.buttons.iter().map(|b| &b.2))
        .filter_map(|i| match i {
            Img::Remote(u) => Some(u.clone()),
            _ => None,
        })
        .collect();
    let mut tasks = tokio::task::JoinSet::new();
    for url in remote {
        tasks.spawn(async move {
            let img = get_bytes(&url, MAX_IMAGE as usize)
                .await
                .ok()
                .and_then(|b| data_url(&b));
            (url, img)
        });
    }
    let mut fetched: HashMap<String, Option<String>> = HashMap::new();
    while let Some(Ok((url, img))) = tasks.join_next().await {
        fetched.insert(url, img);
    }
    let resolve = |i: &Img| match i {
        Img::Data(d) => Some(d.clone()),
        Img::Remote(u) => fetched.get(u).cloned().flatten(),
        Img::Missing => None,
    };

    Ok(Pack {
        icon: resolve(&pack_icon),
        buttons: raw
            .buttons
            .iter()
            .map(|(name, span, img, param)| PackButton {
                name: name.clone(),
                span_size: *span,
                icon: resolve(img),
                param: param.clone(),
            })
            .collect(),
        name: raw.name,
        identifier: raw.identifier,
        version_code: raw.version_code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, data) in files {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    fn sha(b: &[u8]) -> String {
        format!("{:x}", Sha256::digest(b))
    }

    #[test]
    fn reads_store_listings_and_skips_bad_records() {
        // Shape of a real `apps/100/fetchListV2` reply, trimmed.
        let body = json!({"state": 0, "msg": "", "data": {"current": 1, "total": 2, "records": [
            {"appName": "Whitenoise", "application": "com.ultrabar.whitenoise", "fileUrl": "https://x/y.apk",
             "icon": "https://x/i.png", "sha256": "ab", "versionCode": 5, "versionName": "1.0.5", "desc": ""},
            {"appName": "No package"}
        ]}});
        let (apps, total) = page::<StoreApp>(&body).unwrap();
        assert_eq!(total, Some(2));
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].application, "com.ultrabar.whitenoise");
        assert_eq!(apps[0].version_code, Some(5));
        assert!(page::<StoreApp>(&json!({"state": -1, "msg": "nope"})).is_err());
    }

    #[test]
    fn opens_a_pack_and_resolves_its_images() {
        let config = json!({
            "name": "ZOOM Hotkey Plugin", "identifier": "zG0p", "versionCode": 1,
            "icon": "http://cdn.example/icon.png",
            "button": [
                {"id": "a", "icon": "file://icon/mute.png", "type": "PC_CONTROL", "name": "Mute", "spanSize": 2,
                 "param": {"output": 5, "keys": [226, 4]}},
                {"id": "b", "icon": "https://cdn.example/b.png", "type": "PC_CONTROL", "name": "Web",
                 "param": {"output": 10, "payload": {"action": "openBrowser", "params": {"url": "https://a.b"}}}},
                {"id": "c", "icon": "file://icon/missing.png", "type": "PC_CONTROL", "name": "No icon", "spanSize": 7,
                 "param": {"output": 5, "keys": [4]}},
                {"id": "d", "name": "No param"}
            ]
        });
        let bytes = zip_of(&[
            ("config.json", config.to_string().as_bytes()),
            ("icon/mute.png", PNG),
        ]);
        let raw = open_pack(bytes.clone(), &sha(&bytes).to_uppercase()).unwrap();
        assert_eq!(raw.name, "ZOOM Hotkey Plugin");
        assert_eq!(raw.version_code, Some(1));
        assert_eq!(raw.icon, Img::Remote("http://cdn.example/icon.png".into()));
        assert_eq!(raw.buttons.len(), 3);
        let (name, span, img, param) = &raw.buttons[0];
        assert_eq!((name.as_str(), *span), ("Mute", 2));
        assert!(matches!(img, Img::Data(d) if d.starts_with("data:image/png;base64,")));
        assert_eq!(param["keys"], json!([226, 4]));
        assert_eq!(raw.buttons[1].1, 1);
        assert_eq!(
            raw.buttons[1].2,
            Img::Remote("https://cdn.example/b.png".into())
        );
        assert_eq!((raw.buttons[2].1, &raw.buttons[2].2), (2, &Img::Missing));
    }

    #[test]
    fn rejects_packs_that_dont_match_the_catalog() {
        let bytes = zip_of(&[("config.json", b"{}")]);
        assert!(open_pack(bytes.clone(), &sha(b"something else")).is_err());
        assert!(open_pack(bytes.clone(), "").is_err());
        let no_config = zip_of(&[("readme.txt", b"hi")]);
        assert!(open_pack(no_config.clone(), &sha(&no_config)).is_err());
    }
}
