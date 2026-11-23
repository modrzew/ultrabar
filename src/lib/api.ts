// Typed bridge to the Rust side. In a plain browser (UI development without
// Tauri) calls go to an in-memory mock bar instead.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Doc } from "./model";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type ConnState = "idle" | "connecting" | "needsPairing" | "awaitingApproval" | "online" | "offline";

export interface FoundBar {
  serialNo: string;
  ip: string;
  tcpPort: number;
  name?: string | null;
  ver?: string | null;
}

export interface BarStatus {
  state: ConnState;
  bar: FoundBar | null;
  error: string | null;
  localIp: string | null;
}

export interface RequestError {
  code: number;
  message: string;
}

export interface AppInfo {
  clientId: string;
  hostname: string;
  version: string;
  pcAgentEnabled: boolean;
  iconPort: number;
}

export interface PcActionEvent {
  payload: unknown;
  ok: boolean;
  error: string | null;
  at: number;
}

export interface PushEnvelope {
  id?: string;
  act: number;
  code?: number;
  data?: unknown;
}

/** An app in the vendor's store. The bar downloads and installs it itself. */
export interface StoreApp {
  application: string;
  appName: string;
  icon?: string | null;
  desc?: string | null;
  versionName?: string | null;
  versionCode?: number | null;
}

/** A shortcut pack ("plugin") in the vendor's store. */
export interface StorePlugin {
  id: number;
  identifier: string;
  name: string;
  desc?: string | null;
  author?: string | null;
  icon?: string | null;
  file: string;
  sha256: string;
  versionName?: string | null;
  versionCode?: number | null;
}

export interface DiscordUser {
  id: string;
  username: string;
  globalName?: string | null;
}

export interface DiscordStatus {
  /** Client ID and secret are set. */
  configured: boolean;
  clientId: string;
  signedIn: boolean;
  /** A live session with the Discord app on this computer. */
  connected: boolean;
  user: DiscordUser | null;
  /** The redirect URL the Discord application needs. */
  redirectUri: string;
  /** Set by the UI when the last check failed. */
  error?: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
  channels: { id: string; name: string }[];
}

export interface DiscordSound {
  guildId: string;
  guildName: string;
  soundId: string;
  name: string;
  emoji?: string | null;
  available: boolean;
}

/** A GUI app running on this computer (`.app` bundle on macOS, executable on Windows). */
export interface RunningApp {
  name: string;
  path: string;
}

/** A downloaded shortcut pack. Images are data URLs. */
export interface Pack {
  name: string;
  identifier: string;
  versionCode?: number | null;
  icon?: string | null;
  buttons: { name: string; spanSize: number; icon?: string | null; param: unknown }[];
}

/** A shortcut pack installed on this computer (kept in the app's data
 * folder, not in the layout). */
export interface InstalledPack {
  /** The store record it was installed from. */
  plugin: StorePlugin;
  pack: Pack;
  installedAt: number;
}

/** A filter value in the cloud icon library. */
export interface IconTag {
  id: number;
  tag: string;
}

export interface IconTags {
  group: IconTag[];
  category: IconTag[];
  iconStyle: IconTag[];
}

/** An icon in the vendor's cloud library; `path` is an http(s) PNG. */
export interface LibraryIcon {
  id: number;
  name: string;
  path: string;
  iconStyleName?: string | null;
}

/** One page of the library (50 icons). Unset filters mean "All". */
export interface IconQuery {
  page: number;
  keyword?: string;
  groupId?: number | null;
  categoryId?: number | null;
  iconStyleId?: number | null;
}

type Mock = typeof import("./mock");
let mockMod: Promise<Mock> | null = null;
const mock = () => (mockMod ??= import("./mock"));

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return invoke<T>(cmd, args);
  return (await mock()).invoke(cmd, args) as Promise<T>;
}

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "Something went wrong";
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  discover: (timeoutMs?: number, extra?: string[]) => call<FoundBar[]>("discover_bars", { timeoutMs, extra }),
  status: () => call<BarStatus>("bar_status"),
  connect: (bar: FoundBar, pair: boolean) => call<void>("connect_bar", { bar, pair }),
  pair: () => call<void>("pair_bar"),
  reconnect: () => call<void>("reconnect_bar"),
  forget: () => call<void>("forget_bar"),
  request: <T = unknown>(act: number, data?: unknown, timeoutMs?: number) =>
    call<T>("bar_request", { act, data, timeoutMs }),
  /** Redraws the bar's home screen; firmware 1.0.9 doesn't after a profile save. */
  refreshScreen: () => call<void>("refresh_bar_screen"),
  loadDoc: () => call<Doc | null>("load_doc"),
  saveDoc: (doc: Doc) => call<void>("save_doc", { doc }),
  setAllowedActions: (actions: unknown[]) => call<void>("set_allowed_actions", { actions }),
  setPcAgentEnabled: (enabled: boolean) => call<void>("set_pc_agent_enabled", { enabled }),
  testPcAction: (payload: unknown) => call<void>("test_pc_action", { payload }),
  runningApps: () => call<RunningApp[]>("running_apps"),
  /** Keeps a PNG (data URL) for the bar; returns its id (a content hash). */
  storeIcon: (data: string) => call<string>("store_icon", { data }),
  /** `<base><id>.png` serves a stored image from this computer. */
  iconHttpBase: () => call<string>("icon_http_base"),
  /** Replaces this app's images on the bar (launcher 1.0.9+). */
  uploadBarImages: (ids: string[]) => call<void>("upload_bar_images", { ids }),
  iconLibraryTags: () => call<IconTags>("icon_library_tags"),
  iconLibraryPage: (query: IconQuery) => call<{ total: number; icons: LibraryIcon[] }>("icon_library_page", { query }),
  /** A library icon as a data URL (so it can be drawn into card art). */
  iconLibraryImage: (url: string) => call<string>("icon_library_image", { url }),
  /** Whether the bar's Home Assistant app is logged in (its own status page). */
  haLoggedIn: (port: number) => call<boolean>("ha_logged_in", { port }),
  discordStatus: () => call<DiscordStatus>("discord_status"),
  discordSetApp: (clientId: string, clientSecret: string) => call<DiscordStatus>("discord_set_app", { clientId, clientSecret }),
  discordSignIn: () => call<DiscordStatus>("discord_sign_in"),
  discordSignOut: () => call<DiscordStatus>("discord_sign_out"),
  discordCheck: () => call<DiscordStatus>("discord_check"),
  discordVoiceChannels: () => call<DiscordGuild[]>("discord_voice_channels"),
  discordSounds: () => call<DiscordSound[]>("discord_sounds"),
  /** Store apps; `keyword` uses the store's own search. */
  storeApps: (keyword?: string) => call<StoreApp[]>("store_apps", { keyword: keyword?.trim() || null }),
  /** Shortcut packs; `keyword` uses the store's own search. */
  storePlugins: (keyword?: string) => call<StorePlugin[]>("store_plugins", { keyword: keyword?.trim() || null }),
  /** The store's latest version of an app (`fetchLastVerV3`), null when it isn't in the store. */
  storeAppLatest: (pkg: string) => call<StoreApp | null>("store_app_latest", { package: pkg }),
  installedPacks: () => call<InstalledPack[]>("installed_packs"),
  /** Downloads a pack (checked against the store's hash) and keeps it; also
   * reloads or updates an installed one. */
  installPack: (plugin: StorePlugin) => call<InstalledPack>("install_pack", { plugin }),
  uninstallPack: (id: number) => call<void>("uninstall_pack", { id }),
};

export async function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (isTauri) return listen<T>(event, (e) => cb(e.payload));
  return (await mock()).listen(event, cb as (p: unknown) => void);
}

/** True when the bar reports a firmware version (e.g. "1.0.9(9)") older than
 * `min` ("1.0.9"). Unknown versions count as current. */
export function firmwareBefore(ver: string | null | undefined, min: string): boolean {
  const parse = (v: string) => v.replace(/\(.*$/, "").split(".").map((n) => parseInt(n, 10) || 0);
  if (!ver) return false;
  const a = parse(ver), b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** Opcodes used by the UI (see PROTOCOL.md). */
export const ACT = {
  getAppList: 1000,
  getComponents: 1002,
  switchProfile: 1103,
  saveProfiles: 1108,
  actionTree: 1205,
  getDevices: 1300,
  /** What a Knob can control: a lazy tree like the action tree. */
  knobTargets: 1617,
  /** `[serialNumber, …]` → `[{serialNo, online}]`. */
  moduleState: 30730,
  appConfig: 1010,
  moduleDiscoveryStart: 30100,
  moduleDiscoveryStop: 30101,
  moduleDiscovered: 30102,
  coreBarConfig: 30300,
  /** `{serialNo, deviceId, propertyId, extra}` → `{result}`: reads a module property. */
  readModuleProperty: 30200,
  /** Replaces all scenes (firmware 1.0.9+). */
  saveScenes: 30500,
  /** The same before 1.0.9, where 30500 saved a single scene. */
  saveScenesLegacy: 30501,
  /** Install (type 1), uninstall (2) or query (0) an app; see `APP_TYPE`. */
  appManager: 30600,
  /** Install progress, sent under the 30600 request's id. */
  appManagerEvent: 30601,
  /** `"<packageName>"` → the actions an app on the bar offers. */
  appActions: 30750,
  /** `{actionId, packageName}` → that action's params. */
  appActionParams: 30751,
  /** `{actionId, packageName, describeId, cursor, limit, params}` → one page of a param's options. */
  appParamOptions: 30752,
  triggerCatalog: 30700,
  profileList: 30710,
} as const;

/** `appType` of bar apps in the store, sent with install requests. */
export const APP_TYPE = 100;
