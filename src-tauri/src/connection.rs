//! One long-lived TLS session to the selected bar, run as an actor task.
//!
//! Lifecycle: connect → authenticate with the stored token (act 100) → online.
//! Without a valid token we wait for the UI to ask for pairing (act 101), since
//! the user has ~10 s to tap Approve on the bar. While online we send a
//! heartbeat, match replies to requests by `id`, forward unsolicited messages
//! to the UI, and answer bar → PC pushes. Any failure drops back to a
//! reconnect loop that also re-discovers the bar if its IP changed.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_rustls::TlsConnector;

use crate::discovery;
use crate::protocol::{Envelope, MAX_LINE, act, parse_line};
use crate::store::SavedBar;
use crate::{AppState, pc_agent, tls};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const PAIR_WINDOW: Duration = Duration::from_secs(12);
const HEARTBEAT_EVERY: Duration = Duration::from_secs(3);
const DEAD_AFTER: Duration = Duration::from_secs(15);
const PROBE_TIMEOUT: Duration = Duration::from_millis(600);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnState {
    /// No bar selected.
    Idle,
    Connecting,
    /// Connected, but this computer isn't paired (or the token was revoked).
    NeedsPairing,
    /// Pairing request sent; waiting for someone to tap Approve on the bar.
    AwaitingApproval,
    Online,
    /// Lost or couldn't reach the bar; retrying in the background.
    Offline,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: ConnState,
    pub bar: Option<SavedBar>,
    pub error: Option<String>,
    /// Our address as seen on the bar's network (used for icon URLs).
    pub local_ip: Option<String>,
}

impl Status {
    pub fn idle() -> Self {
        Status {
            state: ConnState::Idle,
            bar: None,
            error: None,
            local_ip: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestError {
    pub code: i64,
    pub message: String,
}

impl RequestError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        RequestError {
            code,
            message: message.into(),
        }
    }
}

pub type Reply = Result<Value, RequestError>;

enum Cmd {
    Request {
        act: i64,
        data: Option<Value>,
        timeout: Duration,
        reply: oneshot::Sender<Reply>,
    },
    Pair,
    Reconnect,
    /// Internal: write a raw line (used for replies to bar pushes).
    Send(String),
    Stop,
}

#[derive(Clone)]
pub struct ConnHandle {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl ConnHandle {
    pub async fn request(&self, act: i64, data: Option<Value>, timeout: Duration) -> Reply {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::Request {
                act,
                data,
                timeout,
                reply,
            })
            .map_err(|_| RequestError::new(-2, "Not connected to a bar"))?;
        rx.await
            .unwrap_or_else(|_| Err(RequestError::new(-2, "Connection closed")))
    }

    pub fn pair(&self) {
        let _ = self.tx.send(Cmd::Pair);
    }

    pub fn reconnect(&self) {
        let _ = self.tx.send(Cmd::Reconnect);
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Cmd::Stop);
    }
}

pub fn spawn(app: AppHandle, bar: SavedBar, pair_now: bool) -> ConnHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = ConnHandle { tx: tx.clone() };
    tauri::async_runtime::spawn(run(app, bar, pair_now, tx, rx));
    handle
}

type Tls = tokio_rustls::client::TlsStream<TcpStream>;

async fn open(bar: &SavedBar) -> std::io::Result<(Tls, Option<IpAddr>)> {
    let ip: IpAddr = bar
        .ip
        .parse()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid IP address"))?;
    let addr = SocketAddr::new(ip, bar.tcp_port);
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "connection timed out"))??;
    let _ = tcp.set_nodelay(true);
    let local = tcp.local_addr().ok().map(|a| a.ip());
    let connector = TlsConnector::from(tls::client_config());
    let name = rustls::pki_types::ServerName::IpAddress(ip.into());
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(name, tcp))
        .await
        .map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "TLS handshake timed out")
        })??;
    Ok((stream, local))
}

struct Ctx {
    app: AppHandle,
    bar: SavedBar,
    status: Status,
}

impl Ctx {
    fn set(&mut self, state: ConnState, error: Option<String>) {
        self.status.state = state;
        self.status.error = error;
        self.status.bar = Some(self.bar.clone());
        self.publish();
    }

    fn publish(&self) {
        let st = self.app.state::<AppState>();
        *st.status.lock().unwrap() = self.status.clone();
        let _ = self.app.emit("bar-status", &self.status);
    }

    fn token(&self) -> Option<String> {
        let st = self.app.state::<AppState>();
        let s = st.settings.lock().unwrap();
        s.bars
            .iter()
            .find(|b| b.serial_no == self.bar.serial_no)
            .and_then(|b| b.token.clone())
    }

    fn save_token(&mut self, token: Option<String>) {
        self.bar.token = token.clone();
        let st = self.app.state::<AppState>();
        let mut s = st.settings.lock().unwrap();
        if let Some(b) = s.bar_mut(&self.bar.serial_no) {
            b.token = token;
        }
        let _ = st.store.save_settings(&s);
    }

    /// Picks up a new firmware version (bars update in place) or command port
    /// from a discovery reply at the address we're about to connect to.
    fn refresh(&mut self, f: &discovery::FoundBar) {
        if f.serial_no != self.bar.serial_no {
            return;
        }
        let changed = f.tcp_port != self.bar.tcp_port
            || (f.ver.is_some() && f.ver != self.bar.ver)
            || (f.name.is_some() && f.name != self.bar.name);
        if !changed {
            return;
        }
        self.bar.tcp_port = f.tcp_port;
        if f.ver.is_some() {
            self.bar.ver = f.ver.clone();
        }
        if f.name.is_some() {
            self.bar.name = f.name.clone();
        }
        let st = self.app.state::<AppState>();
        let mut s = st.settings.lock().unwrap();
        s.upsert_bar(f);
        let _ = st.store.save_settings(&s);
    }

    /// The bar may have moved (DHCP) or changed its command port.
    async fn rediscover(&mut self) {
        let Ok(found) = discovery::discover(Duration::from_millis(1500), &[]).await else {
            return;
        };
        if let Some(f) = found
            .into_iter()
            .find(|f| f.serial_no == self.bar.serial_no)
            && (f.ip != self.bar.ip || f.tcp_port != self.bar.tcp_port)
        {
            self.bar.ip = f.ip.clone();
            self.bar.tcp_port = f.tcp_port;
            let st = self.app.state::<AppState>();
            let mut s = st.settings.lock().unwrap();
            s.upsert_bar(&f);
            let _ = st.store.save_settings(&s);
        }
    }
}

/// Wait for `dur`, or until a command asks us to act sooner. Requests that
/// arrive while disconnected fail immediately. Returns false on Stop.
async fn idle_wait(
    rx: &mut mpsc::UnboundedReceiver<Cmd>,
    dur: Duration,
    pair_now: &mut bool,
) -> bool {
    let deadline = Instant::now() + dur;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return true,
            cmd = rx.recv() => match cmd {
                None | Some(Cmd::Stop) => return false,
                Some(Cmd::Request { reply, .. }) => {
                    let _ = reply.send(Err(RequestError::new(-2, "The bar is offline")));
                }
                Some(Cmd::Pair) => { *pair_now = true; return true; }
                Some(Cmd::Reconnect) => return true,
                Some(Cmd::Send(_)) => {}
            }
        }
    }
}

struct Pending {
    act: i64,
    reply: oneshot::Sender<Reply>,
    deadline: Instant,
}

async fn run(
    app: AppHandle,
    bar: SavedBar,
    mut pair_now: bool,
    self_tx: mpsc::UnboundedSender<Cmd>,
    mut rx: mpsc::UnboundedReceiver<Cmd>,
) {
    let mut ctx = Ctx {
        app: app.clone(),
        bar,
        status: Status::idle(),
    };
    ctx.bar.token = ctx.token();
    let mut failures: u32 = 0;
    let mut next_id: u64 = 0;
    let mut keep_error: Option<String> = None;

    loop {
        // While waiting for the user to pair, reconnects happen silently.
        if !(ctx.status.state == ConnState::NeedsPairing && ctx.bar.token.is_none() && !pair_now) {
            ctx.set(ConnState::Connecting, None);
        }
        if let Ok(IpAddr::V4(ip)) = ctx.bar.ip.parse::<IpAddr>()
            && let Some(found) = discovery::probe(ip, PROBE_TIMEOUT).await
        {
            ctx.refresh(&found);
        }
        let (stream, local_ip) = match open(&ctx.bar).await {
            Ok(s) => s,
            Err(e) => {
                failures += 1;
                ctx.set(
                    ConnState::Offline,
                    Some(format!("Can't reach the bar at {}: {e}", ctx.bar.ip)),
                );
                ctx.rediscover().await;
                let wait = Duration::from_secs((2u64 << failures.min(3)).min(15));
                if !idle_wait(&mut rx, wait, &mut pair_now).await {
                    return;
                }
                continue;
            }
        };
        ctx.status.local_ip = local_ip.map(|i| i.to_string());

        let (r, mut w) = tokio::io::split(stream);
        let mut lines = BufReader::new(r).lines();
        let mut pending: HashMap<String, Pending> = HashMap::new();
        let mut authed = false;
        let mut auth_id: Option<String> = None;
        let mut auth_deadline: Option<Instant> = None;
        let mut pair_id: Option<String> = None;
        let mut pair_deadline: Option<Instant> = None;
        let mut last_recv = Instant::now();
        let mut last_sent = Instant::now();
        let mut tick = tokio::time::interval(Duration::from_millis(500));

        macro_rules! send_env {
            ($act:expr, $data:expr) => {{
                next_id += 1;
                let id = next_id.to_string();
                let line = Envelope::request(id.clone(), $act, $data).to_line();
                let ok = w.write_all(line.as_bytes()).await.is_ok() && w.flush().await.is_ok();
                last_sent = Instant::now();
                (id, ok)
            }};
        }

        // Authenticate, or wait for the user to start pairing.
        let mut alive = true;
        if let Some(token) = ctx.bar.token.clone() {
            let (id, ok) = send_env!(act::AUTH, Some(Value::String(token)));
            auth_id = Some(id);
            auth_deadline = Some(Instant::now() + AUTH_TIMEOUT);
            alive = ok;
        } else if pair_now {
            pair_now = false;
            keep_error = None;
            let (id, ok) = send_env!(act::REQUEST_TOKEN, Some(pair_payload(&app)));
            pair_id = Some(id);
            pair_deadline = Some(Instant::now() + PAIR_WINDOW);
            alive = ok;
            ctx.set(ConnState::AwaitingApproval, None);
        } else {
            ctx.set(ConnState::NeedsPairing, keep_error.clone());
        }

        // `alive` is false if the first write failed; the loop itself exits via `break`.
        #[allow(clippy::while_immutable_condition)]
        while alive {
            tokio::select! {
                line = lines.next_line() => {
                    let line = match line {
                        Ok(Some(l)) => l,
                        _ => break,
                    };
                    last_recv = Instant::now();
                    let line = line.trim();
                    if line.is_empty() { continue; }
                    let Some(env) = parse_line(line) else { continue };

                    if env.act == act::AUTH && env.id.is_some() && env.id == auth_id {
                        auth_id = None;
                        auth_deadline = None;
                        if env.is_ok() {
                            authed = true;
                            failures = 0;
                            ctx.set(ConnState::Online, None);
                        } else {
                            // Token rejected (revoked, or the bar was reset).
                            ctx.save_token(None);
                            ctx.set(ConnState::NeedsPairing, Some("The bar no longer recognises this computer. Pair again to continue.".into()));
                        }
                        continue;
                    }

                    if env.act == act::REQUEST_TOKEN && env.id.is_some() && env.id == pair_id {
                        let state = env.data.as_ref().and_then(|d| d.get("state")).and_then(|s| s.as_i64());
                        if !env.is_ok() {
                            pair_id = None;
                            pair_deadline = None;
                            let msg = env.message();
                            let msg = if msg.contains("license") {
                                "The bar already has 10 paired computers. Remove one on the bar and try again.".to_string()
                            } else {
                                "Pairing was declined or timed out on the bar.".to_string()
                            };
                            keep_error = Some(msg.clone());
                            ctx.set(ConnState::NeedsPairing, Some(msg));
                        } else if state == Some(1) {
                            pair_id = None;
                            pair_deadline = None;
                            let token = env.data.as_ref().and_then(|d| d.get("token")).and_then(|t| t.as_str()).map(str::to_string);
                            if let Some(token) = token {
                                ctx.save_token(Some(token.clone()));
                                let (id, ok) = send_env!(act::AUTH, Some(Value::String(token)));
                                auth_id = Some(id);
                                auth_deadline = Some(Instant::now() + AUTH_TIMEOUT);
                                if !ok { break; }
                            }
                        } else {
                            ctx.set(ConnState::AwaitingApproval, None);
                        }
                        continue;
                    }

                    if env.act == act::PUSH {
                        let app2 = app.clone();
                        let tx = self_tx.clone();
                        let id = env.id.clone();
                        let data = env.data.clone().unwrap_or(Value::Null);
                        tokio::spawn(async move {
                            let reply_data = pc_agent::handle(&app2, data).await;
                            let mut reply = json!({ "act": act::PUSH, "code": 200, "data": reply_data });
                            if let Some(id) = id { reply["id"] = Value::String(id); }
                            let _ = tx.send(Cmd::Send(format!("{reply}\n")));
                        });
                        continue;
                    }

                    if let Some(id) = env.unknown_act_for()
                        && let Some(p) = pending.remove(id)
                    {
                        let _ = p.reply.send(Err(RequestError::new(-5, format!("The bar doesn't support this request (act {}). Its firmware may be newer or older than this app expects.", p.act))));
                        continue;
                    }

                    if let Some(id) = &env.id
                        && let Some(p) = pending.remove(id)
                    {
                        let result = if env.is_ok() {
                            Ok(env.data.unwrap_or(Value::Null))
                        } else {
                            let msg = env.message();
                            Err(RequestError::new(env.code.unwrap_or(-1), if msg.is_empty() { "The bar reported an error".to_string() } else { msg }))
                        };
                        let _ = p.reply.send(result);
                        continue;
                    }
                    if env.act != act::HEARTBEAT {
                        let _ = app.emit("bar-push", &env);
                    }
                }

                cmd = rx.recv() => match cmd {
                    None | Some(Cmd::Stop) => {
                        for (_, p) in pending.drain() { let _ = p.reply.send(Err(RequestError::new(-2, "Disconnected"))); }
                        let _ = w.shutdown().await;
                        return;
                    }
                    Some(Cmd::Reconnect) => break,
                    Some(Cmd::Pair) => {
                        if !authed && pair_id.is_none() {
                            keep_error = None;
                            let (id, ok) = send_env!(act::REQUEST_TOKEN, Some(pair_payload(&app)));
                            pair_id = Some(id);
                            pair_deadline = Some(Instant::now() + PAIR_WINDOW);
                            ctx.set(ConnState::AwaitingApproval, None);
                            if !ok { pair_now = true; break; }
                        }
                    }
                    Some(Cmd::Send(line)) => {
                        if w.write_all(line.as_bytes()).await.is_err() { break; }
                        let _ = w.flush().await;
                        last_sent = Instant::now();
                    }
                    Some(Cmd::Request { act: a, data, timeout, reply }) => {
                        if !authed {
                            let _ = reply.send(Err(RequestError::new(-2, "Not connected to the bar")));
                            continue;
                        }
                        next_id += 1;
                        let id = next_id.to_string();
                        let line = Envelope::request(id.clone(), a, data).to_line();
                        if line.len() > MAX_LINE {
                            let _ = reply.send(Err(RequestError::new(-3, format!("Message too large for the bar ({} bytes, limit {MAX_LINE})", line.len()))));
                            continue;
                        }
                        if w.write_all(line.as_bytes()).await.is_err() || w.flush().await.is_err() {
                            let _ = reply.send(Err(RequestError::new(-2, "Connection lost")));
                            break;
                        }
                        last_sent = Instant::now();
                        pending.insert(id, Pending { act: a, reply, deadline: Instant::now() + timeout });
                    }
                },

                _ = tick.tick() => {
                    let now = Instant::now();
                    if authed && now.duration_since(last_sent) >= HEARTBEAT_EVERY && now.duration_since(last_recv) >= Duration::from_millis(1500) {
                        let (_, ok) = send_env!(act::HEARTBEAT, None);
                        if !ok { break; }
                    }
                    if authed && now.duration_since(last_recv) > DEAD_AFTER {
                        break;
                    }
                    if auth_deadline.is_some_and(|d| now > d) {
                        break;
                    }
                    if pair_deadline.is_some_and(|d| now > d) {
                        pair_id = None;
                        pair_deadline = None;
                        let msg = "No response from the bar. Tap Approve on the bar's screen within 10 seconds.".to_string();
                        keep_error = Some(msg.clone());
                        ctx.set(ConnState::NeedsPairing, Some(msg));
                    }
                    let expired: Vec<String> = pending.iter().filter(|(_, p)| now > p.deadline).map(|(k, _)| k.clone()).collect();
                    for id in expired {
                        if let Some(p) = pending.remove(&id) {
                            let _ = p.reply.send(Err(RequestError::new(-4, "The bar didn't answer in time")));
                        }
                    }
                }
            }
        }

        for (_, p) in pending.drain() {
            let _ = p.reply.send(Err(RequestError::new(-2, "Connection lost")));
        }
        let had_token = ctx.bar.token.is_some();
        if had_token {
            ctx.set(
                ConnState::Offline,
                Some("Connection to the bar was lost. Reconnecting…".into()),
            );
        } else {
            // Without a token the bar closes the socket after a denied pairing;
            // reconnect quietly and keep showing the pairing prompt.
            ctx.status.state = ConnState::NeedsPairing;
            ctx.status.error = keep_error.clone();
            ctx.publish();
        }
        let wait = if authed {
            Duration::from_secs(1)
        } else {
            Duration::from_secs(2)
        };
        if !idle_wait(&mut rx, wait, &mut pair_now).await {
            return;
        }
    }
}

fn pair_payload(app: &AppHandle) -> Value {
    let st = app.state::<AppState>();
    let client_id = st.settings.lock().unwrap().client_id.clone();
    let host = gethostname::gethostname()
        .to_string_lossy()
        .trim_end_matches(".local")
        .to_string();
    let name = if host.is_empty() {
        "ultrabar app".to_string()
    } else {
        format!("ultrabar · {host}")
    };
    json!({ "name": name, "id": client_id })
}
