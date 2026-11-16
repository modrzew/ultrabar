import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Info, Keyboard, Play, RefreshCw, RotateCcw } from "lucide-react";
import type { DiscordAction, DiscordOp, PcAction, PcControl } from "../../lib/model";
import { DISCORD_OPS, DISCORD_ORDER, PC_ACTIONS, pcIsComplete, pcPayload } from "../../lib/widgets";
import { hidFromCode, isMac, isModifier, keyLabel, sortKeys } from "../../lib/hid";
import { api, errorMessage, isTauri, type DiscordGuild, type DiscordSound } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Button, Field, Spinner } from "../ui";

const ORDER: PcAction[] = ["hotkey", "startApp", "openBrowser", "openFile", "execCmd", "inputText", "discord"];

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
        <select className="select" value={value.action} onChange={(e) => {
          const action = e.target.value as PcAction;
          onChange({ action, keys: action === "hotkey" ? [] : undefined, discord: action === "discord" ? { op: "toggleMute" } : undefined });
        }}>
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
        <Field label="Text to type" hint={isMac ? "macOS will ask to allow ultrabar under Accessibility the first time." : undefined}>
          <textarea className="textarea" rows={3} placeholder="Thanks, talk soon!" value={value.text ?? ""}
            onChange={(e) => onChange({ ...value, text: e.target.value }, "text")} />
        </Field>
      )}

      {value.action === "discord" && (
        <DiscordEditor value={value.discord ?? { op: "toggleMute" }} onChange={(discord) => onChange({ ...value, discord })} />
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

function DiscordEditor({ value, onChange }: { value: DiscordAction; onChange: (d: DiscordAction) => void }) {
  const status = useApp((s) => s.discord);
  const need = DISCORD_OPS[value.op].needs;
  const ready = !!status?.configured && !!status.signedIn;
  return (
    <>
      <Field label="Discord action">
        <select className="select" value={value.op} onChange={(e) => onChange({ op: e.target.value as DiscordOp })}>
          {DISCORD_ORDER.map((op) => <option key={op} value={op}>{DISCORD_OPS[op].label}</option>)}
        </select>
      </Field>
      {!ready && (
        <div className="callout warn">
          <Info size={14} />
          <div>
            Connect this computer to Discord first.{" "}
            <button className="link" onClick={() => useApp.getState().setView({ kind: "integrations" })}>Set it up in Integrations</button>
          </div>
        </div>
      )}
      {ready && need === "channel" && <ChannelPicker value={value} onChange={onChange} />}
      {ready && need === "sound" && <SoundPicker value={value} onChange={onChange} />}
      {need === "sound" && <p className="faint" style={{ margin: 0, fontSize: 12 }}>Plays in the voice channel you're in. Sounds from other servers need Nitro.</p>}
    </>
  );
}

function useDiscordList<T>(load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = () => {
    setLoading(true);
    setError(null);
    load().then(setItems).catch((e) => setError(errorMessage(e))).finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, []);
  return { items, error, loading, reload };
}

function ChannelPicker({ value, onChange }: { value: DiscordAction; onChange: (d: DiscordAction) => void }) {
  const { items, error, loading, reload } = useDiscordList<DiscordGuild>(api.discordVoiceChannels);
  const known = items?.some((g) => g.channels.some((c) => c.id === value.channelId));
  return (
    <Field label="Voice channel" error={error}
      aside={<Button variant="ghost" icon size="sm" title="Reload from Discord" onClick={reload} disabled={loading}>{loading ? <Spinner /> : <RefreshCw size={12} />}</Button>}>
      <select className="select" value={value.channelId ?? ""} disabled={!items}
        onChange={(e) => {
          const g = items?.find((x) => x.channels.some((c) => c.id === e.target.value));
          const c = g?.channels.find((x) => x.id === e.target.value);
          if (g && c) onChange({ ...value, guildId: g.id, channelId: c.id, label: `${c.name} (${g.name})` });
        }}>
        <option value="" disabled>{loading && !items ? "Loading…" : "Choose…"}</option>
        {value.channelId && !known && <option value={value.channelId}>{value.label ?? "Saved channel"}</option>}
        {items?.map((g) => (
          <optgroup key={g.id} label={g.name}>
            {g.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}

function SoundPicker({ value, onChange }: { value: DiscordAction; onChange: (d: DiscordAction) => void }) {
  const { items, error, loading, reload } = useDiscordList<DiscordSound>(api.discordSounds);
  const groups = new Map<string, DiscordSound[]>();
  for (const s of items ?? []) {
    const k = s.guildName || "Discord";
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const key = (s: { guildId?: string; soundId?: string }) => `${s.guildId ?? "0"}:${s.soundId ?? ""}`;
  const known = items?.some((s) => key(s) === key(value));
  return (
    <Field label="Sound" error={error}
      aside={<Button variant="ghost" icon size="sm" title="Reload from Discord" onClick={reload} disabled={loading}>{loading ? <Spinner /> : <RefreshCw size={12} />}</Button>}>
      <select className="select" value={value.soundId ? key(value) : ""} disabled={!items}
        onChange={(e) => {
          const s = items?.find((x) => key(x) === e.target.value);
          if (s) onChange({ ...value, guildId: s.guildId, soundId: s.soundId, label: `${s.emoji ? `${s.emoji} ` : ""}${s.name}` });
        }}>
        <option value="" disabled>{loading && !items ? "Loading…" : "Choose…"}</option>
        {value.soundId && !known && <option value={key(value)}>{value.label ?? "Saved sound"}</option>}
        {[...groups].map(([g, list]) => (
          <optgroup key={g} label={g}>
            {list.map((s) => <option key={key(s)} value={key(s)} disabled={!s.available}>{s.emoji ? `${s.emoji} ` : ""}{s.name}{s.available ? "" : " (not available)"}</option>)}
          </optgroup>
        ))}
      </select>
    </Field>
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
