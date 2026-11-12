// Turns the layout document into the messages the bar expects.
import type { Action, Doc, Widget } from "./model";
import { hms, pcIsComplete, pcParam, pcPayload } from "./widgets";
import { zoneOffset } from "./timezones";

const LINE_BUDGET = 8000; // bar drops lines over 8192 bytes

/** Scene ids must start with "sys.scene" for the bar to use the scene's
 * icon as the card's artwork. */
export function sceneId(w: Widget) {
  return `sys.scene.${w.uid}`;
}

export function deployId(w: Widget): string {
  switch (w.type) {
    case "SOUNDSCAPE": return w.soundscape?.id ?? w.uid;
    case "APPS": return w.app?.package ?? w.uid;
    case "SCENE": return sceneId(w);
    case "DEVICE": return w.device?.id ?? w.uid;
    default: return w.uid;
  }
}

/** Default app icon as the bar serves it to itself. */
export function barAppIconUrl(pkg: string, host = "127.0.0.1") {
  return `http://${host}:8080/widget/icon?id=${encodeURIComponent(pkg)}&type=application&scheme=30`;
}

/** Cards whose whole face is an image this app draws (color + symbol). */
export function hasCardArt(w: Widget) {
  return w.type === "PC_CONTROL" || w.type === "SCENE" || w.type === "HOT_KEY_GROUP";
}

/** Card types the bar no longer has (firmware 1.0.9 shows them as "Not available"). */
export function isRetired(w: Widget) {
  return w.type === "SET";
}

/** `buttonIcons[i]` is the icon URL of shortcut-group button `i`. */
export function widgetPayload(w: Widget, iconUrl?: string, buttonIcons: (string | undefined)[] = []): Record<string, unknown> {
  const p: Record<string, unknown> = { id: deployId(w), type: w.type, name: w.name, iconScale: w.iconScale };
  if (iconUrl) p.icon = iconUrl;
  // Card art already contains the symbol at the chosen size; let it fill the card.
  if (iconUrl && hasCardArt(w)) p.iconScale = 100;
  switch (w.type) {
    case "TIMER":
      p.param = { time: hms(w.timer?.seconds ?? 0) };
      break;
    case "WORLD_TIME":
      p.param = { offset: zoneOffset(w.worldTime?.zone ?? "UTC") };
      break;
    case "WEATHER":
      p.param = { lat: w.weather?.lat ?? "", lon: w.weather?.lon ?? "" };
      break;
    case "SOUNDSCAPE":
      p.param = { id: w.soundscape?.id };
      break;
    case "APPS":
      if (!iconUrl && w.app) p.icon = barAppIconUrl(w.app.package);
      break;
    case "PC_CONTROL":
      // Firmware 1.0.1 can't run these on tap (its click handler fails to
      // read the stored parameter); 1.0.9 can. 1.0.9 ignores bgColor, which
      // is why the color is part of the card art.
      if (w.pc) p.param = pcParam(w.pc);
      if (w.bgColor) p.bgColor = w.bgColor;
      break;
    case "SCENE":
      // Firmware 1.0.9 runs the card's own action list. Earlier firmware ran
      // the stored scene with the same id instead (still sent, see buildPlan).
      p.param = { type: "ACTION", actions: (w.actions ?? []).map(actionPayload) };
      break;
    case "DEVICE":
      if (w.device) p.type = w.device.deviceType;
      break;
    case "HOT_KEY_GROUP":
      // Tapping the card opens a page with these buttons in two rows. Kept
      // short: every profile has to fit in one 8 KB message. Without an
      // iconScale the bar draws button icons at 40%, as the official app does.
      p.param = {
        button: (w.group?.buttons ?? []).map((b, i) => {
          const btn: Record<string, unknown> = { id: `b${i + 1}`, type: "PC_CONTROL", name: b.name, spanSize: b.span };
          if (buttonIcons[i]) btn.icon = buttonIcons[i];
          btn.param = pcParam(b.pc);
          return btn;
        }),
      };
      break;
  }
  return p;
}

export function actionPayload(a: Action): Record<string, unknown> {
  if (a.type === "PC_CONTROL" && a.pc) {
    return { id: a.nodeId, name: a.name, type: "PC_CONTROL", values: [{ id: "1", value: pcParam(a.pc) }] };
  }
  const p: Record<string, unknown> = { id: a.nodeId, name: a.name, type: a.type, values: a.values };
  if (a.objectParams !== undefined && a.objectParams !== null) p.objectParams = a.objectParams;
  return p;
}

export interface Problem {
  where: string;
  message: string;
  profileId?: string;
  widgetUid?: string;
}

/** Things that would deploy but not work; shown before deploying.
 * `triggerTypes` (from the bar's catalog, when loaded) flags automations
 * whose trigger the bar doesn't offer any more. */
export function findProblems(doc: Doc, triggerTypes?: string[]): Problem[] {
  const out: Problem[] = [];
  for (const p of doc.profiles) {
    for (const w of p.widgets) {
      const where = `${p.name} › ${w.name}`;
      const at = { profileId: p.id, widgetUid: w.uid };
      if (isRetired(w)) out.push({ where, message: "The bar no longer has this card, so it's left out. Remove it", ...at });
      if (w.type === "PC_CONTROL" && !pcIsComplete(w.pc)) out.push({ where, message: "Action isn't set up yet", ...at });
      if (w.type === "SCENE" && !w.actions?.length) out.push({ where, message: "Has no actions", ...at });
      if (w.type === "HOT_KEY_GROUP" && !w.group?.buttons.length) out.push({ where, message: "Has no buttons", ...at });
      if (w.type === "WEATHER" && (!w.weather?.lat || !w.weather?.lon)) out.push({ where, message: "Needs a location", ...at });
      if (w.type === "SCENE") {
        for (const a of w.actions ?? []) {
          if (a.type === "PC_CONTROL" && !pcIsComplete(a.pc)) out.push({ where, message: `“${a.summary}” isn't set up yet`, ...at });
        }
      }
    }
  }
  if (doc.profiles.some((p) => p.widgets.some((w) => w.type === "WEATHER")) && !doc.integrations.weather.apiKey.trim()) {
    out.push({ where: "Weather", message: "Add an AccuWeather API key in Integrations so weather cards can load" });
  }
  for (const a of doc.automations) {
    if (a.enabled && !a.triggers.length) out.push({ where: `Automation “${a.name}”`, message: "Has no trigger" });
    if (a.enabled && !a.actions.length) out.push({ where: `Automation “${a.name}”`, message: "Has no actions" });
    if (a.enabled && triggerTypes?.length && a.triggers.some((t) => !triggerTypes.includes(t.type))) {
      out.push({ where: `Automation “${a.name}”`, message: "Uses a trigger your bar no longer offers, so it won't run" });
    }
  }
  return out;
}

export interface Plan {
  modules: unknown | null;
  profiles: Record<string, unknown>[];
  scenes: Record<string, unknown>[];
  appConfigs: { packageName: string; config: unknown }[];
  allowed: unknown[];
}

/** `iconUrl` serves a card's icon; `cardArtUrl` the full card face of
 * computer-action, multi-action and shortcut-group cards (see `hasCardArt`);
 * `pngUrl` any other image (shortcut-group buttons). */
export async function buildPlan(
  doc: Doc,
  iconUrl: (w: Widget) => Promise<string | undefined>,
  cardArtUrl: (w: Widget) => Promise<string | undefined>,
  pngUrl: (png: string) => Promise<string>,
): Promise<Plan> {
  const allowed: unknown[] = [];
  const allowPc = (pc: Widget["pc"]) => {
    if (pc && pc.action !== "hotkey" && pcIsComplete(pc)) allowed.push(pcPayload(pc));
  };
  const scenes: Record<string, unknown>[] = [];
  const profiles: Record<string, unknown>[] = [];

  for (const p of doc.profiles) {
    const widgets: Record<string, unknown>[] = [];
    for (const w of p.widgets) {
      if (isRetired(w)) continue;
      const url = hasCardArt(w) ? await cardArtUrl(w) : await iconUrl(w);
      const buttons = w.type === "HOT_KEY_GROUP" ? w.group?.buttons ?? [] : [];
      const buttonIcons = await Promise.all(buttons.map((b) => (b.icon ? pngUrl(b.icon) : undefined)));
      widgets.push(widgetPayload(w, url, buttonIcons));
      if (w.type === "PC_CONTROL") allowPc(w.pc);
      buttons.forEach((b) => allowPc(b.pc));
      if (w.type === "SCENE") {
        (w.actions ?? []).forEach((a) => allowPc(a.pc));
        // Firmware before 1.0.9 runs this stored scene when the card is
        // tapped; on any firmware, automations can run it too.
        scenes.push({
          id: sceneId(w), name: w.name, icon: url ?? "", enabled: true, show: true, type: "MANUAL",
          triggers: [], conditions: [], actions: (w.actions ?? []).map(actionPayload),
        });
      }
    }
    profiles.push({
      id: p.id, name: p.name, icon: "", iconScale: 60, isDefault: p.isDefault, default: p.isDefault,
      showName: p.showName, module: [], widget: widgets,
    });
  }

  for (const a of doc.automations) {
    a.actions.forEach((x) => allowPc(x.pc));
    scenes.push({
      id: a.id, name: a.name, icon: "", enabled: a.enabled, show: false, type: "AUTO",
      triggers: a.triggers.map((t) => ({ type: t.type, params: t.params })), conditions: [],
      actions: a.actions.map(actionPayload),
    });
  }

  const appConfigs: Plan["appConfigs"] = [];
  const { weather, homeAssistant } = doc.integrations;
  if (weather.apiKey.trim()) {
    appConfigs.push({ packageName: "com.ultrabar.weather", config: { apiKey: weather.apiKey.trim(), metric: weather.metric, language: "en" } });
  }
  if (homeAssistant.url.trim() && homeAssistant.token.trim()) {
    appConfigs.push({ packageName: "com.ultrabar.homeassistant", config: { url: homeAssistant.url.trim(), token: homeAssistant.token.trim() } });
  }

  const modules = doc.modulesManaged
    ? {
        canGateway: { endpoints: doc.modules.filter((m) => m.interfaceType !== "mesh").map(endpointPayload) },
        meshGateway: { endpoints: doc.modules.filter((m) => m.interfaceType === "mesh").map(endpointPayload) },
      }
    : null;

  return { modules, profiles, scenes, appConfigs, allowed };
}

function endpointPayload(m: Doc["modules"][number]) {
  return {
    interfaceType: m.interfaceType, uid: m.uid, name: m.name, serialNumber: m.serialNumber,
    productId: m.productId, netId: m.netId ?? 0, workMode: m.workMode ?? 0, extraConfig: m.extraConfig ?? {},
  };
}

export function lineSize(act: number, data: unknown) {
  return new TextEncoder().encode(JSON.stringify({ id: "99999", act, data }) + "\n").length;
}

export function fitsOneLine(act: number, data: unknown) {
  return lineSize(act, data) <= LINE_BUDGET;
}

/** Stable fingerprint of everything Deploy sends, to show unsent changes. */
export function docHash(doc: Doc): string {
  // Key order isn't stable across a save/load round trip, so sort it.
  const s = stableStringify([doc.profiles, doc.automations, doc.integrations, doc.modulesManaged ? doc.modules : null]);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
