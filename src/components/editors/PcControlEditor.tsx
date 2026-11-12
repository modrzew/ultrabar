import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Keyboard, Play, RotateCcw } from "lucide-react";
import type { PcAction, PcControl } from "../../lib/model";
import { PC_ACTIONS, pcIsComplete, pcPayload } from "../../lib/widgets";
import { hidFromCode, isMac, isModifier, keyLabel, sortKeys } from "../../lib/hid";
import { api, errorMessage, isTauri } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Button, Field } from "../ui";

const ORDER: PcAction[] = ["hotkey", "startApp", "openBrowser", "openFile", "execCmd", "inputText"];

export function PcControlEditor({ value, onChange }: { value: PcControl; onChange: (pc: PcControl, coalesceKey?: string) => void }) {
  const [testing, setTesting] = useState(false);
  const toast = useApp((s) => s.toast);

  const test = async () => {
    setTesting(true);
    try {
      await api.testPcAction(pcPayload(value));
      toast({ kind: "success", title: "Ran on this computer" });
    } catch (e) {
      toast({ kind: "error", title: "Couldn't run it", body: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <Field label="Action">
        <select className="select" value={value.action} onChange={(e) => onChange({ action: e.target.value as PcAction, keys: e.target.value === "hotkey" ? [] : undefined })}>
          {ORDER.map((a) => <option key={a} value={a}>{PC_ACTIONS[a].label}</option>)}
        </select>
      </Field>

      {value.action === "hotkey" && (
        <Field label="Shortcut" hint="The bar types this as a USB keyboard, so it works when the bar is plugged into this computer.">
          <HotkeyRecorder keys={value.keys ?? []} onChange={(keys) => onChange({ ...value, keys })} />
        </Field>
      )}
      {value.action === "openBrowser" && (
        <Field label="Web address">
          <input className="input" placeholder="https://example.com" value={value.url ?? ""} spellCheck={false}
            onChange={(e) => onChange({ ...value, url: e.target.value }, "url")} />
        </Field>
      )}
      {value.action === "startApp" && (
        <Field label="Application">
          <PathPicker value={value.path} kind="app" onChange={(path) => onChange({ ...value, path }, "path")} />
        </Field>
      )}
      {value.action === "openFile" && (
        <Field label="File or folder">
          <PathPicker value={value.path} kind="any" onChange={(path) => onChange({ ...value, path }, "path")} />
        </Field>
      )}
      {value.action === "execCmd" && (
        <Field label="Command" hint={isMac ? "Runs with /bin/sh on this Mac." : "Runs in the system shell."}>
          <textarea className="textarea mono" rows={3} placeholder="open -a Calculator" value={value.cmd ?? ""} spellCheck={false}
            onChange={(e) => onChange({ ...value, cmd: e.target.value }, "cmd")} />
        </Field>
      )}
      {value.action === "inputText" && (
        <Field label="Text to type" hint={isMac ? "macOS will ask to allow UltraBar under Accessibility the first time." : undefined}>
          <textarea className="textarea" rows={3} placeholder="Thanks, talk soon!" value={value.text ?? ""}
            onChange={(e) => onChange({ ...value, text: e.target.value }, "text")} />
        </Field>
      )}

      {value.action !== "hotkey" && (
        <div>
          <Button size="sm" onClick={() => void test()} disabled={!pcIsComplete(value) || testing}>
            <Play size={12} /> Test on this computer
          </Button>
        </div>
      )}
    </div>
  );
}

function HotkeyRecorder({ keys, onChange }: { keys: number[]; onChange: (k: number[]) => void }) {
  const [recording, setRecording] = useState(false);
  const held = useRef<Set<number>>(new Set());
  const combo = useRef<number[]>([]);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape" && !held.current.size) {
        setRecording(false);
        return;
      }
      const hid = hidFromCode(e.code);
      if (hid === undefined) return;
      held.current.add(hid);
      combo.current = sortKeys([...new Set([...combo.current, hid])]).slice(0, 6);
      onChange(combo.current);
    };
    const up = (e: KeyboardEvent) => {
      e.preventDefault();
      const hid = hidFromCode(e.code);
      if (hid !== undefined) held.current.delete(hid);
      // Finish once everything is released and a non-modifier was pressed.
      if (!held.current.size && combo.current.some((k) => !isModifier(k))) setRecording(false);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [recording, onChange]);

  const start = () => {
    held.current.clear();
    combo.current = [];
    setRecording(true);
  };

  return (
    <div className="row">
      <button
        ref={ref} type="button" className="input"
        style={{ display: "flex", alignItems: "center", gap: 4, height: 36, cursor: "default", ...(recording ? { borderColor: "var(--accent)", boxShadow: "0 0 0 3px var(--accent-soft)" } : {}) }}
        onClick={start} onBlur={() => setRecording(false)}
      >
        {keys.length ? sortKeys(keys).map((k) => <span key={k} className="kbd">{keyLabel(k)}</span>)
          : <span className="faint">{recording ? "Press the keys…" : "Click to record"}</span>}
        {recording && keys.length > 0 && <span className="faint" style={{ marginLeft: "auto", fontSize: 11.5 }}>Release to finish</span>}
      </button>
      <Button icon onClick={recording ? () => setRecording(false) : start} title={recording ? "Stop" : "Record again"}>
        {recording ? <Keyboard size={14} /> : <RotateCcw size={14} />}
      </Button>
    </div>
  );
}

function PathPicker({ value, kind, onChange }: { value?: string; kind: "app" | "any"; onChange: (p: string) => void }) {
  const pick = async (directory: boolean) => {
    if (!isTauri) return;
    const res = await openDialog({
      directory,
      multiple: false,
      defaultPath: kind === "app" && isMac ? "/Applications" : undefined,
      filters: kind === "app" && isMac && !directory ? [{ name: "Applications", extensions: ["app"] }] : undefined,
    });
    if (typeof res === "string") onChange(res);
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <input className="input mono" placeholder={kind === "app" ? (isMac ? "/Applications/Safari.app" : "C:\\Program Files\\…") : "/Users/you/Documents"} value={value ?? ""}
        spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" onClick={() => void pick(false)}><FolderOpen size={12} /> {kind === "app" ? "Choose app…" : "Choose file…"}</Button>
        {kind === "any" && <Button size="sm" onClick={() => void pick(true)}><FolderOpen size={12} /> Choose folder…</Button>}
      </div>
    </div>
  );
}
