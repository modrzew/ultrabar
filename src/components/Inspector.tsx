import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Copy, Info, MapPin, Search, Trash2 } from "lucide-react";
import { findWidget, useApp } from "../lib/store";
import type { Widget } from "../lib/model";
import { PC_ACTIONS, SOUNDSCAPES, WIDGETS } from "../lib/widgets";
import { allZones, timeIn, zoneCity, zoneOffset, zoneRegion } from "../lib/timezones";
import { Button, Field, Spinner } from "./ui";
import { PcControlEditor } from "./editors/PcControlEditor";
import { IconEditor } from "./editors/IconEditor";
import { ActionList } from "./Actions";
import { glyphPng } from "../lib/icons";

export function Inspector({ uid }: { uid: string }) {
  const w = useApp((s) => findWidget(s.doc, uid)?.widget);
  const s = useApp.getState();
  if (!w) return null;
  const def = WIDGETS[w.type];
  const Icon = w.type === "PC_CONTROL" && w.pc ? PC_ACTIONS[w.pc.action].icon : def.icon;
  const title = w.type === "PC_CONTROL" && w.pc ? PC_ACTIONS[w.pc.action].label : def.label;
  const set = (mut: (w: Widget) => void, key?: string) => s.updateWidget(uid, mut, key);

  return (
    <>
      <div className="panel-head">
        <Button variant="ghost" icon size="sm" onClick={() => s.select(null)} aria-label="Back to library" title="Back to library (Esc)">
          <ArrowLeft size={15} />
        </Button>
        <h3><Icon size={14} className="faint" /> <span className="truncate">{title}</span></h3>
        <Button variant="ghost" icon size="sm" onClick={() => s.duplicateWidget(uid)} title="Duplicate (⌘D)"><Copy size={14} /></Button>
        <Button variant="ghost" icon size="sm" className="danger" onClick={() => s.removeWidget(uid)} title="Remove (⌫)"><Trash2 size={14} /></Button>
      </div>
      <div className="panel-body" key={uid}>
        <Body w={w} set={set} />
      </div>
    </>
  );
}

type Setter = (mut: (w: Widget) => void, coalesceKey?: string) => void;

function NameField({ w, set, label = "Name", hint }: { w: Widget; set: Setter; label?: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <input className="input" value={w.name} spellCheck={false} onChange={(e) => set((x) => { x.name = e.target.value; }, "name")} />
    </Field>
  );
}

/** Switching the action type also updates the name and symbol, unless the
 * user has customised them. */
function changePc(w: Widget, pc: NonNullable<Widget["pc"]>, set: Setter, key?: string) {
  const old = w.pc?.action;
  const switched = !!old && old !== pc.action;
  set((x) => {
    if (switched && x.name === PC_ACTIONS[old!].label) x.name = PC_ACTIONS[pc.action].label;
    x.pc = pc;
  }, switched ? undefined : key);
  if (switched && w.icon?.kind === "glyph" && w.icon.glyph === PC_ACTIONS[old!].glyph) {
    const glyph = PC_ACTIONS[pc.action].glyph;
    const color = w.icon.color;
    void glyphPng(glyph, color).then((png) =>
      useApp.getState().updateWidget(w.uid, (x) => { x.icon = { kind: "glyph", glyph, color, png }; }, undefined, true),
    );
  }
}

/** Bar firmware 1.0.1 fails to run these cards when they're tapped (a bug in
 * the bar's own click handlers); the same actions work from automations. */
function FirmwareNote() {
  const ver = useApp((s) => s.status.bar?.ver ?? "");
  if (!ver.startsWith("1.0.1")) return null;
  return (
    <div className="callout warn">
      <Info size={14} />
      <div>
        Bar firmware {ver.replace(/\(.*\)$/, "")} has a bug that stops these cards from running when tapped. The same actions work in{" "}
        <button className="link" onClick={() => useApp.getState().setView({ kind: "automations" })}>automations</button>, and the cards should start working after a bar update.
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="callout"><Info size={14} /><div>{children}</div></div>;
}

function Body({ w, set }: { w: Widget; set: Setter }) {
  switch (w.type) {
    case "TIME":
      return <Note>Shows the date and time in the bar's time zone. Nothing to set up.</Note>;
    case "SET":
      return <Note>Opens the bar's own settings (brightness, sound, Wi‑Fi) when tapped.</Note>;
    case "WORLD_TIME":
      return (
        <div className="stack" style={{ gap: 16 }}>
          <ZonePicker w={w} set={set} />
          <NameField w={w} set={set} label="Label" hint="Shown under the clock face." />
          <Note>The bar keeps a fixed offset ({zoneOffset(w.worldTime?.zone ?? "UTC")}). After a daylight‑saving change, deploy again to update it.</Note>
        </div>
      );
    case "WEATHER":
      return <WeatherEditor w={w} set={set} />;
    case "TIMER":
      return <TimerEditor w={w} set={set} />;
    case "SOUNDSCAPE":
      return (
        <Field label="Sound">
          <div className="stack" style={{ gap: 4 }}>
            {SOUNDSCAPES.map((sc) => (
              <button
                key={sc.id} type="button" className="lib-item"
                style={sc.id === w.soundscape?.id ? { background: "var(--accent-soft)", borderColor: "var(--accent)" } : undefined}
                onClick={() => set((x) => { x.soundscape = { id: sc.id }; x.name = sc.name; })}
              >
                <span className="glyph" style={{ background: `linear-gradient(160deg, hsl(${sc.hue} 55% 42%), hsl(${sc.hue + 25} 60% 18%))` }} />
                <span className="txt"><b>{sc.name}</b></span>
              </button>
            ))}
          </div>
        </Field>
      );
    case "APPS":
      return <AppEditor w={w} set={set} />;
    case "PC_CONTROL":
      return (
        <div className="stack" style={{ gap: 0 }}>
          <div className="panel-section">
            <FirmwareNote />
            <NameField w={w} set={set} hint="For your reference; the bar shows the icon." />
            <PcControlEditor value={w.pc!} onChange={(pc, key) => changePc(w, pc, set, key)} />
          </div>
          <div className="panel-section">
            <h4>Appearance</h4>
            <IconEditor w={w} set={set} />
          </div>
        </div>
      );
    case "SCENE":
      return (
        <div className="stack" style={{ gap: 0 }}>
          <div className="panel-section">
            <FirmwareNote />
            <NameField w={w} set={set} />
            <Field label="Actions" hint="Run top to bottom when you tap the card.">
              <ActionList actions={w.actions ?? []} onChange={(actions) => set((x) => { x.actions = actions; })} />
            </Field>
          </div>
          <div className="panel-section">
            <h4>Appearance</h4>
            <IconEditor w={w} set={set} />
          </div>
        </div>
      );
    case "DEVICE":
      return (
        <div className="stack">
          <NameField w={w} set={set} />
          <Note>Controls this device from the bar. Devices come from the bar's smart-home connection.</Note>
        </div>
      );
  }
}

function ZonePicker({ w, set }: { w: Widget; set: Setter }) {
  const [q, setQ] = useState("");
  const zone = w.worldTime?.zone ?? "UTC";
  const zones = allZones();
  const now = new Date();
  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    return zones.filter((z) => z.toLowerCase().replace(/_/g, " ").includes(query)).slice(0, 8);
  }, [q, zones]);
  const t = timeIn(zone, now);
  const pick = (z: string) => {
    set((x) => {
      const autoName = !x.name || x.name === zoneCity(x.worldTime?.zone ?? "");
      x.worldTime = { zone: z };
      if (autoName) x.name = zoneCity(z);
    });
    setQ("");
  };
  return (
    <Field label="City">
      <div className="group">
        <div className="group-row">
          <div className="txt">
            <b>{zoneCity(zone)}</b>
            <span>{zoneRegion(zone) || "—"} · {zoneOffset(zone).replace("GMT", "UTC")}</span>
          </div>
          <span className="mono muted">{String(t.h).padStart(2, "0")}:{String(t.m).padStart(2, "0")}</span>
        </div>
      </div>
      <div className="input-affix" style={{ marginTop: 6 }}>
        <Search size={13} style={{ position: "absolute", left: 9, color: "var(--text-3)" }} />
        <input className="input" style={{ paddingLeft: 28 }} placeholder="Search cities" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
      </div>
      {results.length > 0 && (
        <div className="group" style={{ marginTop: 4 }}>
          {results.map((z) => {
            const tt = timeIn(z, now);
            return (
              <div key={z} className="group-row click" style={{ minHeight: 40, padding: "6px 12px" }} onClick={() => pick(z)}>
                <div className="txt"><b>{zoneCity(z)}</b><span>{zoneRegion(z)}</span></div>
                <span className="mono faint">{String(tt.h).padStart(2, "0")}:{String(tt.m).padStart(2, "0")}</span>
              </div>
            );
          })}
        </div>
      )}
    </Field>
  );
}

interface Place { name: string; admin1?: string; country?: string; latitude: number; longitude: number }

function WeatherEditor({ w, set }: { w: Widget; set: Setter }) {
  const hasKey = useApp((s) => !!s.doc.integrations.weather.apiKey.trim());
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=${encodeURIComponent(query)}`);
        const j = (await r.json()) as { results?: Place[] };
        setResults(j.results ?? []);
      } catch {
        setError("Couldn't search places. Enter coordinates instead.");
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [q]);

  const lat = w.weather?.lat ?? "";
  const lon = w.weather?.lon ?? "";
  return (
    <div className="stack" style={{ gap: 16 }}>
      {!hasKey && (
        <div className="callout warn">
          <Info size={14} />
          <div>Weather needs an AccuWeather API key. <button className="link" onClick={() => useApp.getState().setView({ kind: "integrations" })}>Add it in Integrations</button></div>
        </div>
      )}
      <Field label="Location" error={error}>
        {w.weather?.place && (
          <div className="group" style={{ marginBottom: 6 }}>
            <div className="group-row" style={{ minHeight: 44 }}>
              <MapPin size={14} className="faint" />
              <div className="txt"><b>{w.weather.place}</b><span>{Number(lat).toFixed(3)}, {Number(lon).toFixed(3)}</span></div>
            </div>
          </div>
        )}
        <div className="input-affix">
          <Search size={13} style={{ position: "absolute", left: 9, color: "var(--text-3)" }} />
          <input className="input" style={{ paddingLeft: 28 }} placeholder="Search for a city" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          {loading && <span className="suffix"><Spinner /></span>}
        </div>
        {results.length > 0 && (
          <div className="group" style={{ marginTop: 4 }}>
            {results.map((p, i) => (
              <div key={i} className="group-row click" style={{ minHeight: 40, padding: "6px 12px" }}
                onClick={() => {
                  set((x) => { x.weather = { lat: p.latitude.toFixed(4), lon: p.longitude.toFixed(4), place: p.name }; });
                  setQ("");
                }}>
                <div className="txt"><b>{p.name}</b><span>{[p.admin1, p.country].filter(Boolean).join(", ")}</span></div>
              </div>
            ))}
          </div>
        )}
      </Field>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Field label="Latitude">
          <input className="input mono" value={lat} placeholder="51.5072" onChange={(e) => set((x) => { x.weather = { lat: e.target.value, lon, place: undefined }; }, "lat")} />
        </Field>
        <Field label="Longitude">
          <input className="input mono" value={lon} placeholder="-0.1276" onChange={(e) => set((x) => { x.weather = { lat, lon: e.target.value, place: undefined }; }, "lon")} />
        </Field>
      </div>
    </div>
  );
}

const PRESETS = [60, 300, 600, 900, 1500, 2700, 3600];

function TimerEditor({ w, set }: { w: Widget; set: Setter }) {
  const total = w.timer?.seconds ?? 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const setPart = (nh: number, nm: number, ns: number) =>
    set((x) => { x.timer = { seconds: Math.max(1, Math.min(99 * 3600, nh * 3600 + nm * 60 + ns)) }; }, "time");
  const num = (v: string, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <NameField w={w} set={set} />
      <Field label="Duration">
        <div className="row" style={{ gap: 6 }}>
          {([["h", h, 99], ["min", m, 59], ["s", sec, 59]] as const).map(([unit, val, max], i) => (
            <div className="input-affix" key={unit} style={{ flex: 1 }}>
              <input
                className="input mono" inputMode="numeric" value={val}
                onChange={(e) => {
                  const n = num(e.target.value, max);
                  setPart(i === 0 ? n : h, i === 1 ? n : m, i === 2 ? n : sec);
                }}
              />
              <span className="suffix">{unit}</span>
            </div>
          ))}
        </div>
      </Field>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {PRESETS.map((p) => (
          <Button key={p} size="sm" variant={p === total ? "primary" : "default"} onClick={() => set((x) => { x.timer = { seconds: p }; })}>
            {p >= 3600 ? `${p / 3600} h` : `${p / 60} min`}
          </Button>
        ))}
      </div>
    </div>
  );
}

function AppEditor({ w, set }: { w: Widget; set: Setter }) {
  const apps = useApp((s) => s.catalog.apps);
  const known = apps.find((a) => a.application === w.app?.package);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <NameField w={w} set={set} />
      <Field label="App" hint={w.app?.package}>
        <select
          className="select" value={w.app?.package ?? ""}
          onChange={(e) => {
            const a = apps.find((x) => x.application === e.target.value);
            if (a) set((x) => { x.app = { package: a.application }; x.name = a.appName; });
          }}
        >
          {!known && <option value={w.app?.package ?? ""}>{w.name} (not on the bar)</option>}
          {apps.map((a) => <option key={a.application} value={a.application}>{a.appName}</option>)}
        </select>
      </Field>
    </div>
  );
}
