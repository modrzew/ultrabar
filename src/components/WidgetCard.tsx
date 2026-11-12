import { useEffect, useState, type CSSProperties } from "react";
import { CloudSun, Layers, Lightbulb, Settings2 } from "lucide-react";
import type { Widget } from "../lib/model";
import { PC_ACTIONS, SOUNDSCAPES, WIDGETS, formatDuration, pcIsComplete } from "../lib/widgets";
import { timeIn, zoneCity } from "../lib/timezones";
import { barAppIconUrl } from "../lib/deploy";
import { useApp } from "../lib/store";

export function useNow(ms = 10_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function cardIssue(w: Widget): string | null {
  if (w.type === "SET") return "No longer available on the bar";
  if (w.type === "PC_CONTROL" && !pcIsComplete(w.pc)) return "Action isn't set up yet";
  if (w.type === "SCENE" && !w.actions?.length) return "Add at least one action";
  if (w.type === "WEATHER" && (!w.weather?.lat || !w.weather?.lon)) return "Choose a location";
  return null;
}

/** Visual approximation of how the bar renders each card. */
export function CardFace({ w }: { w: Widget }) {
  switch (w.type) {
    case "TIME": return <TimeFace />;
    case "WEATHER": return <WeatherFace />;
    case "WORLD_TIME": return <WorldFace w={w} />;
    case "TIMER": return <TimerFace w={w} />;
    case "SOUNDSCAPE": return <SoundFace w={w} />;
    case "APPS": return <AppFace w={w} />;
    case "PC_CONTROL":
    case "SCENE": return <IconFace w={w} />;
    case "SET":
      return (
        <div className="card-center c-set" style={{ background: "#1d1d20" }}>
          <Settings2 size="34%" strokeWidth={1.5} color="#d7d7dc" />
          <div className="card-label">Settings</div>
        </div>
      );
    case "DEVICE":
      return (
        <div className="card-center" style={{ background: "#1d1d20" }}>
          <Lightbulb size="34%" strokeWidth={1.5} color="#ffd27a" />
          <div className="card-label truncate">{w.name}</div>
        </div>
      );
  }
}

function TimeFace() {
  const now = useNow();
  const h = now.getHours() % 12 || 12;
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return (
    <div className="card-center c-time" style={{ position: "absolute" }}>
      <div className="art" />
      <div className="t">
        <div className="date">{date}</div>
        <div className="clock">{String(h).padStart(2, "0")}:{String(now.getMinutes()).padStart(2, "0")}</div>
      </div>
      <div className="ampm">{now.getHours() < 12 ? "AM" : "PM"}</div>
    </div>
  );
}

function WeatherFace() {
  return (
    <div className="c-weather" style={{ position: "absolute", inset: 0 }}>
      <div className="temp">--</div>
      <CloudSun className="cloud" size="38%" strokeWidth={1.6} fill="rgba(255,255,255,0.9)" />
      <div className="pill" style={{ top: "57%", width: "35%" }} />
      <div className="pill" style={{ top: "74%", width: "47%" }} />
    </div>
  );
}

function WorldFace({ w }: { w: Widget }) {
  const now = useNow(1000);
  const zone = w.worldTime?.zone ?? "UTC";
  const t = timeIn(zone, now);
  const hourA = ((t.h % 12) + t.m / 60) * 30;
  const minA = (t.m + t.s / 60) * 6;
  const secA = t.s * 6;
  const hand = (angle: number, len: number, width: number, color: string) => (
    <line x1="50" y1="50" x2={50 + len * Math.sin((angle * Math.PI) / 180)} y2={50 - len * Math.cos((angle * Math.PI) / 180)} stroke={color} strokeWidth={width} strokeLinecap="round" />
  );
  return (
    <div className="c-world" style={{ position: "absolute", inset: 0 }}>
      <svg viewBox="0 0 100 100" width="68%" style={{ position: "absolute", left: "16%", top: "8%", height: "auto", aspectRatio: "1" }}>
        <circle cx="50" cy="50" r="46" fill="#232327" stroke="#3a3a40" strokeWidth="1.2" />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          return <circle key={i} cx={50 + 39 * Math.sin(a)} cy={50 - 39 * Math.cos(a)} r={i % 3 === 0 ? 1.8 : 1} fill="#cfcfcf" />;
        })}
        {hand(hourA, 22, 3.4, "#e0e0e0")}
        {hand(minA, 32, 2.2, "#e0e0e0")}
        {hand(secA, 36, 1, "#515ff8")}
        <circle cx="50" cy="50" r="2.6" fill="#515ff8" />
      </svg>
      <div className="card-label truncate" style={{ bottom: "7%" }}>{w.name || zoneCity(zone)}</div>
    </div>
  );
}

function TimerFace({ w }: { w: Widget }) {
  const secs = w.timer?.seconds ?? 0;
  const mins = Math.round(secs / 60);
  return (
    <div className="card-center c-timer" style={{ position: "absolute" }}>
      <div style={{ textAlign: "center", position: "relative", padding: "0 calc(20px * var(--s))", minWidth: 0 }}>
        <div className="truncate" style={{ fontSize: "calc(24px * var(--s))", color: "rgba(255,255,255,0.85)", marginBottom: "calc(4px * var(--s))" }}>{w.name}</div>
        <div className="digits">{formatDuration(secs)}</div>
        <div style={{ fontSize: "calc(24px * var(--s))", color: "#5b67f8", marginTop: "calc(6px * var(--s))" }}>
          {secs >= 60 ? `${mins} Min` : `${secs} Sec`}
        </div>
      </div>
    </div>
  );
}

function SoundFace({ w }: { w: Widget }) {
  const s = SOUNDSCAPES.find((x) => x.id === w.soundscape?.id) ?? SOUNDSCAPES[0];
  const bars = [0.35, 0.7, 1, 0.55, 0.85, 0.45, 0.65];
  return (
    <div className="c-sound" style={{ position: "absolute", inset: 0, background: `linear-gradient(160deg, hsl(${s.hue} 55% 38%), hsl(${s.hue + 25} 60% 14%))` }}>
      <div className="waves">{bars.map((b, i) => <i key={i} style={{ height: `${b * 100}%`, opacity: 0.55 + b * 0.45 }} />)}</div>
      <div className="card-label truncate">{s.name}</div>
    </div>
  );
}

function AppFace({ w }: { w: Widget }) {
  const ip = useApp((s) => s.status.bar?.ip);
  const [broken, setBroken] = useState(false);
  const pkg = w.app?.package ?? "";
  return (
    <div className="card-center c-apps" style={{ position: "absolute" }}>
      {ip && !broken ? (
        <img src={barAppIconUrl(pkg, ip)} alt="" onError={() => setBroken(true)} style={{ marginTop: "-12%" }} />
      ) : (
        <div style={{ width: "46%", aspectRatio: 1, borderRadius: "22%", background: "#33333a", marginTop: "-12%" }} />
      )}
      <div className="card-label truncate">{w.name}</div>
    </div>
  );
}

function IconFace({ w }: { w: Widget }) {
  const Fallback = w.type === "SCENE" ? Layers : PC_ACTIONS[w.pc?.action ?? "hotkey"].icon;
  const src = w.icon ? (w.icon.kind === "url" ? w.icon.url : w.icon.png) : null;
  const size = `${Math.max(10, Math.min(100, w.iconScale))}%`;
  return (
    <div className="card-center" style={{ position: "absolute", background: w.bgColor ?? "#24252b" }}>
      {src ? (
        <img src={src} alt="" style={{ width: size, height: size, objectFit: "contain" }} draggable={false} />
      ) : (
        <Fallback size={size} strokeWidth={1.6} color="rgba(255,255,255,0.9)" />
      )}
      {/* The bar prints the name over the art: multi-actions at the top, computer actions at the bottom. */}
      {w.name && <div className={`card-label truncate${w.type === "SCENE" ? " top" : ""}`}>{w.name}</div>}
    </div>
  );
}

export function cardStyle(w: Widget): CSSProperties {
  return { "--u": WIDGETS[w.type].units } as CSSProperties;
}
