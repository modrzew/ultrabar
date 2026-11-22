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
  | "DEVICE"
  | "HOT_KEY_GROUP";

export type IconSpec =
  | { kind: "glyph"; glyph: string; color: string; png: string }
  | { kind: "image"; png: string }
  | { kind: "url"; url: string };

export type PcAction = "hotkey" | "openBrowser" | "startApp" | "openFile" | "execCmd" | "inputText" | "discord";

export type DiscordOp = "joinVoice" | "leaveVoice" | "toggleMute" | "toggleDeafen" | "playSound" | "toggleCamera" | "toggleScreenShare";

/** A Discord action this computer runs through the Discord app (see discord.rs). */
export interface DiscordAction {
  op: DiscordOp;
  guildId?: string;
  channelId?: string;
  soundId?: string;
  /** Channel or sound name, for display only (not sent to the bar). */
  label?: string;
}

export interface PcControl {
  action: PcAction;
  /** HID usage codes (hotkey only). */
  keys?: number[];
  url?: string;
  path?: string;
  cmd?: string;
  text?: string;
  discord?: DiscordAction;
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

/** One button on a shortcut group's page. */
export interface GroupButton {
  uid: string;
  name: string;
  /** 1 = one cell, 2 = a full column (the page has two rows). */
  span: 1 | 2;
  /** PNG data URL. */
  icon?: string;
  pc: PcControl;
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
  /** Shortcut group: tapping the card opens a page of these buttons. */
  group?: {
    buttons: GroupButton[];
    /** The store pack it came from. */
    pack?: { id: number; name: string; versionCode?: number };
  };
}

export type KeyEvent = "click" | "double" | "long";

/** What one module key does in a profile: an action list per gesture. */
export type KeyBinding = Partial<Record<KeyEvent, Action[]>>;

/** What a Knob controls: a node from the bar's knob catalog (act 1617). */
export interface KnobTarget {
  /** e.g. "pc:volume", "local:bright", or a Home Assistant entity id. */
  id: string;
  /** The bar's ModalType, e.g. "PC_VOLUME", "LOCAL_BRIGHT", "LIGHT_HS". */
  type: string;
  name: string;
}

/** A module's buttons in one profile (deployed as the profile's `module` list). */
export interface ModuleSetup {
  serialNumber: string;
  productId: string;
  /** Key code (as a string) → gestures. Dot Key keys are 0–2; the Knob's button is 0. */
  keys: Record<string, KeyBinding>;
  /** Knob only. The direction of the first turn picks the target; further
   * turns either way adjust it until the knob rests for 3 seconds. */
  knob?: { right?: KnobTarget; left?: KnobTarget };
}

export interface Profile {
  id: string;
  name: string;
  isDefault: boolean;
  showName: boolean;
  /** PNG data URL (see `profileImagePng`) shown in the bar's profile switcher. */
  image?: string;
  widgets: Widget[];
  modules?: ModuleSetup[];
}

/** Where a module is drawn next to the bar preview. Only kept in this app. */
export interface ModulePlacement {
  side: "left" | "right";
  /** Position along that side, from the bar outwards. */
  order: number;
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
  /** Keyed by serial number. Not sent to the bar. */
  modulePlacement?: Record<string, ModulePlacement>;
  deployedHash?: string;
  deployedAt?: number;
  deployedTo?: string;
}

export function uid(prefix = ""): string {
  const s = crypto.getRandomValues(new Uint32Array(2));
  return prefix + s[0].toString(36) + s[1].toString(36).slice(0, 4);
}
