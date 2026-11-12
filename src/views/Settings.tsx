import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { CheckCircle2, Download, Laptop, ShieldCheck, Upload, XCircle } from "lucide-react";
import { useApp } from "../lib/store";
import { api, errorMessage, isTauri } from "../lib/api";
import type { Doc } from "../lib/model";
import { Button, ToggleRow } from "../components/ui";
import { statusText } from "../components/ConnectSheet";

function describe(payload: unknown): string {
  const p = payload as { action?: string; params?: Record<string, string> } | null;
  if (!p?.action) return "Unknown request";
  const v = p.params?.url ?? p.params?.path ?? p.params?.cmd ?? p.params?.text ?? "";
  const verb: Record<string, string> = { openBrowser: "Open", startApp: "Open app", openFile: "Open", execCmd: "Run", inputText: "Type" };
  return `${verb[p.action] ?? p.action} ${v}`;
}

export function SettingsView() {
  const info = useApp((s) => s.info);
  const status = useApp((s) => s.status);
  const log = useApp((s) => s.pcLog);
  const s = useApp.getState();
  const [agent, setAgent] = useState(info?.pcAgentEnabled ?? true);
  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    if (isTauri) autostartEnabled().then(setAutostart).catch(() => setAutostart(null));
  }, []);

  const toggleAgent = async (v: boolean) => {
    setAgent(v);
    await api.setPcAgentEnabled(v);
    useApp.setState({ info: info ? { ...info, pcAgentEnabled: v } : info });
  };

  const toggleAutostart = async (v: boolean) => {
    try {
      if (v) await enableAutostart();
      else await disableAutostart();
      setAutostart(v);
    } catch (e) {
      s.toast({ kind: "error", title: "Couldn't change login item", body: errorMessage(e) });
    }
  };

  const exportLayout = async () => {
    const path = await saveDialog({ defaultPath: "UltraBar layout.json", filters: [{ name: "Layout", extensions: ["json"] }] });
    if (!path) return;
    try {
      await invoke("write_json_file", { path, value: useApp.getState().doc });
      s.toast({ kind: "success", title: "Layout exported" });
    } catch (e) {
      s.toast({ kind: "error", title: "Export failed", body: errorMessage(e) });
    }
  };

  const importLayout = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "Layout", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const doc = await invoke<Doc>("read_json_file", { path });
      if (!doc || !Array.isArray(doc.profiles)) throw new Error("That file isn't an UltraBar layout.");
      s.update((d) => {
        d.profiles = doc.profiles;
        d.automations = doc.automations ?? [];
        d.integrations = { ...d.integrations, ...doc.integrations };
        d.modules = doc.modules ?? [];
        d.modulesManaged = !!doc.modulesManaged;
      });
      s.setView({ kind: "profile", id: useApp.getState().doc.profiles[0].id });
      s.toast({ kind: "success", title: "Layout imported", body: "Deploy to send it to your bar. ⌘Z undoes the import." });
    } catch (e) {
      s.toast({ kind: "error", title: "Import failed", body: errorMessage(e) });
    }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head"><div className="grow"><h1>Settings</h1></div></div>

        <section>
          <h3 className="section-title"><Laptop size={14} /> This computer</h3>
          <div className="group">
            <div className="group-row">
              <div className="grow">
                <ToggleRow
                  title="Let the bar control this computer"
                  sub="Computer-action cards open apps, links and files, run commands and type text here."
                  checked={agent} onChange={(v) => void toggleAgent(v)} />
              </div>
            </div>
            <div className="group-row">
              <span className="ico"><ShieldCheck size={16} /></span>
              <div className="txt" style={{ whiteSpace: "normal" }}>
                <span style={{ whiteSpace: "normal" }}>
                  Only actions that are part of the layout you last deployed from this app will run. Anything else the bar asks for is blocked and shown below.
                  Keyboard shortcuts are typed by the bar over USB and don't need this.
                </span>
              </div>
            </div>
            {autostart !== null && (
              <div className="group-row">
                <div className="grow">
                  <ToggleRow title="Open at login" sub="Keeps computer actions and custom icons available." checked={autostart} onChange={(v) => void toggleAutostart(v)} />
                </div>
              </div>
            )}
          </div>
        </section>

        <section>
          <h3 className="section-title">Recent requests from the bar</h3>
          <div className="group">
            {log.length === 0 ? (
              <div className="group-row faint" style={{ fontSize: 12.5 }}>Nothing yet. Tap a computer-action card on the bar to see it here.</div>
            ) : (
              <div className="log">
                {log.map((e, i) => (
                  <div key={i} className="log-row">
                    <span className="when">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    {e.ok ? <CheckCircle2 size={13} style={{ color: "var(--success)" }} /> : <XCircle size={13} style={{ color: "var(--danger)" }} />}
                    <span className="grow truncate">{describe(e.payload)}</span>
                    {!e.ok && <span className="faint truncate" style={{ maxWidth: 260 }}>{e.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section>
          <h3 className="section-title">Bar</h3>
          <div className="group">
            <div className="group-row">
              <div className="txt"><b>{status.bar?.name ?? "No bar connected"}</b><span>{statusText(status)}</span></div>
              <Button size="sm" onClick={() => s.setConnectOpen(true)}>{status.bar ? "Manage" : "Connect"}</Button>
            </div>
          </div>
        </section>

        <section>
          <h3 className="section-title">Layout file</h3>
          <div className="group">
            <div className="group-row">
              <div className="txt"><span style={{ whiteSpace: "normal" }}>Save your profiles, automations and settings to a file, or load them on another computer.</span></div>
              <Button size="sm" onClick={() => void importLayout()} disabled={!isTauri}><Upload size={12} /> Import…</Button>
              <Button size="sm" onClick={() => void exportLayout()} disabled={!isTauri}><Download size={12} /> Export…</Button>
            </div>
          </div>
        </section>

        <p className="faint" style={{ fontSize: 12, margin: 0 }}>
          ultrabar {info?.version} · {info?.hostname}
        </p>
      </div>
    </div>
  );
}
