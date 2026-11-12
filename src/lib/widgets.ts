import {
  AppWindow,
  Clock,
  CloudSun,
  Command,
  FileText,
  Globe,
  Globe2,
  Keyboard,
  Layers,
  Lightbulb,
  Settings2,
  TerminalSquare,
  Timer,
  Waves,
  Type,
  type LucideIcon,
} from "lucide-react";
import type { PcAction, PcControl, Widget, WidgetType } from "./model";
import { uid } from "./model";
import { hotkeyLabel } from "./hid";
import { zoneCity } from "./timezones";

export const SOUNDSCAPES = [
  { id: "sys.app.soundscape.1", name: "Moonlit Serenade", hue: 235 },
  { id: "sys.app.soundscape.2", name: "The Leviathan's Whisper", hue: 200 },
  { id: "sys.app.soundscape.3", name: "Hearth’s Lullaby", hue: 22 },
  { id: "sys.app.soundscape.4", name: "Dusktide", hue: 280 },
  { id: "sys.app.soundscape.5", name: "HissBubble", hue: 170 },
  { id: "sys.app.soundscape.6", name: "Sonata of Sunrise", hue: 38 },
  { id: "sys.app.soundscape.7", name: "Serenade of Droplets", hue: 190 },
];

export const PC_ACTIONS: Record<PcAction, { label: string; verb: string; icon: LucideIcon; glyph: string; color: string }> = {
  hotkey: { label: "Keyboard shortcut", verb: "Press", icon: Keyboard, glyph: "keyboard", color: "#5b67f8" },
  startApp: { label: "Open app", verb: "Open", icon: AppWindow, glyph: "app-window", color: "#2f9e6e" },
  openBrowser: { label: "Open website", verb: "Open", icon: Globe, glyph: "globe", color: "#2b7fd9" },
  openFile: { label: "Open file or folder", verb: "Open", icon: FileText, glyph: "folder", color: "#c98a1b" },
  execCmd: { label: "Run command", verb: "Run", icon: TerminalSquare, glyph: "terminal", color: "#3d3f46" },
  inputText: { label: "Type text", verb: "Type", icon: Type, glyph: "type", color: "#8a4fd8" },
};

export interface WidgetDef {
  label: string;
  description: string;
  icon: LucideIcon;
  /** Card width in bar units (one unit ≈ 260 px of the 1424 px screen). */
  units: number;
  /** Editor shows the icon/background controls. */
  iconCard?: boolean;
}

export const WIDGETS: Record<WidgetType, WidgetDef> = {
  TIME: { label: "Clock", description: "Date and time", icon: Clock, units: 2 },
  WORLD_TIME: { label: "World clock", description: "Time in another city", icon: Globe2, units: 1 },
  WEATHER: { label: "Weather", description: "Current conditions", icon: CloudSun, units: 1 },
  TIMER: { label: "Timer", description: "Countdown you start on the bar", icon: Timer, units: 1 },
  SOUNDSCAPE: { label: "Soundscape", description: "Ambient sound player", icon: Waves, units: 1 },
  APPS: { label: "App", description: "Launch an app on the bar", icon: AppWindow, units: 1 },
  PC_CONTROL: { label: "Computer action", description: "Control this computer", icon: Command, units: 1, iconCard: true },
  SCENE: { label: "Multi-action", description: "Run several actions in a row", icon: Layers, units: 1, iconCard: true },
  SET: { label: "Bar settings", description: "Brightness, sound, network", icon: Settings2, units: 1 },
  DEVICE: { label: "Device", description: "Smart home device", icon: Lightbulb, units: 1 },
};

export function widgetUnits(w: Widget) {
  return WIDGETS[w.type].units;
}

export function newWidget(type: WidgetType, init: Partial<Widget> = {}): Widget {
  const base: Widget = { uid: uid("w"), type, name: WIDGETS[type].label, iconScale: 60, ...init };
  switch (type) {
    case "TIMER":
      return { ...base, name: init.name ?? "Focus", timer: init.timer ?? { seconds: 25 * 60 } };
    case "WORLD_TIME": {
      const zone = init.worldTime?.zone ?? "Europe/London";
      return { ...base, name: init.name ?? zoneCity(zone), worldTime: { zone } };
    }
    case "WEATHER":
      return { ...base, weather: init.weather ?? { lat: "", lon: "" } };
    case "SOUNDSCAPE": {
      const s = SOUNDSCAPES.find((x) => x.id === init.soundscape?.id) ?? SOUNDSCAPES[0];
      return { ...base, name: s.name, soundscape: { id: s.id } };
    }
    case "SCENE":
      return { ...base, name: init.name ?? "Multi-action", actions: init.actions ?? [] };
    case "PC_CONTROL": {
      const pc: PcControl = init.pc ?? { action: "hotkey", keys: [] };
      return { ...base, name: init.name ?? PC_ACTIONS[pc.action].label, pc, bgColor: init.bgColor ?? "#24252b" };
    }
    default:
      return base;
  }
}

export function pcSummary(pc: PcControl): string {
  switch (pc.action) {
    case "hotkey":
      return pc.keys?.length ? hotkeyLabel(pc.keys) : "No shortcut recorded";
    case "openBrowser":
      return pc.url || "No URL";
    case "startApp":
    case "openFile":
      return pc.path ? pc.path.split(/[\\/]/).filter(Boolean).pop()! : "Nothing chosen";
    case "execCmd":
      return pc.cmd || "No command";
    case "inputText":
      return pc.text ? `“${pc.text}”` : "No text";
  }
}

/** Is the PC-control action complete enough to deploy? */
export function pcIsComplete(pc: PcControl | undefined): boolean {
  if (!pc) return false;
  switch (pc.action) {
    case "hotkey": return !!pc.keys?.length;
    case "openBrowser": return !!pc.url?.trim();
    case "startApp": case "openFile": return !!pc.path?.trim();
    case "execCmd": return !!pc.cmd?.trim();
    case "inputText": return !!pc.text;
  }
}

/** Payload the bar forwards to this computer (act 1000000 PC_CONTROL). */
export function pcPayload(pc: PcControl): unknown {
  switch (pc.action) {
    case "openBrowser": return { action: "openBrowser", params: { url: pc.url?.trim() ?? "" } };
    case "startApp": return { action: "startApp", params: { path: pc.path ?? "", launchMode: 0 } };
    case "openFile": return { action: "openFile", params: { path: pc.path ?? "" } };
    case "execCmd": return { action: "execCmd", params: { cmd: pc.cmd ?? "" } };
    case "inputText": return { action: "inputText", params: { text: pc.text ?? "" } };
    case "hotkey": return null;
  }
}

/** `param` for PC_CONTROL widgets/actions: HID keys are typed by the bar
 * itself (output 5); everything else is relayed to this computer (output 10). */
export function pcParam(pc: PcControl): unknown {
  if (pc.action === "hotkey") return { output: 5, keys: pc.keys ?? [] };
  return { output: 10, payload: pcPayload(pc) };
}

export function formatDuration(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function hms(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}
