//! Discord, through the Discord app's local RPC (an IPC socket on this
//! computer). This is what Stream Deck's Discord plugin uses.
//!
//! Discord only opens RPC to everyone for apps it has approved. An unapproved
//! app works for its owner (and the testers listed on it), so each user
//! creates their own Discord application and enters its client ID and secret
//! here, as Bitfocus Companion's Discord module does.
//!
//! The session stays open: voice settings changed over RPC only last while
//! the session that changed them is connected.
//!
//! Soundboard, camera and screen-share commands aren't in Discord's public
//! RPC docs. The Discord client accepts them (Companion uses them too), but
//! they may change without notice.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{Mutex, MutexGuard, oneshot};

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;

/// The scopes Companion's module asks for; voice, camera and screen share
/// each need their own `rpc.*` scope.
const SCOPES: &[&str] = &[
    "identify",
    "guilds",
    "rpc",
    "rpc.voice.read",
    "rpc.voice.write",
    "rpc.video.read",
    "rpc.video.write",
    "rpc.screenshare.read",
    "rpc.screenshare.write",
];
/// Must be listed under OAuth2 › Redirects in the user's Discord application.
pub const REDIRECT_URI: &str = "http://localhost";
const TOKEN_URL: &str = "https://discord.com/api/oauth2/token";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the user has to click "Authorize" in Discord.
const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_FRAME: usize = 8 << 20;

const NOT_SET_UP: &str = "Discord isn't set up. Add your Discord application in Integrations.";
const SIGN_IN: &str = "Sign in to Discord in Integrations first.";

trait Stream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Stream for T {}

type Reply = Result<Value, String>;
type Pending = Arc<StdMutex<HashMap<String, oneshot::Sender<Reply>>>>;
type Writer = Arc<Mutex<WriteHalf<Box<dyn Stream>>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub global_name: Option<String>,
}

/// Kept in `discord.json` next to the other settings, never in the layout.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Creds {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    /// Unix seconds.
    #[serde(default)]
    expires_at: Option<u64>,
    #[serde(default)]
    user: Option<User>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Client ID and secret are set.
    pub configured: bool,
    pub client_id: String,
    pub signed_in: bool,
    /// A live, authenticated session with the Discord app.
    pub connected: bool,
    pub user: Option<User>,
    pub redirect_uri: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceChannel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Guild {
    pub id: String,
    pub name: String,
    pub channels: Vec<VoiceChannel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub guild_id: String,
    /// Empty for Discord's default sounds.
    pub guild_name: String,
    pub sound_id: String,
    pub name: String,
    pub emoji: Option<String>,
    /// False when the account can't use it here (e.g. another server's sound without Nitro).
    pub available: bool,
}

struct Conn {
    client_id: String,
    writer: Writer,
    pending: Pending,
    alive: Arc<AtomicBool>,
    authenticated: bool,
    reader: tokio::task::JoinHandle<()>,
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

pub struct Discord {
    path: PathBuf,
    creds: StdMutex<Creds>,
    conn: Mutex<Option<Conn>>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Discord {
    pub fn new(dir: PathBuf) -> Self {
        let path = dir.join("discord.json");
        let creds = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Discord {
            path,
            creds: StdMutex::new(creds),
            conn: Mutex::new(None),
        }
    }

    fn save(&self, c: &Creds) {
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(c)
            && std::fs::write(&tmp, bytes).is_ok()
        {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    fn update(&self, f: impl FnOnce(&mut Creds)) {
        let mut c = self.creds.lock().unwrap();
        f(&mut c);
        self.save(&c);
    }

    pub async fn status(&self) -> Status {
        let connected = match self.conn.try_lock() {
            Ok(g) => g
                .as_ref()
                .is_some_and(|c| c.authenticated && c.alive.load(Ordering::SeqCst)),
            // Busy signing in or running an action.
            Err(_) => false,
        };
        let c = self.creds.lock().unwrap().clone();
        Status {
            configured: !c.client_id.is_empty() && !c.client_secret.is_empty(),
            client_id: c.client_id,
            signed_in: c.refresh_token.is_some(),
            connected,
            user: c.user,
            redirect_uri: REDIRECT_URI,
        }
    }

    /// Store the user's Discord application. A different client ID signs out.
    /// An empty secret keeps the stored one.
    pub async fn set_app(&self, client_id: String, client_secret: String) {
        let client_id = client_id.trim().to_string();
        let changed = self.creds.lock().unwrap().client_id != client_id;
        if changed {
            *self.conn.lock().await = None;
        }
        self.update(|c| {
            if changed {
                *c = Creds::default();
            }
            c.client_id = client_id;
            if !client_secret.trim().is_empty() {
                c.client_secret = client_secret.trim().to_string();
            }
        });
    }

    pub async fn sign_out(&self) {
        *self.conn.lock().await = None;
        self.update(|c| {
            c.access_token = None;
            c.refresh_token = None;
            c.expires_at = None;
            c.user = None;
        });
    }

    /// Ask Discord to authorize this app (the user approves in Discord),
    /// then keep the session open.
    pub async fn sign_in(&self) -> Result<Status, String> {
        let creds = self.creds.lock().unwrap().clone();
        if creds.client_id.is_empty() || creds.client_secret.is_empty() {
            return Err(NOT_SET_UP.into());
        }
        {
            let mut guard = self.conn.lock().await;
            *guard = None;
            let mut conn = Conn::open(&creds.client_id).await?;
            let r = conn
                .request(
                    "AUTHORIZE",
                    json!({ "client_id": creds.client_id, "scopes": SCOPES }),
                    AUTHORIZE_TIMEOUT,
                )
                .await
                .map_err(|e| format!("Discord didn't authorize the app: {e}"))?;
            let code = r
                .get("code")
                .and_then(|c| c.as_str())
                .ok_or("Discord didn't return an authorization code")?;
            let tok = token_request(&[
                ("client_id", &creds.client_id),
                ("client_secret", &creds.client_secret),
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", REDIRECT_URI),
            ])
            .await?;
            let user = conn.authenticate(&tok.access_token).await?;
            self.update(|c| {
                c.access_token = Some(tok.access_token.clone());
                c.refresh_token = tok.refresh_token.clone().or(c.refresh_token.take());
                c.expires_at = tok.expires_in.map(|s| now_secs() + s);
                c.user = user;
            });
            *guard = Some(conn);
        }
        Ok(self.status().await)
    }

    /// Connect (if needed) and check the session; for the settings page.
    pub async fn check(&self) -> Result<Status, String> {
        drop(self.session().await?);
        Ok(self.status().await)
    }

    /// A live, authenticated session. Reconnects after Discord restarts and
    /// refreshes an expired token.
    async fn session(&self) -> Result<MutexGuard<'_, Option<Conn>>, String> {
        let mut guard = self.conn.lock().await;
        let creds = self.creds.lock().unwrap().clone();
        if creds.client_id.is_empty() || creds.client_secret.is_empty() {
            return Err(NOT_SET_UP.into());
        }
        if guard
            .as_ref()
            .is_some_and(|c| !c.alive.load(Ordering::SeqCst) || c.client_id != creds.client_id)
        {
            *guard = None;
        }
        if guard.is_none() {
            *guard = Some(Conn::open(&creds.client_id).await?);
        }
        let conn = guard.as_mut().expect("just opened");
        if conn.authenticated {
            return Ok(guard);
        }

        let fresh = creds.expires_at.is_none_or(|t| now_secs() + 60 < t);
        let mut result = match (&creds.access_token, fresh) {
            (Some(t), true) => conn.authenticate(t).await,
            (None, _) if creds.refresh_token.is_none() => return Err(SIGN_IN.into()),
            _ => Err("token expired".into()),
        };
        if result.is_err() {
            let Some(refresh) = creds.refresh_token.clone() else {
                return Err(SIGN_IN.into());
            };
            let tok = match token_request(&[
                ("client_id", &creds.client_id),
                ("client_secret", &creds.client_secret),
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh),
            ])
            .await
            {
                Ok(t) => t,
                Err(e) => {
                    // A rejected refresh token means signing in again.
                    if e.contains("invalid_grant") {
                        self.update(|c| {
                            c.access_token = None;
                            c.refresh_token = None;
                        });
                        return Err(SIGN_IN.into());
                    }
                    return Err(e);
                }
            };
            self.update(|c| {
                c.access_token = Some(tok.access_token.clone());
                if tok.refresh_token.is_some() {
                    c.refresh_token = tok.refresh_token.clone();
                }
                c.expires_at = tok.expires_in.map(|s| now_secs() + s);
            });
            result = conn.authenticate(&tok.access_token).await;
        }
        let user = result.map_err(|e| {
            format!("Discord rejected the sign-in ({e}). Sign in again in Integrations.")
        })?;
        if user.is_some() {
            self.update(|c| c.user = user);
        }
        Ok(guard)
    }

    async fn request(&self, cmd: &str, args: Value) -> Result<Value, String> {
        let guard = self.session().await?;
        let conn = guard.as_ref().expect("session is open");
        conn.request(cmd, args, REQUEST_TIMEOUT).await
    }

    /// Runs one of the Discord actions a card or module button can hold.
    pub async fn execute(&self, params: &Value) -> Result<(), String> {
        let s = |k: &str| {
            params
                .get(k)
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .ok_or_else(|| format!("missing `{k}`"))
        };
        match s("op")?.as_str() {
            "joinVoice" => {
                let channel = s("channel")?;
                self.request(
                    "SELECT_VOICE_CHANNEL",
                    json!({ "channel_id": channel, "force": true }),
                )
                .await
                .map(|_| ())
            }
            "leaveVoice" => self
                .request("SELECT_VOICE_CHANNEL", json!({ "channel_id": null }))
                .await
                .map(|_| ()),
            "toggleMute" => {
                let v = self.request("GET_VOICE_SETTINGS", json!({})).await?;
                let deaf = v.get("deaf").and_then(|x| x.as_bool()).unwrap_or(false);
                let mute = v.get("mute").and_then(|x| x.as_bool()).unwrap_or(false);
                // Unmuting while deafened has to undeafen too, as in Discord itself.
                let args = if deaf {
                    json!({ "mute": false, "deaf": false })
                } else {
                    json!({ "mute": !mute })
                };
                self.request("SET_VOICE_SETTINGS", args).await.map(|_| ())
            }
            "toggleDeafen" => {
                let v = self.request("GET_VOICE_SETTINGS", json!({})).await?;
                let deaf = v.get("deaf").and_then(|x| x.as_bool()).unwrap_or(false);
                self.request("SET_VOICE_SETTINGS", json!({ "deaf": !deaf }))
                    .await
                    .map(|_| ())
            }
            "playSound" => {
                let sound = s("sound")?;
                let guild = params
                    .get("guild")
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string();
                self.request(
                    "PLAY_SOUNDBOARD_SOUND",
                    json!({ "guild_id": guild, "sound_id": sound }),
                )
                .await
                .map(|_| ())
                .map_err(|e| format!("{e} (you need to be in a voice channel)"))
            }
            "toggleCamera" => self.request("TOGGLE_VIDEO", json!({})).await.map(|_| ()),
            "toggleScreenShare" => self
                .request("TOGGLE_SCREENSHARE", json!({}))
                .await
                .map(|_| ()),
            other => Err(format!("unknown Discord action `{other}`")),
        }
    }

    /// Voice and stage channels, grouped by server.
    pub async fn voice_channels(&self) -> Result<Vec<Guild>, String> {
        let r = self.request("GET_GUILDS", json!({})).await?;
        let mut out = Vec::new();
        for g in r
            .get("guilds")
            .and_then(|g| g.as_array())
            .cloned()
            .unwrap_or_default()
        {
            let (Some(id), Some(name)) = (
                g.get("id").and_then(|v| v.as_str()),
                g.get("name").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            let channels = self
                .request("GET_CHANNELS", json!({ "guild_id": id }))
                .await
                .ok()
                .and_then(|c| c.get("channels").and_then(|c| c.as_array()).cloned())
                .unwrap_or_default()
                .into_iter()
                // 2 = voice, 13 = stage
                .filter(|c| matches!(c.get("type").and_then(|t| t.as_i64()), Some(2) | Some(13)))
                .filter_map(|c| {
                    Some(VoiceChannel {
                        id: c.get("id")?.as_str()?.to_string(),
                        name: c.get("name")?.as_str()?.to_string(),
                    })
                })
                .collect::<Vec<_>>();
            if !channels.is_empty() {
                out.push(Guild {
                    id: id.to_string(),
                    name: name.to_string(),
                    channels,
                });
            }
        }
        Ok(out)
    }

    pub async fn sounds(&self) -> Result<Vec<Sound>, String> {
        let guilds: HashMap<String, String> = self
            .request("GET_GUILDS", json!({}))
            .await?
            .get("guilds")
            .and_then(|g| g.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|g| {
                Some((
                    g.get("id")?.as_str()?.to_string(),
                    g.get("name")?.as_str()?.to_string(),
                ))
            })
            .collect();
        let r = self.request("GET_SOUNDBOARD_SOUNDS", json!({})).await?;
        let list = r
            .as_array()
            .cloned()
            .or_else(|| r.get("sounds").and_then(|s| s.as_array()).cloned())
            .unwrap_or_default();
        Ok(list
            .into_iter()
            .filter_map(|s| {
                let guild_id = match s.get("guild_id") {
                    Some(Value::String(g)) => g.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    _ => "0".to_string(),
                };
                Some(Sound {
                    guild_name: guilds.get(&guild_id).cloned().unwrap_or_default(),
                    guild_id,
                    sound_id: match s.get("sound_id")? {
                        Value::String(x) => x.clone(),
                        Value::Number(n) => n.to_string(),
                        _ => return None,
                    },
                    name: s.get("name")?.as_str()?.to_string(),
                    emoji: s
                        .get("emoji_name")
                        .and_then(|e| e.as_str())
                        .map(str::to_string),
                    available: s.get("available").and_then(|a| a.as_bool()).unwrap_or(true),
                })
            })
            .collect())
    }
}

impl Conn {
    async fn open(client_id: &str) -> Result<Conn, String> {
        let stream = open_socket().await?;
        let (mut rd, mut wr) = tokio::io::split(stream);
        write_frame(
            &mut wr,
            OP_HANDSHAKE,
            &json!({ "v": 1, "client_id": client_id }),
        )
        .await
        .map_err(|e| format!("Couldn't talk to Discord: {e}"))?;
        // The first frame is READY, or CLOSE with a reason (e.g. a bad client ID).
        let (op, data) = tokio::time::timeout(REQUEST_TIMEOUT, read_frame(&mut rd))
            .await
            .map_err(|_| "Discord didn't answer".to_string())?
            .map_err(|e| format!("Couldn't talk to Discord: {e}"))?;
        if op == OP_CLOSE {
            let msg = data
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("connection refused");
            return Err(format!(
                "Discord refused the connection: {msg}. Check the client ID."
            ));
        }
        if !(op == OP_FRAME && data.get("evt").and_then(|e| e.as_str()) == Some("READY")) {
            return Err("Discord sent something unexpected".into());
        }

        let writer: Writer = Arc::new(Mutex::new(wr));
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let reader = tokio::spawn(read_loop(
            rd,
            writer.clone(),
            pending.clone(),
            alive.clone(),
        ));
        Ok(Conn {
            client_id: client_id.to_string(),
            writer,
            pending,
            alive,
            authenticated: false,
            reader,
        })
    }

    async fn request(&self, cmd: &str, args: Value, timeout: Duration) -> Reply {
        if !self.alive.load(Ordering::SeqCst) {
            return Err("Lost the connection to Discord".into());
        }
        let nonce = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(nonce.clone(), tx);
        let frame = json!({ "cmd": cmd, "args": args, "nonce": nonce });
        let sent = write_frame(&mut *self.writer.lock().await, OP_FRAME, &frame).await;
        if let Err(e) = sent {
            self.pending.lock().unwrap().remove(&nonce);
            self.alive.store(false, Ordering::SeqCst);
            return Err(format!("Lost the connection to Discord: {e}"));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("Lost the connection to Discord".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&nonce);
                Err("Discord didn't answer in time".into())
            }
        }
    }

    async fn authenticate(&mut self, token: &str) -> Result<Option<User>, String> {
        let r = self
            .request(
                "AUTHENTICATE",
                json!({ "access_token": token }),
                REQUEST_TIMEOUT,
            )
            .await?;
        self.authenticated = true;
        Ok(r.get("user")
            .and_then(|u| serde_json::from_value(u.clone()).ok()))
    }
}

async fn read_loop(
    mut rd: ReadHalf<Box<dyn Stream>>,
    writer: Writer,
    pending: Pending,
    alive: Arc<AtomicBool>,
) {
    while let Ok((op, data)) = read_frame(&mut rd).await {
        match op {
            OP_PING => {
                let _ = write_frame(&mut *writer.lock().await, OP_PONG, &data).await;
            }
            OP_FRAME => {
                let Some(nonce) = data.get("nonce").and_then(|n| n.as_str()) else {
                    continue; // events (READY, subscriptions)
                };
                let Some(tx) = pending.lock().unwrap().remove(nonce) else {
                    continue;
                };
                let body = data.get("data").cloned().unwrap_or(Value::Null);
                let reply = if data.get("evt").and_then(|e| e.as_str()) == Some("ERROR") {
                    Err(body
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Discord reported an error")
                        .to_string())
                } else {
                    Ok(body)
                };
                let _ = tx.send(reply);
            }
            OP_CLOSE => break,
            _ => {}
        }
    }
    alive.store(false, Ordering::SeqCst);
    for (_, tx) in pending.lock().unwrap().drain() {
        let _ = tx.send(Err("Discord closed the connection".into()));
    }
}

async fn write_frame(
    w: &mut WriteHalf<Box<dyn Stream>>,
    op: u32,
    data: &Value,
) -> std::io::Result<()> {
    let body = serde_json::to_vec(data)?;
    let mut buf = Vec::with_capacity(8 + body.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
    buf.extend_from_slice(&body);
    w.write_all(&buf).await?;
    w.flush().await
}

async fn read_frame(r: &mut ReadHalf<Box<dyn Stream>>) -> std::io::Result<(u32, Value)> {
    let mut head = [0u8; 8];
    r.read_exact(&mut head).await?;
    let op = u32::from_le_bytes(head[0..4].try_into().expect("4 bytes"));
    let len = u32::from_le_bytes(head[4..8].try_into().expect("4 bytes")) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

const NOT_RUNNING: &str = "Discord isn't running on this computer";

#[cfg(windows)]
async fn open_socket() -> Result<Box<dyn Stream>, String> {
    use tokio::net::windows::named_pipe::ClientOptions;
    for i in 0..10 {
        if let Ok(pipe) = ClientOptions::new().open(format!(r"\\?\pipe\discord-ipc-{i}")) {
            return Ok(Box::new(pipe));
        }
    }
    Err(NOT_RUNNING.into())
}

#[cfg(unix)]
async fn open_socket() -> Result<Box<dyn Stream>, String> {
    for dir in ipc_dirs() {
        for i in 0..10 {
            if let Ok(s) =
                tokio::net::UnixStream::connect(dir.join(format!("discord-ipc-{i}"))).await
            {
                return Ok(Box::new(s));
            }
        }
    }
    Err(NOT_RUNNING.into())
}

/// Where Discord puts its socket: the first of these variables that is set,
/// as in Discord's own RPC docs, plus Flatpak and Snap locations on Linux.
#[cfg(unix)]
fn ipc_dirs() -> Vec<PathBuf> {
    let mut base: Vec<PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .filter_map(|k| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .collect();
    #[cfg(target_os = "macos")]
    if let Some(t) = darwin_user_temp_dir() {
        base.push(t);
    }
    base.push(PathBuf::from("/tmp"));
    let mut out = Vec::new();
    for b in base {
        #[cfg(target_os = "linux")]
        {
            out.push(b.join("app/com.discordapp.Discord"));
            out.push(b.join("snap.discord"));
        }
        out.push(b);
    }
    out.dedup();
    out
}

/// The per-user temp folder Discord uses on macOS, in case this app was
/// started without `TMPDIR` set.
#[cfg(target_os = "macos")]
fn darwin_user_temp_dir() -> Option<PathBuf> {
    let mut buf = vec![0u8; 1024];
    let n = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buf.as_mut_ptr().cast(),
            buf.len(),
        )
    };
    if n == 0 || n > buf.len() {
        return None;
    }
    buf.truncate(n - 1);
    String::from_utf8(buf).ok().map(PathBuf::from)
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    let enc = |s: &str| {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

async fn token_request(pairs: &[(&str, &str)]) -> Result<Token, String> {
    let res = crate::market::client()
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_encode(pairs))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Discord: {e}"))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return serde_json::from_value(body)
            .map_err(|_| "Discord sent an unexpected token reply".to_string());
    }
    let code = body.get("error").and_then(|e| e.as_str()).unwrap_or("");
    let desc = body
        .get("error_description")
        .and_then(|e| e.as_str())
        .unwrap_or("");
    Err(match code {
        "invalid_client" => {
            "Discord rejected the client ID or secret (invalid_client).".to_string()
        }
        _ if desc.contains("redirect_uri") => format!(
            "Discord wants a redirect URL: add {REDIRECT_URI} under OAuth2 › Redirects in your Discord application ({code})."
        ),
        _ => format!(
            "Discord refused the sign-in: {} ({code})",
            if desc.is_empty() {
                status.as_str()
            } else {
                desc
            }
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::form_encode;

    #[test]
    fn encodes_form_values() {
        assert_eq!(
            form_encode(&[("redirect_uri", "http://localhost"), ("code", "a b+c")]),
            "redirect_uri=http%3A%2F%2Flocalhost&code=a%20b%2Bc"
        );
    }
}
