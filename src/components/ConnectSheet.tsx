import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw, Unplug, Wifi } from "lucide-react";
import { api, errorMessage, type BarStatus, type ConnState, type FoundBar } from "../lib/api";
import { useApp } from "../lib/store";
import { Button, Field, Modal, Spinner } from "./ui";

export function statusDot(s: ConnState) {
  return s === "online" ? "online" : s === "connecting" || s === "awaitingApproval" ? "connecting" : s === "offline" || s === "needsPairing" ? "offline" : "";
}

export function statusText(s: BarStatus) {
  switch (s.state) {
    case "idle": return "Click to connect";
    case "connecting": return "Connecting…";
    case "needsPairing": return "Needs pairing";
    case "awaitingApproval": return "Waiting for approval…";
    case "online": return `Online · ${s.bar?.ip ?? ""}`;
    case "offline": return "Offline · retrying";
  }
}

export function ConnectSheet() {
  const status = useApp((s) => s.status);
  const close = useCallback(() => useApp.getState().setConnectOpen(false), []);
  const [choosing, setChoosing] = useState(status.state === "idle");

  // Close shortly after pairing succeeds.
  const prev = useRef(status.state);
  useEffect(() => {
    if (status.state === "online" && prev.current !== "online" && prev.current !== "idle") {
      const t = setTimeout(close, 900);
      return () => clearTimeout(t);
    }
    prev.current = status.state;
  }, [status.state, close]);

  const showPicker = choosing || status.state === "idle";
  return (
    <Modal title={showPicker ? "Connect your UltraBar" : status.bar?.name ?? "UltraBar"} onClose={close}>
      {showPicker ? <Picker onPicked={() => setChoosing(false)} /> : <Connection status={status} onChange={() => setChoosing(true)} onClose={close} />}
    </Modal>
  );
}

function Picker({ onPicked }: { onPicked: () => void }) {
  const [bars, setBars] = useState<FoundBar[]>([]);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      setBars(await api.discover(2500));
    } finally {
      setScanning(false);
    }
  }, []);
  useEffect(() => void scan(), [scan]);

  const connect = async (bar: FoundBar) => {
    await api.connect(bar, true);
    onPicked();
  };

  const probe = async () => {
    const ip = manual.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      setManualError("Enter an IPv4 address like 192.168.1.50");
      return;
    }
    setProbing(true);
    setManualError(null);
    try {
      const found = (await api.discover(1500, [ip])).find((b) => b.ip === ip);
      if (found) await connect(found);
      else setManualError("No UltraBar answered at that address.");
    } catch (e) {
      setManualError(errorMessage(e));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="muted" style={{ margin: 0 }}>Make sure the bar is on and on the same network as this computer.</p>
      <div className="bar-list">
        {bars.map((b) => (
          <button key={b.serialNo} className="bar-row" onClick={() => void connect(b)}>
            <span className="mini-bar" />
            <span className="grow">
              <div style={{ fontWeight: 550 }}>{b.name || "UltraBar"}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                {b.ip} · {b.serialNo}{b.ver ? ` · v${b.ver}` : ""}
              </div>
            </span>
            <ChevronRight size={16} className="faint" />
          </button>
        ))}
        <div className="scan-line">
          {scanning ? <><Spinner /> Looking for bars on your network…</> : (
            <>
              <Wifi size={13} />
              {bars.length ? `Found ${bars.length} ${bars.length === 1 ? "bar" : "bars"}.` : "No bars found."}
              <button className="link" onClick={() => void scan()} style={{ marginLeft: 4 }}>Search again</button>
            </>
          )}
        </div>
      </div>
      <Field label="Or connect by IP address" error={manualError}>
        <div className="row">
          <input
            className="input" placeholder="192.168.1.50" value={manual} spellCheck={false}
            onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void probe()}
          />
          <Button onClick={() => void probe()} disabled={probing || !manual.trim()}>{probing ? <Spinner /> : "Connect"}</Button>
        </div>
      </Field>
    </div>
  );
}

function Connection({ status, onChange, onClose }: { status: BarStatus; onChange: () => void; onClose: () => void }) {
  const [left, setLeft] = useState(10);
  useEffect(() => {
    if (status.state !== "awaitingApproval") return;
    setLeft(10);
    const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, [status.state]);

  const forget = async () => {
    await api.forget();
    onChange();
  };

  if (status.state === "awaitingApproval" || status.state === "needsPairing") {
    const waiting = status.state === "awaitingApproval";
    return (
      <div className="pair-visual">
        <div className="pair-bar">
          <div className="scr">
            <div className="dlg">
              Allow this computer?
              <span className="ok">Approve</span>
            </div>
          </div>
        </div>
        <div>
          <h3>{waiting ? "Tap Approve on your bar" : "Pair this computer"}</h3>
          <p style={{ marginTop: 6 }}>
            {waiting
              ? "A request just appeared on the bar's screen. It closes by itself after about 10 seconds."
              : status.error ?? "The bar needs to approve this computer once. You'll have about 10 seconds to tap Approve on its screen."}
          </p>
        </div>
        {waiting ? (
          <div className="row countdown"><Spinner /> {left > 0 ? `${left}s left` : "Waiting for the bar…"}</div>
        ) : (
          <Button variant="primary" size="lg" onClick={() => void api.pair()}>Send pairing request</Button>
        )}
        <button className="link" onClick={onChange} style={{ fontSize: 12 }}>Use a different bar</button>
      </div>
    );
  }

  const b = status.bar!;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="group">
        <div className="group-row">
          <span className={`dot ${statusDot(status.state)}`} />
          <div className="txt">
            <b>{status.state === "online" ? "Connected" : status.state === "connecting" ? "Connecting…" : "Can't reach the bar"}</b>
            <span>{status.error ?? `${b.name ?? "UltraBar"} at ${b.ip}`}</span>
          </div>
          {status.state !== "online" && (
            <Button size="sm" onClick={() => void api.reconnect()}><RefreshCw size={13} /> Retry</Button>
          )}
        </div>
        <div className="group-row">
          <div className="txt">
            <span>Serial number</span>
          </div>
          <span className="mono muted">{b.serialNo}</span>
        </div>
        <div className="group-row">
          <div className="txt"><span>Address</span></div>
          <span className="mono muted">{b.ip}:{b.tcpPort}</span>
        </div>
        {b.ver && (
          <div className="group-row">
            <div className="txt"><span>Firmware</span></div>
            <span className="mono muted">{b.ver}</span>
          </div>
        )}
      </div>
      <div className="row">
        <Button variant="danger" onClick={() => void forget()}><Unplug size={14} /> Forget this bar</Button>
        <div className="grow" />
        <Button onClick={onChange}>Use a different bar</Button>
        <Button variant="primary" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}
