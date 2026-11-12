// The layout document this app edits. The bar can't report its configuration
// back, so this document is the source of truth; Deploy pushes it to the bar.

export type WidgetType =
  | "TIME"
  | "WORLD_TIME"
  | "WEATHER"
  | "TIMER"
  | "SOUNDSCAPE"
  | "APPS"
  | "PC_CONTROL"
  | "SCENE"
  | "SET"
  | "DEVICE";

export type IconSpec =
  | { kind: "glyph"; glyph: string; color: string; png: string }
  | { kind: "image"; png: string }
  | { kind: "url"; url: string };

export type PcAction = "hotkey" | "openBrowser" | "startApp" | "openFile" | "execCmd" | "inputText";

export interface PcControl {
  action: PcAction;
  /** HID usage codes (hotkey only). */
  keys?: number[];
  url?: string;
  path?: string;
  cmd?: string;
  text?: string;
}

/** One step of a multi-action card or automation ("scene action" on the bar). */
export interface Action {
  uid: string;
  /** Node id from the bar's action tree (act 1205). */
  nodeId: string;
  type: string;
  name: string;
  objectName?: string;
  objectParams?: unknown;
  values: { id: string; value: unknown }[];
  /** Human readable, e.g. "Switch profile → Work". */
  summary: string;
  /** Set for PC_CONTROL actions; values are derived from it on deploy. */
  pc?: PcControl;
}

export interface Widget {
  uid: string;
  type: WidgetType;
  name: string;
  icon?: IconSpec;
  iconScale: number;
  bgColor?: string;
  // Type-specific settings:
  timer?: { seconds: number };
  worldTime?: { zone: string };
  weather?: { lat: string; lon: string; place?: string };
  soundscape?: { id: string };
  app?: { package: string };
  pc?: PcControl;
  actions?: Action[];
  device?: { id: string; deviceType: string };
}

export interface Profile {
  id: string;
  name: string;
  isDefault: boolean;
  showName: boolean;
  widgets: Widget[];
}

export interface Trigger {
  uid: string;
  type: string;
  params: Record<string, string>;
  summary: string;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  triggers: Trigger[];
  actions: Action[];
}

export interface ModuleEndpoint {
  uid: string;
  name: string;
  serialNumber: string;
  productId: string;
  interfaceType: string;
  netId?: number;
  workMode?: number;
  extraConfig?: unknown;
}

export interface Doc {
  version: 1;
  profiles: Profile[];
  automations: Automation[];
  integrations: {
    weather: { apiKey: string; metric: boolean };
    homeAssistant: { url: string; token: string };
  };
  modules: ModuleEndpoint[];
  /** Only push the module list once the user manages modules here. */
  modulesManaged: boolean;
  deployedHash?: string;
  deployedAt?: number;
  deployedTo?: string;
}

export function uid(prefix = ""): string {
  const s = crypto.getRandomValues(new Uint32Array(2));
  return prefix + s[0].toString(36) + s[1].toString(36).slice(0, 4);
}
