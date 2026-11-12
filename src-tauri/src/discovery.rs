//! UDP discovery: send `discovery.ultrabar` to port 5319 and collect the JSON
//! replies. The bar answers to the sender's address, so an ephemeral port is
//! enough and avoids clashing with the official app (which binds 5319).

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use tokio::time::Instant;

pub const DISCOVERY_PORT: u16 = 5319;
const PROBE: &[u8] = b"discovery.ultrabar";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundBar {
    pub serial_no: String,
    pub ip: String,
    pub tcp_port: u16,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ver: Option<String>,
}

fn broadcast_targets() -> Vec<Ipv4Addr> {
    let mut targets = vec![Ipv4Addr::BROADCAST];
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let if_addrs::IfAddr::V4(v4) = iface.addr
                && let Some(b) = v4.broadcast
            {
                targets.push(b);
            }
        }
    }
    targets
}

fn make_socket() -> std::io::Result<UdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_broadcast(true)?;
    sock.set_nonblocking(true)?;
    sock.bind(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).into())?;
    UdpSocket::from_std(sock.into())
}

fn parse_reply(buf: &[u8], from: SocketAddr) -> Option<FoundBar> {
    let v: Value = serde_json::from_slice(buf).ok()?;
    let serial_no = v.get("serialNo")?.as_str()?.to_string();
    let tcp_port = v.get("tcpPort")?.as_u64()? as u16;
    let ip = v
        .get("ip")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| from.ip().to_string());
    Some(FoundBar {
        serial_no,
        ip,
        tcp_port,
        name: v.get("name").and_then(|x| x.as_str()).map(str::to_string),
        ver: v.get("ver").and_then(|x| x.as_str()).map(str::to_string),
    })
}

/// Probe the network (and any explicit addresses) for `timeout`, re-sending
/// every 700 ms. Returns bars de-duplicated by serial number.
pub async fn discover(timeout: Duration, extra: &[Ipv4Addr]) -> std::io::Result<Vec<FoundBar>> {
    let sock = make_socket()?;
    let mut targets = broadcast_targets();
    targets.extend_from_slice(extra);
    let mut seen_targets = HashSet::new();
    targets.retain(|t| seen_targets.insert(*t));

    let deadline = Instant::now() + timeout;
    let mut next_send = Instant::now();
    let mut found: Vec<FoundBar> = Vec::new();
    let mut buf = [0u8; 4096];

    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        if now >= next_send {
            for t in &targets {
                let _ = sock.send_to(PROBE, (*t, DISCOVERY_PORT)).await;
            }
            next_send = now + Duration::from_millis(700);
        }
        let wake = deadline.min(next_send);
        if let Ok(Ok((n, from))) = tokio::time::timeout_at(wake, sock.recv_from(&mut buf)).await
            && let Some(bar) = parse_reply(&buf[..n], from)
        {
            match found.iter_mut().find(|b| b.serial_no == bar.serial_no) {
                Some(existing) => *existing = bar,
                None => found.push(bar),
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_discovery_reply() {
        let from: SocketAddr = "192.168.1.175:5319".parse().unwrap();
        let bar = parse_reply(
            br#"{"tcpPort":7431,"ver":"1.0.1(1)","ip":"192.168.1.175","name":"ultrabar","serialNo":"5001G26071XS0016"}"#,
            from,
        )
        .unwrap();
        assert_eq!(bar.tcp_port, 7431);
        assert_eq!(bar.serial_no, "5001G26071XS0016");
        assert_eq!(bar.name.as_deref(), Some("ultrabar"));
        // Falls back to the sender's address and ignores our own probe.
        let bar = parse_reply(br#"{"tcpPort":1,"serialNo":"X"}"#, from).unwrap();
        assert_eq!(bar.ip, "192.168.1.175");
        assert!(parse_reply(PROBE, from).is_none());
    }
}
