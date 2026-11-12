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

/** A downloaded shortcut pack. Images are data URLs. */
export interface Pack {
  name: string;
  identifier: string;
  versionCode?: number | null;
  icon?: string | null;
  buttons: { name: string; spanSize: number; icon?: string | null; param: unknown }[];
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
  publishIcon: (data: string) => call<string>("publish_icon", { data }),
  storeApps: () => call<StoreApp[]>("store_apps"),
  storePlugins: () => call<StorePlugin[]>("store_plugins"),
  storePluginPack: (p: StorePlugin) => call<Pack>("store_plugin_pack", { file: p.file, sha256: p.sha256, icon: p.icon ?? null }),
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
  appConfig: 1010,
  moduleDiscoveryStart: 30100,
  moduleDiscoveryStop: 30101,
  moduleDiscovered: 30102,
  coreBarConfig: 30300,
  /** Replaces all scenes (firmware 1.0.9+). */
  saveScenes: 30500,
  /** The same before 1.0.9, where 30500 saved a single scene. */
  saveScenesLegacy: 30501,
  /** Install (type 1), uninstall (2) or query (0) an app; see `APP_TYPE`. */
  appManager: 30600,
  /** Install progress, sent under the 30600 request's id. */
  appManagerEvent: 30601,
  triggerCatalog: 30700,
  profileList: 30710,
} as const;

/** `appType` of bar apps in the store, sent with install requests. */
export const APP_TYPE = 100;
