//! This computer's load, for the bar's system cards (CPU, memory, storage and
//! network).
//!
//! While such a card is on screen, launcher 1.0.9 asks with `act 1000000`
//! pushes of type `CPU` (every 3 s), `MEMORY` (8 s), `STORAGE` (10 s) and
//! `NETWORK` (5 s). It reads the reply's `payload` as a whole percent, or as
//! `{totalReceived, totalSent}` byte counters for the network card, which
//! works out the speed from two replies in a row.
//!
//! Each number is the one the official app reports on that OS (see
//! `docs/protocol.md`, "System cards"). CPU usage needs two samples, so a
//! background thread samples it every second while the bar keeps asking.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Cumulative bytes since boot, summed over the interfaces the official app
/// counts on this OS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub total_received: u64,
    pub total_sent: u64,
}

/// Total CPU load, 0–100. `None` until the first sample, about a second
/// after the bar first asks.
pub fn cpu() -> Option<u8> {
    sampler::read()
}

/// Memory in use, 0–100.
pub async fn memory() -> Option<u8> {
    blocking(imp::memory).await
}

/// How full the disk is, 0–100.
pub async fn storage() -> Option<u8> {
    blocking(imp::storage).await
}

pub async fn network() -> Option<Network> {
    blocking(imp::network).await
}

async fn blocking<T: Send + 'static>(f: fn() -> Option<T>) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok().flatten()
}

/// `used / total` as a whole percent, rounded and kept within 0–100.
fn percent(used: f64, total: f64) -> Option<u8> {
    (total > 0.0 && used.is_finite()).then(|| (used / total * 100.0).clamp(0.0, 100.0).round() as u8)
}

/// Samples CPU load every second, like the official app, but only while the
/// bar keeps asking: the thread stops after a minute without a request.
mod sampler {
    use super::*;

    const EVERY: Duration = Duration::from_secs(1);
    const IDLE: Duration = Duration::from_secs(60);

    struct State {
        value: Option<u8>,
        last_read: Option<Instant>,
        running: bool,
    }

    static STATE: Mutex<State> = Mutex::new(State {
        value: None,
        last_read: None,
        running: false,
    });

    pub fn read() -> Option<u8> {
        let mut s = STATE.lock().unwrap();
        s.last_read = Some(Instant::now());
        if !s.running {
            s.value = None;
            s.running = std::thread::Builder::new()
                .name("cpu-sampler".into())
                .spawn(run)
                .is_ok();
        }
        s.value
    }

    fn run() {
        // Created on this thread: the Windows probe holds PDH handles.
        let mut probe = imp::CpuProbe::new();
        loop {
            std::thread::sleep(EVERY);
            let v = probe.as_mut().and_then(|p| p.sample());
            let mut s = STATE.lock().unwrap();
            if s.last_read.is_none_or(|t| t.elapsed() > IDLE) {
                s.running = false;
                s.value = None;
                return;
            }
            if v.is_some() {
                s.value = v;
            }
        }
    }
}

/// CPU load through sysinfo. On macOS this is the same number the official
/// app reads (`host_statistics` CPU ticks, user + system + nice over total).
#[cfg(not(windows))]
mod sysinfo_cpu {
    pub struct CpuProbe(sysinfo::System);

    impl CpuProbe {
        pub fn new() -> Option<Self> {
            let mut s = sysinfo::System::new().ok()?;
            s.refresh_cpu_usage();
            Some(Self(s))
        }

        pub fn sample(&mut self) -> Option<u8> {
            self.0.refresh_cpu_usage();
            let v = self.0.global_cpu_usage();
            v.is_finite().then(|| v.clamp(0.0, 100.0).round() as u8)
        }
    }
}

/// Used and total bytes of the volume mounted at `/` (macOS: the official app
/// asks for the total and "available for important usage" capacity of `/`,
/// which is what sysinfo reports as available there).
#[cfg(not(windows))]
fn root_volume() -> Option<u8> {
    let disks = sysinfo::Disks::new_with_refreshed_list_specifics(
        sysinfo::DiskRefreshKind::nothing().with_storage(),
    )
    .ok()?;
    let root = disks
        .iter()
        .find(|d| d.mount_point() == std::path::Path::new("/"))?;
    let total = root.total_space();
    percent(total.saturating_sub(root.available_space()) as f64, total as f64)
}

/// Sums sysinfo's per-interface counters over the interfaces `keep` accepts.
#[cfg(not(windows))]
fn sum_interfaces(keep: impl Fn(&str) -> bool) -> Option<Network> {
    let nets = sysinfo::Networks::new_with_refreshed_list().ok()?;
    let mut out = Network {
        total_received: 0,
        total_sent: 0,
    };
    for (name, data) in nets.iter() {
        if keep(&name.to_string_lossy()) {
            out.total_received = out.total_received.saturating_add(data.total_received());
            out.total_sent = out.total_sent.saturating_add(data.total_transmitted());
        }
    }
    Some(out)
}

/// The official macOS app sums every interface that's up, except loopback and
/// `utun*` (VPN tunnels, which would count VPN traffic twice).
#[cfg(any(target_os = "macos", test))]
fn mac_counts_interface(name: &str) -> bool {
    !name.starts_with("lo") && !name.starts_with("utun")
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Network, percent};
    pub use super::sysinfo_cpu::CpuProbe;

    /// The official app's formula: (active + wired + compressed pages) ×
    /// page size over `hw.memsize`. (sysinfo counts app memory instead of
    /// active pages, which gives a different number.)
    #[allow(deprecated)] // libc suggests the mach2 crate for mach_host_self
    pub fn memory() -> Option<u8> {
        use std::sync::OnceLock;
        static HOST: OnceLock<libc::mach_port_t> = OnceLock::new();
        unsafe {
            let mut total: u64 = 0;
            let mut len = std::mem::size_of::<u64>();
            let rc = libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&raw mut total).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            );
            if rc != 0 || total == 0 {
                return None;
            }
            let host = *HOST.get_or_init(|| libc::mach_host_self());
            let mut stat: libc::vm_statistics64 = std::mem::zeroed();
            let mut count = libc::HOST_VM_INFO64_COUNT;
            let rc = libc::host_statistics64(
                host,
                libc::HOST_VM_INFO64,
                (&raw mut stat).cast(),
                &mut count,
            );
            if rc != libc::KERN_SUCCESS {
                return None;
            }
            let page = libc::sysconf(libc::_SC_PAGESIZE);
            if page <= 0 {
                return None;
            }
            let pages = u64::from(stat.active_count)
                + u64::from(stat.wire_count)
                + u64::from(stat.compressor_page_count);
            percent((pages * page as u64) as f64, total as f64)
        }
    }

    pub fn storage() -> Option<u8> {
        super::root_volume()
    }

    pub fn network() -> Option<Network> {
        super::sum_interfaces(super::mac_counts_interface)
    }
}

#[cfg(windows)]
mod imp {
    use super::{Network, percent};
    use windows::Win32::NetworkManagement::IpHelper::{GetBestInterface, GetIfEntry2, MIB_IF_ROW2};
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetLogicalDrives};
    use windows::Win32::System::Diagnostics::Debug::{SEM_FAILCRITICALERRORS, SetThreadErrorMode};
    use windows::Win32::System::Performance::{
        PDH_FMT_COUNTERVALUE, PDH_FMT_LONG, PDH_HCOUNTER, PDH_HQUERY, PdhAddEnglishCounterW,
        PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue, PdhOpenQueryW,
    };
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::core::{HSTRING, PCWSTR, w};

    /// The official app's PDH counter. It adds it by its localized name,
    /// which fails on non-English Windows; this uses the English name.
    /// "% Processor Time" is the fallback for Windows versions without
    /// "% Processor Utility".
    pub struct CpuProbe {
        query: PDH_HQUERY,
        counter: PDH_HCOUNTER,
    }

    impl CpuProbe {
        pub fn new() -> Option<Self> {
            unsafe {
                let mut query = PDH_HQUERY::default();
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                    return None;
                }
                let mut counter = PDH_HCOUNTER::default();
                let added = [
                    w!("\\Processor Information(_Total)\\% Processor Utility"),
                    w!("\\Processor(_Total)\\% Processor Time"),
                ]
                .into_iter()
                .any(|path| PdhAddEnglishCounterW(query, path, 0, &mut counter) == 0);
                if !added {
                    PdhCloseQuery(query);
                    return None;
                }
                // Rate counters need a first sample to compare against.
                PdhCollectQueryData(query);
                Some(Self { query, counter })
            }
        }

        pub fn sample(&mut self) -> Option<u8> {
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }
                let mut v = PDH_FMT_COUNTERVALUE::default();
                if PdhGetFormattedCounterValue(self.counter, PDH_FMT_LONG, None, &mut v) != 0 {
                    return None;
                }
                Some(v.Anonymous.longValue.clamp(0, 100) as u8)
            }
        }
    }

    impl Drop for CpuProbe {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }

    /// Physical memory in use: (total − available) / total, as the official app.
    pub fn memory() -> Option<u8> {
        let mut m = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        unsafe { GlobalMemoryStatusEx(&mut m) }.ok()?;
        percent(
            m.ullTotalPhys.saturating_sub(m.ullAvailPhys) as f64,
            m.ullTotalPhys as f64,
        )
    }

    /// Like the official app: every drive letter with a readable size
    /// (including removable and network drives), used and total summed.
    pub fn storage() -> Option<u8> {
        // Don't let an empty card reader pop up "There is no disk in the drive".
        let _ = unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, None) };
        let drives = unsafe { GetLogicalDrives() };
        let (mut total, mut free) = (0u64, 0u64);
        for i in 0..26u8 {
            if drives & (1 << i) == 0 {
                continue;
            }
            let root = HSTRING::from(format!("{}:\\", (b'A' + i) as char));
            let (mut t, mut f) = (0u64, 0u64);
            if unsafe { GetDiskFreeSpaceExW(&root, None, Some(&mut t), Some(&mut f)) }.is_ok() {
                total = total.saturating_add(t);
                free = free.saturating_add(f);
            }
        }
        percent(total.saturating_sub(free) as f64, total as f64)
    }

    /// Like the official app: only the interface Windows would use to reach
    /// 8.8.8.8. (The official app picks it once at startup; this picks it on
    /// every request, so switching from Wi-Fi to Ethernet is noticed.)
    pub fn network() -> Option<Network> {
        let mut index = 0u32;
        if unsafe { GetBestInterface(u32::from_ne_bytes([8, 8, 8, 8]), &mut index) } != 0 {
            return None;
        }
        let mut row = MIB_IF_ROW2 {
            InterfaceIndex: index,
            ..Default::default()
        };
        unsafe { GetIfEntry2(&mut row) }.ok().ok()?;
        Some(Network {
            total_received: row.InOctets,
            total_sent: row.OutOctets,
        })
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    //! Linux, for development. The official app has no Linux build.
    use super::{Network, percent};
    pub use super::sysinfo_cpu::CpuProbe;

    pub fn memory() -> Option<u8> {
        let mut s = sysinfo::System::new().ok()?;
        s.refresh_memory();
        percent(s.used_memory() as f64, s.total_memory() as f64)
    }

    pub fn storage() -> Option<u8> {
        super::root_volume()
    }

    /// Physical interfaces only (those with a device behind them), so
    /// loopback, bridges and container interfaces don't count traffic twice.
    pub fn network() -> Option<Network> {
        super::sum_interfaces(|name| {
            std::path::Path::new("/sys/class/net")
                .join(name)
                .join("device")
                .exists()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_rounds_and_clamps() {
        assert_eq!(percent(1.0, 3.0), Some(33));
        assert_eq!(percent(2.0, 3.0), Some(67));
        assert_eq!(percent(5.0, 4.0), Some(100));
        assert_eq!(percent(-1.0, 4.0), Some(0));
        assert_eq!(percent(1.0, 0.0), None);
        assert_eq!(percent(f64::NAN, 1.0), None);
    }

    #[test]
    fn mac_interfaces_skip_loopback_and_tunnels() {
        assert!(mac_counts_interface("en0"));
        assert!(mac_counts_interface("en5"));
        assert!(!mac_counts_interface("lo0"));
        assert!(!mac_counts_interface("utun3"));
    }

    #[test]
    fn network_reply_uses_the_bars_keys() {
        let n = Network {
            total_received: 5,
            total_sent: 7,
        };
        assert_eq!(
            serde_json::to_value(n).unwrap(),
            serde_json::json!({"totalReceived": 5, "totalSent": 7})
        );
    }

    /// Reads this computer's real numbers (Linux here).
    #[tokio::test]
    async fn reads_this_computer() {
        assert!(memory().await.is_some_and(|v| v <= 100));
        assert!(storage().await.is_some_and(|v| v <= 100));
        assert!(network().await.is_some());
        assert_eq!(cpu(), None, "no sample before the sampler has run");
        tokio::time::sleep(Duration::from_millis(2300)).await;
        assert!(cpu().is_some_and(|v| v <= 100));
    }
}
