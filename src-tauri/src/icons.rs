//! Card images, stored here by content hash.
//!
//! Launcher 1.0.9 and later get them in a zip (`IconServer::zip`, uploaded by
//! `screen::upload_images`) and keep them, so they show while this computer is
//! off. Firmware 1.0.1 has no asset upload, and its image loader only accepts
//! http(s)/file URLs, so for it (and when an upload fails) we serve the PNGs
//! from a tiny HTTP server on the LAN. Content-addressed names plus long cache
//! headers let the bar's HTTP cache keep showing them when this app is closed.

use std::collections::HashSet;
use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU16, Ordering};

use base64::Engine;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const PREFERRED_PORT: u16 = 47215;

/// What `put` returns: lowercase hex.
fn valid_hash(h: &str) -> bool {
    !h.is_empty() && h.len() <= 64 && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub struct IconServer {
    dir: PathBuf,
    port: AtomicU16,
}

impl IconServer {
    pub fn new(dir: PathBuf) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&dir);
        Arc::new(IconServer {
            dir,
            port: AtomicU16::new(0),
        })
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    /// Store a PNG given as a data URL or bare base64; returns its content hash.
    pub fn put(&self, data: &str) -> Result<String, String> {
        let b64 = data.split_once(',').map(|(_, b)| b).unwrap_or(data);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("invalid image data: {e}"))?;
        if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
            return Err("icon must be a PNG".into());
        }
        let hash: String = Sha256::digest(&bytes)
            .iter()
            .take(12)
            .map(|b| format!("{b:02x}"))
            .collect();
        let path = self.dir.join(format!("{hash}.png"));
        if !path.exists() {
            std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        }
        Ok(hash)
    }

    /// A zip of stored images as `image/<hash>.png`, for the bar's asset
    /// upload. PNGs are already compressed, so they're stored as they are.
    pub fn zip(&self, hashes: &[String]) -> Result<Vec<u8>, String> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let mut seen = HashSet::new();
        for h in hashes {
            if !valid_hash(h) {
                return Err(format!("not an image id: {h}"));
            }
            if !seen.insert(h.as_str()) {
                continue;
            }
            let bytes = std::fs::read(self.dir.join(format!("{h}.png")))
                .map_err(|e| format!("image {h} is missing here: {e}"))?;
            w.start_file(format!("image/{h}.png"), opts)
                .and_then(|_| w.write_all(&bytes).map_err(Into::into))
                .map_err(|e| e.to_string())?;
        }
        Ok(w.finish().map_err(|e| e.to_string())?.into_inner())
    }

    pub async fn serve(self: Arc<Self>) {
        let listener = match TcpListener::bind(("0.0.0.0", PREFERRED_PORT)).await {
            Ok(l) => l,
            Err(_) => match TcpListener::bind(("0.0.0.0", 0)).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("icon server: cannot bind: {e}");
                    return;
                }
            },
        };
        if let Ok(addr) = listener.local_addr() {
            self.port.store(addr.port(), Ordering::Relaxed);
        }
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let this = self.clone();
            tokio::spawn(async move {
                let _ = this.handle(stream).await;
            });
        }
    }

    async fn handle(&self, mut stream: TcpStream) -> std::io::Result<()> {
        let mut buf = vec![0u8; 4096];
        let mut len = 0;
        let read = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let n = stream.read(&mut buf[len..]).await?;
                if n == 0 {
                    break;
                }
                len += n;
                if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") || len == buf.len() {
                    break;
                }
            }
            Ok::<_, std::io::Error>(())
        })
        .await;
        if !matches!(read, Ok(Ok(()))) {
            return Ok(());
        }
        let head = String::from_utf8_lossy(&buf[..len]);
        if cfg!(debug_assertions) {
            let peer = stream
                .peer_addr()
                .map(|a| a.to_string())
                .unwrap_or_default();
            eprintln!("icon server: {peer} {}", head.lines().next().unwrap_or(""));
        }
        let mut parts = head.lines().next().unwrap_or("").split_whitespace();
        let method = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        let file = path
            .strip_prefix("/i/")
            .and_then(|p| p.strip_suffix(".png"))
            .filter(|h| valid_hash(h))
            .map(|h| self.dir.join(format!("{h}.png")));

        match (method, file) {
            ("GET" | "HEAD", Some(f)) if f.exists() => {
                let body = tokio::fs::read(&f).await?;
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nCache-Control: public, max-age=31536000, immutable\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(header.as_bytes()).await?;
                if method == "GET" {
                    stream.write_all(&body).await?;
                }
            }
            _ => {
                stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await?;
            }
        }
        stream.shutdown().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_pngs_by_content_hash_and_rejects_other_data() {
        let dir = std::env::temp_dir().join(format!("ubx-icons-{}", std::process::id()));
        let server = IconServer::new(dir.clone());
        let png = b"\x89PNG\r\n\x1a\nrest-of-file";
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let a = server.put(&format!("data:image/png;base64,{b64}")).unwrap();
        let b = server.put(&b64).unwrap();
        assert_eq!(a, b);
        assert!(dir.join(format!("{a}.png")).exists());
        assert!(server.put("data:image/png;base64,aGVsbG8=").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn zips_stored_images_for_the_bar() {
        let dir = std::env::temp_dir().join(format!("ubx-zip-{}", std::process::id()));
        let server = IconServer::new(dir.clone());
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let a = server.put(&b64(b"\x89PNG\r\n\x1a\none")).unwrap();
        let b = server.put(&b64(b"\x89PNG\r\n\x1a\ntwo")).unwrap();
        let bytes = server.zip(&[a.clone(), b.clone(), a.clone()]).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = zip.file_names().map(|n| n.unwrap().to_string()).collect();
        names.sort();
        let mut want = vec![format!("image/{a}.png"), format!("image/{b}.png")];
        want.sort();
        assert_eq!(names, want);
        let mut first = Vec::new();
        std::io::Read::read_to_end(&mut zip.by_name(&format!("image/{a}.png")).unwrap(), &mut first).unwrap();
        assert_eq!(first, b"\x89PNG\r\n\x1a\none");
        assert!(server.zip(&["../secret".into()]).is_err());
        assert!(server.zip(&["abcdef".into()]).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
