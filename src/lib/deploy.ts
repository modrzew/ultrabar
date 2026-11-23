// Turns the layout document into the messages the bar expects.
import type { Action, Doc, Gesture, KeyBinding, KeyEvent, ModuleSetup, Profile, Widget } from "./model";
import { hms, isSystemCard, pcIsComplete, pcParam, pcPayload } from "./widgets";
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

/** A Home Assistant scene: a `SCENE` card that runs the entity. */
export function isHaScene(w: Widget) {
  return w.type === "DEVICE" && w.device?.deviceType === "SCENE";
}

/** Cards whose whole face is an image this app draws (color + symbol). Home
 * Assistant scene cards are drawn by the same holder as multi-actions, so
 * they get the same art once they have an icon. */
export function hasCardArt(w: Widget) {
  return w.type === "PC_CONTROL" || w.type === "SCENE" || w.type === "HOT_KEY_GROUP" || (isHaScene(w) && !!w.icon);
}

/** Images go to the bar in a zip (launcher 1.0.9+), unpacked into this
 * folder of its files directory. Its image loaders resolve `file://` paths
 * that don't exist as absolute paths against that directory. */
export const BAR_IMAGES = "file://ultrabar-app/image/";

export function barImageUrl(id: string) {
  return `${BAR_IMAGES}${id}.png`;
}

/** The same payload with every bar image loaded from `base` (this computer's
 * image server, `<base><id>.png`) instead: for firmware without the asset
 * upload, or when the upload failed. */
export function withImagesFrom<T>(v: T, base: string): T {
  if (typeof v === "string") return (v.startsWith(BAR_IMAGES) ? base + v.slice(BAR_IMAGES.length) : v) as T;
  if (Array.isArray(v)) return v.map((x) => withImagesFrom(x, base)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withImagesFrom(x, base)])) as T;
  }
  return v;
}

/** Card types the bar no longer has (firmware 1.0.9 shows them as "Not available"). */
export function isRetired(w: Widget) {
  return w.type === "SET";
}

/** Card types that need bar firmware 1.0.9 or later. Older launchers don't
 * know these types, so they're left out rather than risk the whole profile. */
export function needsNewerFirmware(w: Widget, legacyFirmware: boolean) {
  return legacyFirmware && isSystemCard(w);
}

/** What Deploy needs to know about the bar and this computer. */
export interface DeployContext {
  /** The bar runs firmware older than 1.0.9. */
  legacyFirmware?: boolean;
  /** "Let the bar control this computer" is on (system cards need it). */
  pcAgentEnabled?: boolean;
  /** Package names of the apps on the bar, when known. */
  barApps?: string[];
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
      // Both empty: the bar uses its network location (sent like the official app does).
      p.param = { lat: w.weather?.lat?.trim() ?? "", lon: w.weather?.lon?.trim() ?? "" };
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
      // Home Assistant scenes are SCENE cards that run the entity (the id),
      // with an optional icon and zoom.
      if (isHaScene(w)) p.param = { type: "HA_SCENE" };
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

/** A weather card with one coordinate but not the other. (Neither means the
 * bar's network location.) */
export function halfLocation(w: Widget) {
  return w.type === "WEATHER" && !w.weather?.lat?.trim() !== !w.weather?.lon?.trim();
}

export function actionPayload(a: Action): Record<string, unknown> {
  if (a.type === "PC_CONTROL" && a.pc) {
    return { id: a.nodeId, name: a.name, type: "PC_CONTROL", values: [{ id: "1", value: pcParam(a.pc) }] };
  }
  if (a.type === "APP_CAPABILITY" && a.capability) {
    return { id: a.nodeId, name: a.name, type: a.type, values: [{ id: "1", value: capabilityValue(a.capability) }] };
  }
  const p: Record<string, unknown> = { id: a.nodeId, name: a.name, type: a.type, values: a.values };
  if (a.objectParams !== undefined && a.objectParams !== null) p.objectParams = a.objectParams;
  return p;
}

/** An app action's value: `{actionId, packageName, params}` as a JSON
 * *string*. Launcher 1.0.9's AppCapabilityAction reads value "1" as a string
 * and parses it (an object fails there). Written like the official app's:
 * compact, keys sorted, params as strings. */
export function capabilityValue(c: NonNullable<Action["capability"]>): string {
  const params = Object.fromEntries(Object.entries(c.params).filter(([, v]) => v !== "").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify({ actionId: c.actionId, packageName: c.packageName, params });
}

/** The address the bar's Home Assistant app connects to. It appends
 * `api/websocket` to it as is, so it needs a scheme and a trailing slash. */
export function haUrl(raw: string): string {
  let u = raw.trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}/`;
  } catch {
    return u.endsWith("/") ? u : `${u}/`;
  }
}

export const KEY_EVENTS: { key: KeyEvent; field: string; label: string }[] = [
  { key: "click", field: "singleClick", label: "Click" },
  { key: "double", field: "doubleClick", label: "Double click" },
  { key: "long", field: "longPress", label: "Long press" },
];

/** A gesture that does something: switched on, with at least one action.
 * Others aren't sent (the official app leaves out switched-off ones too). */
export function gestureRuns(g: Gesture | undefined): g is Gesture {
  return !!g && g.enabled !== false && g.actions.length > 0;
}

/** Whether any gesture of a key does something. */
export function keyRuns(b: KeyBinding | undefined) {
  return !!b && KEY_EVENTS.some((e) => gestureRuns(b[e.key]));
}

/** Longest prompt text, as in the official app. The bar shows it on one
 * line and cuts it off with "…" where it doesn't fit. */
export const PROMPT_MAX = 64;

/** The prompt's text: what the user typed, or the first action's name (cut
 * at 40 characters, as earlier versions sent it). The official app uses
 * "<key>-<gesture>" ("Button1-Click") until text is typed. */
export function gestureName(g: Gesture): string {
  const text = g.prompt?.text?.trim();
  if (text) return text.slice(0, PROMPT_MAX);
  const a = g.actions[0];
  return a ? (a.summary || a.name).slice(0, 40) : "";
}

/** Whether the bar shows the prompt; layouts from before the switch did. */
export function promptShown(g: Gesture) {
  return g.prompt?.show ?? true;
}

/** Maps a prompt's background image (PNG data URL) to its URL on the bar. */
type ImageUrl = (png: string) => string | undefined;

/** A gesture as the scene the bar runs: `{name, show, icon?, actions}`. With
 * `show` the bar briefly shows the name over the image when it runs. */
function gesturePayload(g: Gesture, imageUrl?: ImageUrl): Record<string, unknown> {
  const out: Record<string, unknown> = { name: gestureName(g), show: promptShown(g) };
  const icon = promptShown(g) && g.prompt?.image ? imageUrl?.(g.prompt.image) : undefined;
  if (icon) out.icon = icon;
  out.actions = g.actions.map(actionPayload);
  return out;
}

/** `KeyCodeConfig`: a key code and a scene per gesture. */
function keyPayload(code: string, b: KeyBinding, imageUrl?: ImageUrl): Record<string, unknown> {
  const out: Record<string, unknown> = { keyCode: Number(code) };
  for (const e of KEY_EVENTS) {
    const g = b[e.key];
    if (gestureRuns(g)) out[e.field] = gesturePayload(g, imageUrl);
  }
  return out;
}

/** Every gesture of a module that runs. */
export function moduleGestures(m: ModuleSetup): Gesture[] {
  return Object.values(m.keys ?? {}).flatMap((b) => KEY_EVENTS.map((e) => b[e.key]).filter(gestureRuns));
}

/** A profile's `module` list: what each module's keys (and a knob's turns)
 * do. `imageUrl` gives prompt images their URL on the bar (see buildPlan);
 * without it they're left out. */
export function modulesPayload(p: Profile, imageUrl?: ImageUrl): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of p.modules ?? []) {
    const keys = Object.entries(m.keys ?? {}).filter(([, b]) => keyRuns(b));
    if (m.productId === "KNOB_KEY") {
      const config: Record<string, unknown> = {};
      const button = keys.find(([code]) => code === "0");
      if (button) config.button = keyPayload("0", button[1], imageUrl);
      if (m.knob?.right) config.clockwise = { id: m.knob.right.id, type: m.knob.right.type };
      if (m.knob?.left) config.counterclockwise = { id: m.knob.left.id, type: m.knob.left.type };
      if (Object.keys(config).length) out.push({ productId: m.productId, serialNo: m.serialNumber, config });
    } else if (keys.length) {
      out.push({ productId: m.productId, serialNo: m.serialNumber, config: keys.map(([code, b]) => keyPayload(code, b, imageUrl)) });
    }
  }
  return out;
}

/** Actions of the gestures that run (switched-off ones are skipped by
 * deploy checks and kept out of the computer's allowlist). */
export function moduleActions(m: ModuleSetup): Action[] {
  return moduleGestures(m).flatMap((g) => g.actions);
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
export function findProblems(doc: Doc, triggerTypes?: string[], ctx: DeployContext = {}): Problem[] {
  const out: Problem[] = [];
  let systemCards = false;
  const checkActions = (actions: Action[], where: string, at: Partial<Problem> = {}) => {
    for (const a of actions) {
      if (a.type === "PC_CONTROL" && !pcIsComplete(a.pc)) out.push({ where, message: `“${a.summary}” isn't set up yet`, ...at });
      const app = a.type === "APP_CAPABILITY" ? a.capability : undefined;
      if (app && ctx.barApps && !ctx.barApps.includes(app.packageName)) {
        out.push({ where, message: `“${a.summary}” needs ${app.appName}, which isn't on the bar, so it does nothing. Install it in Apps`, ...at });
      }
    }
  };
  for (const p of doc.profiles) {
    for (const w of p.widgets) {
      const where = `${p.name} › ${w.name}`;
      const at = { profileId: p.id, widgetUid: w.uid };
      if (isRetired(w)) out.push({ where, message: "The bar no longer has this card, so it's left out. Remove it", ...at });
      if (needsNewerFirmware(w, !!ctx.legacyFirmware)) {
        out.push({ where, message: "Needs bar firmware 1.0.9 or later, so it's left out. Update the bar", ...at });
      } else if (isSystemCard(w)) systemCards = true;
      if (w.type === "PC_CONTROL" && !pcIsComplete(w.pc)) out.push({ where, message: "Action isn't set up yet", ...at });
      if (w.type === "SCENE" && !w.actions?.length) out.push({ where, message: "Has no actions", ...at });
      if (w.type === "HOT_KEY_GROUP" && !w.group?.buttons.length) out.push({ where, message: "Has no buttons", ...at });
      if (w.type === "WEATHER" && halfLocation(w)) out.push({ where, message: "Has only a latitude or only a longitude. Fill in both, or clear both to use the bar's network location", ...at });
      if (w.type === "SCENE") checkActions(w.actions ?? [], where, at);
    }
  }
  for (const p of doc.profiles) {
    for (const m of p.modules ?? []) {
      const name = doc.modules.find((x) => x.serialNumber === m.serialNumber)?.name ?? "Module";
      checkActions(moduleActions(m), `${p.name} › ${name}`, { profileId: p.id });
    }
  }
  if (systemCards && ctx.pcAgentEnabled === false) {
    out.push({ where: "Settings", message: "CPU, memory, storage and network cards stay empty until you turn on “Let the bar control this computer”" });
  }
  if (doc.profiles.some((p) => p.widgets.some((w) => w.type === "WEATHER")) && !doc.integrations.weather.apiKey.trim()) {
    out.push({ where: "Weather", message: "Add an AccuWeather API key in Integrations so weather cards can load" });
  }
  for (const a of doc.automations) {
    if (a.enabled && !a.triggers.length) out.push({ where: `Automation “${a.name}”`, message: "Has no trigger" });
    if (a.enabled && !a.actions.length) out.push({ where: `Automation “${a.name}”`, message: "Has no actions" });
    if (a.enabled) checkActions(a.actions, `Automation “${a.name}”`);
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
 * computer-action, multi-action, shortcut-group and Home Assistant scene
 * cards (see `hasCardArt`); `pngUrl` any other image (shortcut-group
 * buttons, profile pictures, gesture prompts). */
export async function buildPlan(
  doc: Doc,
  iconUrl: (w: Widget) => Promise<string | undefined>,
  cardArtUrl: (w: Widget) => Promise<string | undefined>,
  pngUrl: (png: string) => Promise<string>,
  ctx: DeployContext = {},
): Promise<Plan> {
  const allowed: unknown[] = [];
  const allowPc = (pc: Widget["pc"]) => {
    if (!pc || pc.action === "hotkey" || !pcIsComplete(pc)) return;
    const payload = pcPayload(pc) as Record<string, unknown>;
    // Earlier versions of this app sent launchMode 0 for every app and meant
    // "open it"; this marks the deploys where 0 really means a new copy
    // (only kept on this computer, see pc_agent.rs).
    allowed.push(pc.action === "startApp" && pc.launchMode === "new" ? { ...payload, newInstance: true } : payload);
  };
  const scenes: Record<string, unknown>[] = [];
  const profiles: Record<string, unknown>[] = [];

  for (const p of doc.profiles) {
    const widgets: Record<string, unknown>[] = [];
    for (const w of p.widgets) {
      if (isRetired(w) || needsNewerFirmware(w, !!ctx.legacyFirmware)) continue;
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
    // Prompt images go to the bar like card images.
    const promptImages = new Map<string, string>();
    for (const m of p.modules ?? []) {
      for (const g of moduleGestures(m)) {
        const png = promptShown(g) ? g.prompt?.image : undefined;
        if (png && !promptImages.has(png)) promptImages.set(png, await pngUrl(png));
      }
    }
    for (const m of p.modules ?? []) {
      moduleActions(m).forEach((a) => allowPc(a.pc));
      // Lets the knob change this computer's volume or brightness (see pc_agent.rs).
      for (const t of [m.knob?.right, m.knob?.left]) {
        if (t?.type === "PC_VOLUME") allowed.push({ knob: "pc:volume" });
        if (t?.type === "PC_BRIGHT") allowed.push({ knob: "pc:bright" });
      }
    }
    // The bar shows the profile's icon in its profile switcher, center-cropped.
    profiles.push({
      id: p.id, name: p.name, icon: p.image ? await pngUrl(p.image) : "", iconScale: 60, isDefault: p.isDefault, default: p.isDefault,
      showName: p.showName, module: modulesPayload(p, (png) => promptImages.get(png)), widget: widgets,
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
    appConfigs.push({ packageName: "com.ultrabar.homeassistant", config: { url: haUrl(homeAssistant.url), token: homeAssistant.token.trim() } });
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
  const s = stableStringify([doc.profiles.map(hashShape), doc.automations, doc.integrations, doc.modulesManaged ? doc.modules : null]);
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

/** Gestures without a switch or prompt setting hash as the bare action lists
 * earlier versions stored, so upgrading doesn't flag a deployed layout as
 * changed (they deploy the same). */
function hashShape(p: Profile): unknown {
  if (!p.modules?.length) return p;
  const keys = (b: KeyBinding) =>
    Object.fromEntries(Object.entries(b).map(([e, g]) => [e, g && g.enabled === undefined && g.prompt === undefined ? g.actions : g]));
  return { ...p, modules: p.modules.map((m) => ({ ...m, keys: Object.fromEntries(Object.entries(m.keys ?? {}).map(([c, b]) => [c, keys(b)])) })) };
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
