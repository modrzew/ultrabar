// Add-on modules: what each kind looks like and which keys it has.
import { Boxes, Circle, Cpu, Dices, Gauge, Radar, type LucideIcon } from "lucide-react";
import type { Doc, KnobTarget, ModuleEndpoint, ModulePlacement } from "./model";

export const PRODUCTS: Record<string, { name: string; icon: LucideIcon }> = {
  DOT_KEY: { name: "Dot Key", icon: Circle },
  KNOB_KEY: { name: "Knob", icon: Gauge },
  VIVO_CUBE: { name: "Vivo Cube", icon: Dices },
  SENSE_CUBE: { name: "Sense Cube", icon: Radar },
  PC_POWER_CARD: { name: "PC Power Card", icon: Cpu },
  EXT_SCREEN: { name: "Extension Screen", icon: Boxes },
};

const NUMERIC: Record<number, string> = {
  0x10000000: "EXT_SCREEN", 0x10000001: "DOT_KEY", 0x10000002: "KNOB_KEY", 0x10000003: "VIVO_CUBE", 0x10000004: "SENSE_CUBE", 0x10000005: "PC_POWER_CARD",
};

/** Discovery reports product ids as numbers; the bar's config uses names. */
export function productKey(p: unknown): string {
  if (typeof p === "number") return NUMERIC[p] ?? String(p);
  return String(p ?? "");
}

/** Modules whose keys this app can set up. */
export function canSetUp(productId: string) {
  return productId === "DOT_KEY" || productId === "KNOB_KEY";
}

/** The Dot Key's three keys and the codes the bar receives, as the official
 * app draws them: two round keys on the left, a tall one on the right. */
export const DOT_KEYS = [
  { code: "2", label: "Top key" },
  { code: "1", label: "Bottom key" },
  { code: "0", label: "Tall key" },
] as const;

/** The Knob's press is key code 0. */
export const KNOB_BUTTON = "0";

const TARGET_NAMES: Record<string, string> = {
  "pc:volume": "Computer volume",
  "pc:bright": "Computer brightness",
  "local:volume": "Bar volume",
  "local:bright": "Bar brightness",
};

export function knobTargetName(t: Pick<KnobTarget, "id" | "name">) {
  return TARGET_NAMES[t.id] ?? t.name;
}

/** Offline fallback for the knob catalog (act 1617); Home Assistant devices
 * need the bar. */
export const OFFLINE_KNOB_TARGETS: KnobTarget[] = [
  { id: "pc:volume", type: "PC_VOLUME", name: "Computer volume" },
  { id: "pc:bright", type: "PC_BRIGHT", name: "Computer brightness" },
  { id: "local:volume", type: "LOCAL_VOLUME", name: "Bar volume" },
  { id: "local:bright", type: "LOCAL_BRIGHT", name: "Bar brightness" },
];

/** Modules on each side of the bar, nearest first. Unplaced ones go right. */
export function placedModules(doc: Doc): { left: ModuleEndpoint[]; right: ModuleEndpoint[] } {
  const place = (m: ModuleEndpoint, i: number): ModulePlacement => doc.modulePlacement?.[m.serialNumber] ?? { side: "right", order: 1000 + i };
  const withPlace = doc.modules.map((m, i) => ({ m, p: place(m, i) }));
  const side = (s: "left" | "right") => withPlace.filter((x) => x.p.side === s).sort((a, b) => a.p.order - b.p.order).map((x) => x.m);
  return { left: side("left"), right: side("right") };
}

/** Placement after moving a module one step along its side, or to the other side. */
export function movedPlacements(doc: Doc, serial: string, move: "closer" | "further" | "left" | "right"): Record<string, ModulePlacement> {
  const { left, right } = placedModules(doc);
  const lists = { left: [...left], right: [...right] };
  const from: "left" | "right" = lists.left.some((m) => m.serialNumber === serial) ? "left" : "right";
  const i = lists[from].findIndex((m) => m.serialNumber === serial);
  if (i < 0) return doc.modulePlacement ?? {};
  const [m] = lists[from].splice(i, 1);
  if (move === "left" || move === "right") {
    lists[move].unshift(m); // next to the bar
  } else {
    const j = Math.max(0, Math.min(lists[from].length, move === "closer" ? i - 1 : i + 1));
    lists[from].splice(j, 0, m);
  }
  const out: Record<string, ModulePlacement> = { ...doc.modulePlacement };
  for (const s of ["left", "right"] as const) lists[s].forEach((x, order) => { out[x.serialNumber] = { side: s, order }; });
  return out;
}
