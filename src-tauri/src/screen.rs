//! Redraws the bar's home screen after a deploy.
//!
//! Launcher 1.0.9 saves profiles (act 1108) without redrawing, and ignores a
//! profile switch (act 1103) to the profile it already shows, so a redeploy of
//! the visible profile would leave the old cards on screen. Its asset upload
//! (`POST :8080/upload/zip`) always reloads the home screen, so we upload an
//! empty zip into a folder of our own. Firmware 1.0.1 has no such route; the
//! request then fails harmlessly.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const PORT: u16 = 8080;
const TIMEOUT: Duration = Duration::from_secs(5);
/// Always pass a folder and `isFull=false`: without a folder the bar empties
/// its whole asset directory before unzipping.
const PATH: &str = "/upload/zip?subDir=ultrabar-app&isFull=false";
const BOUNDARY: &str = "ultrabar-refresh-7d1c";

/// A zip archive with no entries (just the end-of-central-directory record).
const EMPTY_ZIP: [u8; 22] = [
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

fn request(host: &str) -> Vec<u8> {
    let mut body = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"refresh.zip\"\r\nContent-Type: application/zip\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(&EMPTY_ZIP);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    let mut req = format!(
        "POST {PATH} HTTP/1.1\r\nHost: {host}:{PORT}\r\nContent-Type: multipart/form-data; boundary={BOUNDARY}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    req.extend_from_slice(&body);
    req
}

pub async fn reload_home_screen(ip: &str) -> Result<(), String> {
    let work = async {
        let mut sock = TcpStream::connect((ip, PORT)).await.map_err(|e| e.to_string())?;
        sock.write_all(&request(ip)).await.map_err(|e| e.to_string())?;
        let mut resp = Vec::new();
        sock.read_to_end(&mut resp).await.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&resp);
        if text.starts_with("HTTP/1.1 200") && text.contains("\"state\":200") {
            Ok(())
        } else {
            Err(text.lines().next().unwrap_or("no response").to_string())
        }
    };
    tokio::time::timeout(TIMEOUT, work)
        .await
        .map_err(|_| "timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_multipart_upload_into_our_own_folder() {
        let req = request("192.168.1.175");
        let text = String::from_utf8_lossy(&req);
        assert!(text.starts_with("POST /upload/zip?subDir=ultrabar-app&isFull=false HTTP/1.1\r\n"));
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
}
