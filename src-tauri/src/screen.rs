//! The bar's asset upload (`POST :8080/upload/zip`, launcher 1.0.9+).
//!
//! The launcher unpacks the zip into `<its files dir>/<subDir>` and then
//! reloads the home screen. This app uses it twice per deploy:
//! - Card images go into `ultrabar-app/image/`, replacing what was there
//!   (`isFull=true`), so the bar has them while this computer is off. The
//!   payloads point at them as `file://ultrabar-app/image/<hash>.png`.
//! - After the profiles, an empty zip with `isFull=false` (which keeps the
//!   images) redraws the screen: launcher 1.0.9 saves profiles (act 1108)
//!   without redrawing and ignores a profile switch (act 1103) to the
//!   profile it already shows.
//!
//! Firmware 1.0.1 has no such route; both requests then fail.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const PORT: u16 = 8080;
const TIMEOUT: Duration = Duration::from_secs(5);
/// Always pass our own folder: without one, `isFull` (true by default)
/// empties the launcher's whole asset directory before unzipping.
const REFRESH_PATH: &str = "/upload/zip?subDir=ultrabar-app&isFull=false";
const IMAGES_PATH: &str = "/upload/zip?subDir=ultrabar-app&isFull=true";
const BOUNDARY: &str = "ultrabar-upload-7d1c";
/// The launcher refuses zips over 50 MB.
pub const MAX_ZIP: usize = 50 << 20;

/// A zip archive with no entries (just the end-of-central-directory record).
const EMPTY_ZIP: [u8; 22] = [
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

/// A multipart upload of one zip (the file name has to end in `.zip`).
fn request(host: &str, path: &str, filename: &str, zip: &[u8]) -> Vec<u8> {
    let mut body = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/zip\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(zip);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let mut req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{PORT}\r\nContent-Type: multipart/form-data; boundary={BOUNDARY}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    req.extend_from_slice(&body);
    req
}

/// The launcher answers `{"msg":"ok","data":0,"state":200}`.
fn accepted(resp: &[u8]) -> Result<(), String> {
    let text = String::from_utf8_lossy(resp);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.lines().next().unwrap_or("");
    if !status.starts_with("HTTP/1.1 200") && !status.starts_with("HTTP/1.0 200") {
        return Err(if status.is_empty() { "no response".into() } else { status.to_string() });
    }
    let json = body.find('{').map_or("", |i| &body[i..]);
    let reply: serde_json::Value = serde_json::Deserializer::from_str(json)
        .into_iter()
        .next()
        .and_then(Result::ok)
        .unwrap_or_default();
    if reply.get("state").and_then(serde_json::Value::as_i64) == Some(200) {
        Ok(())
    } else {
        let msg = reply.get("msg").and_then(|m| m.as_str()).unwrap_or("unexpected answer");
        Err(format!("the bar said: {msg}"))
    }
}

async fn upload(ip: &str, path: &str, filename: &str, zip: &[u8], timeout: Duration) -> Result<(), String> {
    let work = async {
        let mut sock = TcpStream::connect((ip, PORT)).await.map_err(|e| e.to_string())?;
        sock.write_all(&request(ip, path, filename, zip)).await.map_err(|e| e.to_string())?;
        let mut resp = Vec::new();
        sock.read_to_end(&mut resp).await.map_err(|e| e.to_string())?;
        accepted(&resp)
    };
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| "timed out".to_string())?
}

pub async fn reload_home_screen(ip: &str) -> Result<(), String> {
    upload(ip, REFRESH_PATH, "refresh.zip", &EMPTY_ZIP, TIMEOUT).await
}

/// Replaces this app's images on the bar with `zip` (see `icons::IconServer::zip`).
pub async fn upload_images(ip: &str, zip: &[u8]) -> Result<(), String> {
    if zip.len() > MAX_ZIP {
        return Err("the images are larger than the bar accepts (50 MB)".into());
    }
    // About 1 MB/s on a slow Wi-Fi link, plus the unpacking.
    let timeout = TIMEOUT + Duration::from_secs((zip.len() >> 20) as u64);
    upload(ip, IMAGES_PATH, "ultrabar-images.zip", zip, timeout).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_multipart_upload_into_our_own_folder() {
        let req = request("192.168.1.175", REFRESH_PATH, "refresh.zip", &EMPTY_ZIP);
        let text = String::from_utf8_lossy(&req);
        assert!(text.starts_with("POST /upload/zip?subDir=ultrabar-app&isFull=false HTTP/1.1\r\n"));
        assert!(text.contains("filename=\"refresh.zip\""));
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let len: usize = head
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length: "))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(len, body.len());
        assert!(req.windows(4).any(|w| w == [0x50, 0x4b, 0x05, 0x06]));
    }

    #[test]
    fn reads_the_launchers_upload_reply() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"msg\":\"ok\",\"data\":0,\"state\":200}";
        assert!(accepted(ok).is_ok());
        let refused = b"HTTP/1.1 200 OK\r\n\r\n{\"msg\":\"file error\",\"state\":500}";
        assert_eq!(accepted(refused).unwrap_err(), "the bar said: file error");
        assert!(accepted(b"HTTP/1.1 404 Not Found\r\n\r\n").is_err());
        assert!(accepted(b"").is_err());
    }
}
