// In-browser stand-in for the Rust backend, used only when the UI runs outside
// Tauri. Replies mirror what a real bar (firmware 1.0.9) returned.
import type { BarStatus, FoundBar } from "./api";

type Listener = (p: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((cb) => cb(payload));
}

export async function listen(event: string, cb: Listener) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  return () => listeners.get(event)!.delete(cb);
}

const BAR: FoundBar = { serialNo: "5001G26071XS0016", ip: "192.168.1.175", tcpPort: 7431, name: "ultrabar", ver: "1.0.9(9)" };
const paired = () => localStorage.getItem("mock.paired") === "1";

let status: BarStatus = paired()
  ? { state: "online", bar: BAR, error: null, localIp: "192.168.1.20" }
  : { state: "idle", bar: null, error: null, localIp: null };

function setStatus(next: Partial<BarStatus>) {
  status = { ...status, ...next };
  emit("bar-status", status);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tree: Record<string, unknown[]> = {
  "": [
    { components: [{ id: "1", inputType: "INT", max: 300, min: 1, name: "", uiType: "INPUT", unit: "second" }], id: "sc.delay", last: true, name: "Delay", objectName: "", type: "DELAY" },
    { components: [{ id: "1", inputType: "STR", name: "", options: [{ label: "Default Profile", value: "profile_2" }], uiType: "SELECT" }], id: "profile", last: true, name: "Switch Profile", objectName: "Corebar", type: "CHANGE_PROFILE" },
    { id: "1", last: true, name: "PC Control", objectName: "Corebar", type: "PC_CONTROL" },
    { id: "1", last: true, name: "Plugin", objectName: "Corebar", type: "PLUGIN_WIDGET" },
    { id: "sc.corebar", last: false, name: "CoreBar" },
    { id: "corebar.volume", inputType: "INT", max: 100, min: 1, name: "", uiType: "SEEKBAR" },
    { id: "sc.devices", last: false, name: "Device" },
    { id: "scene", last: false, name: "Scene" },
    { id: "sc.other", last: false, name: "Other", objectName: "" },
  ],
  "sc.corebar": [
    { components: [{ id: "corebar.bright", inputType: "INT", max: 100, min: 1, name: "", uiType: "SEEKBAR" }], id: "corebar", last: true, name: "Screen Brightness", objectName: "Corebar", type: "BRIGHT" },
    { components: [{ id: "corebar.volume", inputType: "INT", max: 100, min: 1, name: "", uiType: "SEEKBAR" }], id: "corebar", last: true, name: "Volume", objectName: "Corebar", type: "VOLUME" },
  ],
  "sc.other": [
    { components: [{ id: "1", inputType: "STR", name: "", options: [], uiType: "SELECT" }], id: "activity", last: true, name: "App Start", objectName: "App", type: "ACTIVITY" },
    {
      components: [{ id: "1", inputType: "STR", name: "", uiType: "SELECT", options: [
        { label: "Moonlit Serenade", value: "sys.app.soundscape.1" },
        { label: "The Leviathan's Whisper", value: "sys.app.soundscape.2" },
        { label: "Hearth’s Lullaby", value: "sys.app.soundscape.3" },
        { label: "Dusktide", value: "sys.app.soundscape.4" },
        { label: "HissBubble", value: "sys.app.soundscape.5" },
        { label: "Sonata of Sunrise", value: "sys.app.soundscape.6" },
        { label: "Serenade of Droplets", value: "sys.app.soundscape.7" },
      ] }],
      id: "sound", last: true, name: "Soundscape", objectName: "Soundscape", type: "SOUND_SCAPE",
    },
  ],
  "sc.devices": [
    { id: "sc.devices.sw", last: false, name: "Switch" },
    { id: "sc.devices.light", last: false, name: "Light" },
  ],
  scene: [],
};

// Knob targets (act 1617), as firmware 1.0.9 lists them.
const knobTree: Record<string, unknown[]> = {
  "": [
    { id: "air", last: false, name: "Air Conditioner" }, { id: "audio_player", last: false, name: "AudioPlayer" },
    { id: "pc:root", last: false, name: "Computer" }, { id: "local:root", last: false, name: "Corebar" },
    { id: "curtain", last: false, name: "Curtain" }, { id: "fan", last: false, name: "Fan" }, { id: "light", last: false, name: "Light" },
  ],
  "pc:root": [{ id: "pc:volume", last: true, name: "Volume", type: "PC_VOLUME" }, { id: "pc:bright", last: true, name: "Brightness", type: "PC_BRIGHT" }],
  "local:root": [{ id: "local:volume", last: true, name: "Corebar Volume", type: "LOCAL_VOLUME" }, { id: "local:bright", last: true, name: "Corebar Brightness", type: "LOCAL_BRIGHT" }],
  light: [{ id: "light.desk", last: true, name: "Desk lamp", type: "LIGHT_TEMP" }],
};

let discord = { configured: false, clientId: "", signedIn: false, connected: false, user: null as null | { id: string; username: string }, redirectUri: "http://localhost" };

const triggers = {
  triggers: [
    { type: "DEVICE_STATE", name: "设备状态", params: [
      { dataSource: { act: 30701 }, dataType: "STRING", key: "id", label: "设备", required: true, uiType: "SELECT" },
      { dataSource: { act: 30702, dependsOn: ["id"] }, dataType: "STRING", key: "property", label: "状态属性", required: true, uiType: "SELECT" },
      { dataSource: { act: 30703, dependsOn: ["id", "property"] }, dataType: "STRING", key: "from", label: "从", required: true },
      { dataSource: { act: 30703, dependsOn: ["id", "property"] }, dataType: "STRING", key: "to", label: "变为", required: true },
    ] },
    { type: "PROFILE", name: "profile变化", params: [
      { dataSource: { act: 30710 }, dataType: "STRING", key: "from", label: "从", required: true, uiType: "SELECT" },
      { dataSource: { act: 30710 }, dataType: "STRING", key: "to", label: "变为", required: true, uiType: "SELECT" },
    ], validations: [{ fields: ["from", "to"], message: "", rule: "NOT_EQUAL" }] },
    { type: "APP_STATE", name: "应用监听", params: [
      { dataSource: { act: 30720 }, dataType: "STRING", key: "package", label: "应用", required: true, uiType: "SELECT" },
      { dataSource: { act: 30721 }, dataType: "STRING", key: "in", label: "在", required: true, uiType: "SELECT" },
    ] },
  ],
  conditions: [],
};

let apps = [
  { application: "com.ultrabar.calculator", appName: "Calculator", icon: "", versionName: "1.0.1", versionCode: 1, systemApp: true, allowProfile: true, config: false },
  { application: "com.ultrabar.homeassistant", appName: "Home Assistant", icon: "", versionName: "0.9", versionCode: 3, systemApp: false, allowProfile: false, config: true, port: 9000, sessionToken: "demo" },
];

// Store listings as the vendor returns them (trimmed), and one pack.
const storeApps = [
  { application: "com.ultrabar.calculator", appName: "Calculator", icon: null, desc: "", versionName: "1.0.2", versionCode: 2 },
  { application: "com.ultrabar.homeassistant", appName: "HomeAssistant", icon: null, desc: "", versionName: "1.0.4", versionCode: 4 },
  { application: "com.ultrabar.whitenoise", appName: "Whitenoise", icon: null, desc: "", versionName: "1.0.5", versionCode: 5 },
  { application: "com.ultrabar.radio", appName: "UltraRadio", icon: null, desc: "Internet radio on your bar", versionName: "1.7.1", versionCode: 17 },
];
const storePlugins = [
  { id: 48, identifier: "zoom", name: "ZOOM Hotkey Plugin", desc: "Global Hotkeys for ZOOM.", author: "Sanytron", icon: null, file: "mock://zoom.zip", sha256: "00", versionName: "v1.0.0", versionCode: 1 },
  { id: 46, identifier: "ai", name: "AI Website", desc: "These are commonly used AI websites.", author: "Sanytron", icon: null, file: "mock://ai.zip", sha256: "00", versionName: "v1.0.0", versionCode: 1 },
];
const packs: Record<string, unknown> = {
  "mock://zoom.zip": { name: "ZOOM Hotkey Plugin", identifier: "zoom", versionCode: 1, icon: null, buttons: [
    { name: "Start/stop video", spanSize: 2, icon: null, param: { output: 5, keys: [226, 25] } },
    { name: "Mute/unmute audio", spanSize: 2, icon: null, param: { output: 5, keys: [226, 4] } },
    { name: "Raise/Lower Hand", spanSize: 1, icon: null, param: { output: 5, keys: [226, 28] } },
    { name: "Switch camera", spanSize: 1, icon: null, param: { output: 5, keys: [226, 17] } },
  ] },
  "mock://ai.zip": { name: "AI Website", identifier: "ai", versionCode: 1, icon: null, buttons: [
    { name: "ChatGPT", spanSize: 2, icon: null, param: { output: 10, payload: { action: "openBrowser", params: { url: "https://chatgpt.com/" } } } },
    { name: "Claude", spanSize: 1, icon: null, param: { output: 10, payload: { action: "openBrowser", params: { url: "https://claude.ai/" } } } },
    { name: "Run something", spanSize: 1, icon: null, param: { output: 10, payload: { action: "execCmd", params: { cmd: "echo hi" } } } },
  ] },
};

// The cloud icon library: the real filters, and generated icons (the CDN's
// images can't be drawn into card art from a plain browser).
const iconTags = {
  group: [{ id: 1516, tag: "Function" }, { id: 1525, tag: "Brands" }, { id: 1527, tag: "UI Elements" }, { id: 1533, tag: "Apps" }, { id: 3045, tag: "Development" }],
  category: [
    { id: 1517, tag: "Key Actions" }, { id: 1534, tag: "Apps · Color" }, { id: 3035, tag: "Brands · Official Color" }, { id: 3038, tag: "Brands · Color" },
    { id: 3040, tag: "Web Apps" }, { id: 3041, tag: "Work Apps" }, { id: 3043, tag: "General" }, { id: 3046, tag: "Development" },
    { id: 3047, tag: "Apps · Mono Line" }, { id: 3049, tag: "Brands · Mono" }, { id: 3051, tag: "UI · Line" }, { id: 3053, tag: "UI · Fill" },
  ],
  iconStyle: [{ id: 1519, tag: "Monochrome" }, { id: 1529, tag: "Color" }],
};
const ICON_WORDS = ["play", "pause", "mute", "mic", "camera", "mail", "chat", "code", "git", "home", "light", "fan", "music", "video", "star", "heart", "zoom", "search", "lock", "power", "cloud", "sun", "moon", "bell"];
const libraryIcons = Array.from({ length: 130 }, (_, i) => {
  const name = `${ICON_WORDS[i % ICON_WORDS.length]}${i >= ICON_WORDS.length ? `-${Math.floor(i / ICON_WORDS.length)}` : ""}`;
  const color = i % 3 === 0;
  const fill = color ? `hsl(${(i * 47) % 360} 70% 55%)` : "#e8e8e8";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect x="40" y="40" width="176" height="176" rx="${(i % 4) * 22}" fill="none" stroke="${fill}" stroke-width="16"/><text x="128" y="160" font-family="sans-serif" font-size="96" font-weight="700" text-anchor="middle" fill="${fill}">${name[0].toUpperCase()}</text></svg>`;
  return {
    id: 40000 + i, name, path: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, iconStyleName: color ? "color" : "mono",
    groupId: iconTags.group[i % 5].id, categoryId: iconTags.category[i % 12].id, iconStyleId: color ? 1529 : 1519,
  };
});

function iconPage(q: { page?: number; keyword?: string; groupId?: number | null; categoryId?: number | null; iconStyleId?: number | null }) {
  const hits = libraryIcons.filter((i) =>
    matches(q.keyword, i.name) && (!q.groupId || i.groupId === q.groupId) && (!q.categoryId || i.categoryId === q.categoryId) && (!q.iconStyleId || i.iconStyleId === q.iconStyleId));
  const page = Math.max(1, q.page ?? 1);
  return { total: hits.length, icons: hits.slice((page - 1) * 50, page * 50).map(({ id, name, path, iconStyleName }) => ({ id, name, path, iconStyleName })) };
}

/** Rough stand-in for the store's keyword search. */
function matches(keyword: unknown, ...fields: (string | null | undefined)[]) {
  const k = typeof keyword === "string" ? keyword.trim().toLowerCase() : "";
  return !k || fields.some((f) => f?.toLowerCase().includes(k));
}

/** Plays back the events a real bar sends while installing (act 30601). */
function simulateInstall(pkg: string) {
  const ev = (type: string, result: unknown, at: number) =>
    setTimeout(() => emit("bar-push", { act: 30601, code: 200, data: { packageName: pkg, type, result } }), at);
  ev("STATUS", "DOWNLOADING", 50);
  for (let i = 1; i <= 10; i++) ev("DOWNLOAD", i * 10, 300 * i);
  ev("STATUS", "INSTALLING", 3200);
  for (let i = 1; i <= 5; i++) ev("INSTALL", i * 20, 3200 + 250 * i);
  setTimeout(() => {
    const s = storeApps.find((a) => a.application === pkg)!;
    apps = [...apps.filter((a) => a.application !== pkg), { application: pkg, appName: s.appName, icon: "", versionName: s.versionName, versionCode: s.versionCode, systemApp: false, allowProfile: true, config: false }];
    emit("bar-push", { act: 30601, code: 200, data: { packageName: pkg, type: "STATUS", result: "INSTALLED" } });
  }, 4800);
}

async function request(act: number, data: unknown): Promise<unknown> {
  await sleep(120 + Math.random() * 200);
  if (status.state !== "online") throw { code: -2, message: "Not connected to the bar" };
  switch (act) {
    case 1000: return apps;
    case 1002: case 1300: case 30701: case 30720: return [];
    case 1205: return tree[(data as string) ?? ""] ?? [];
    case 1617: return knobTree[(data as string) ?? ""] ?? [];
    case 30200: {
      const d = data as { serialNo: string; propertyId: number };
      if (d.propertyId !== 5) return null;
      if (d.serialNo !== "DK01A2234") throw { code: -1, message: "The bar didn't answer in time." };
      return { result: "1.0.3" };
    }
    case 30730: return (data as string[]).map((serialNo) => ({ serialNo, online: serialNo === "DK01A2234" }));
    case 30700: return triggers;
    case 30710: return [{ label: "Default Profile", value: "profile_2", last: true }];
    case 30721: return [{ label: "前台", value: "true", last: true }, { label: "后台", value: "false", last: true }];
    case 1103: case 1108: case 30500: case 30300: case 1010: return "ok";
    case 30600: {
      const d = data as { type: number; packageName: string };
      if (d.type === 1) { simulateInstall(d.packageName); return "success"; }
      if (d.type === 2) { apps = apps.filter((a) => a.application !== d.packageName); return "success"; }
      const a = apps.find((x) => x.application === d.packageName);
      return a ? { status: "INSTALLED", versionCode: a.versionCode, versionName: a.versionName } : { status: "NOT_INSTALLED", versionCode: 0 };
    }
    // Removed in firmware 1.0.9; the real bar replies with an unmatched error.
    case 1101: case 30501: throw { code: -5, message: `The bar doesn't support this request (act ${act}). Its firmware may be newer or older than this app expects.` };
    case 30100:
      setTimeout(() => emit("bar-push", { act: 30102, code: 200, data: { interfaceType: "can", serialNumber: "DK01A2234", workMode: 1, productId: 268435457, netId: 32 } }), 1800);
      setTimeout(() => emit("bar-push", { act: 30102, code: 200, data: { interfaceType: "can", serialNumber: "KN01B7781", workMode: 1, productId: 268435458, netId: 122 } }), 2600);
      return null;
    default: return null;
  }
}

export async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case "app_info": return { clientId: "mock", hostname: "Browser", version: "0.1.0", pcAgentEnabled: true, iconPort: 47215 };
    case "discover_bars": await sleep(1200); return [BAR];
    case "bar_status": return status;
    case "connect_bar": {
      setStatus({ state: "connecting", bar: BAR, error: null });
      await sleep(500);
      if (paired()) { setStatus({ state: "online", localIp: "192.168.1.20" }); return; }
      if (args.pair) {
        setStatus({ state: "awaitingApproval" });
        setTimeout(() => { localStorage.setItem("mock.paired", "1"); setStatus({ state: "online", localIp: "192.168.1.20" }); }, 3500);
      } else setStatus({ state: "needsPairing" });
      return;
    }
    case "pair_bar":
      setStatus({ state: "awaitingApproval", error: null });
      setTimeout(() => { localStorage.setItem("mock.paired", "1"); setStatus({ state: "online", localIp: "192.168.1.20" }); }, 3500);
      return;
    case "reconnect_bar": return;
    case "forget_bar": localStorage.removeItem("mock.paired"); setStatus({ state: "idle", bar: null }); return;
    case "bar_request": return request(args.act as number, args.data);
    case "load_doc": { const d = localStorage.getItem("mock.doc"); return d ? JSON.parse(d) : null; }
    case "save_doc": localStorage.setItem("mock.doc", JSON.stringify(args.doc)); return;
    case "store_icon": {
      // A stable id per image, like the content hash the app uses.
      const d = String(args.data);
      let h = 0;
      for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(8, "0");
    }
    case "icon_http_base": return "http://192.168.1.20:47215/i/";
    case "upload_bar_images": await sleep(400); return;
    case "icon_library_tags": await sleep(300); return iconTags;
    case "icon_library_page": await sleep(350); return iconPage(args.query as Parameters<typeof iconPage>[0]);
    case "icon_library_image": await sleep(200); return args.url;
    case "store_apps": await sleep(400); return storeApps.filter((a) => matches(args.keyword, a.appName, a.application, a.desc));
    case "store_plugins": await sleep(400); return storePlugins.filter((p) => matches(args.keyword, p.name, p.desc, p.author));
    case "store_app_latest": await sleep(250); return storeApps.find((a) => a.application === args.package) ?? null;
    case "store_plugin_pack": await sleep(600); return packs[args.file as string];
    case "set_allowed_actions": case "set_pc_agent_enabled": case "test_pc_action": case "refresh_bar_screen": return;
    case "running_apps": await sleep(300); return [
      { name: "Safari", path: "/Applications/Safari.app" },
      { name: "Slack", path: "/Applications/Slack.app" },
      { name: "Visual Studio Code", path: "/Applications/Visual Studio Code.app" },
    ];
    case "ha_logged_in": return false;
    case "discord_status": return discord;
    case "discord_set_app": discord = { ...discord, clientId: String(args.clientId), configured: !!args.clientId && (!!args.clientSecret || discord.configured) }; return discord;
    case "discord_sign_in": await sleep(1500); discord = { ...discord, signedIn: true, connected: true, user: { id: "1", username: "you" } }; return discord;
    case "discord_sign_out": discord = { ...discord, signedIn: false, connected: false, user: null }; return discord;
    case "discord_check": if (!discord.configured) throw new Error("Discord isn't set up."); return discord;
    case "discord_voice_channels": await sleep(400); return [{ id: "10", name: "Friends", channels: [{ id: "11", name: "General" }, { id: "12", name: "Gaming" }] }];
    case "discord_sounds": await sleep(400); return [
      { guildId: "0", guildName: "", soundId: "1", name: "quack", emoji: "🦆", available: true },
      { guildId: "10", guildName: "Friends", soundId: "7", name: "airhorn", emoji: "📯", available: true },
    ];
    default: throw new Error(`mock: unknown command ${cmd}`);
  }
}
