import { create } from "zustand";
import {
  ACT, APP_TYPE, api, errorMessage, firmwareBefore, on,
  type AppInfo, type BarStatus, type PcActionEvent, type PushEnvelope, type StoreApp, type StorePlugin,
} from "./api";
import type { Automation, Doc, Profile, Widget } from "./model";
import { uid } from "./model";
import { PC_ACTIONS, newWidget } from "./widgets";
import { buildPlan, docHash, fitsOneLine, lineSize } from "./deploy";
import { cardArtPng, glyphPng } from "./icons";

export type View =
  | { kind: "profile"; id: string }
  | { kind: "automations"; id?: string }
  | { kind: "modules" }
  | { kind: "integrations" }
  | { kind: "apps" }
  | { kind: "settings" };

export interface BarApp {
  application: string;
  appName: string;
  icon?: string;
  versionName?: string;
  versionCode?: number;
  systemApp?: boolean;
  screensaver?: boolean;
  allowProfile?: boolean;
  config?: boolean;
  port?: number;
  sessionToken?: string;
}

export interface TreeNode {
  id: string;
  name: string;
  last: boolean;
  type?: string;
  objectName?: string;
  objectParams?: unknown;
  components?: Component[];
}

export interface Component {
  id: string;
  name?: string;
  uiType: "INPUT" | "SELECT" | "SEEKBAR" | "COLOR_PICKER" | string;
  inputType?: "INT" | "STR" | string;
  options?: { label: string; value: string }[];
  min?: number;
  max?: number;
  unit?: string;
}

export interface ParamMeta {
  key: string;
  label: string;
  uiType?: string;
  dataType?: string;
  required?: boolean;
  options?: { label: string; value: string }[];
  dataSource?: { act: number; dependsOn?: string[] };
  min?: number;
  max?: number;
}

export interface TriggerType {
  type: string;
  name: string;
  desc?: string;
  params: ParamMeta[];
  validations?: { fields: string[]; rule: string; message?: string }[];
}

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  title: string;
  body?: string;
}

export type DeployState =
  | { phase: "idle" }
  | { phase: "running"; step: string }
  | { phase: "done"; at: number; warnings: string[] }
  | { phase: "error"; message: string; step: string };

/** The vendor's store, loaded when the Apps page or the pack browser opens. */
export interface Market {
  apps: StoreApp[];
  plugins: StorePlugin[];
  state: "idle" | "loading" | "ready" | "error";
  error?: string;
}

/** An app the bar is installing or removing. The bar does one at a time. */
export interface AppJob {
  name: string;
  phase: "starting" | "downloading" | "installing" | "uninstalling";
  /** 0–100 within the phase, when the bar reports it. */
  progress?: number;
  /** Last word from the bar, to notice a lost install. */
  at: number;
}

interface Catalog {
  apps: BarApp[];
  devices: { id: string; name: string; deviceType: string }[];
  triggers: TriggerType[];
  loaded: boolean;
}

interface State {
  ready: boolean;
  info: AppInfo | null;
  doc: Doc;
  view: View;
  selected: string | null;
  status: BarStatus;
  catalog: Catalog;
  deploy: DeployState;
  toasts: Toast[];
  pcLog: PcActionEvent[];
  connectOpen: boolean;
  market: Market;
  appJobs: Record<string, AppJob>;
  past: Doc[];
  future: Doc[];

  init(): Promise<void>;
  update(mutate: (d: Doc) => void, coalesce?: string, silent?: boolean): void;
  undo(): void;
  redo(): void;
  setView(v: View): void;
  select(uid: string | null): void;
  setConnectOpen(open: boolean): void;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: string): void;
  loadCatalog(): Promise<void>;
  loadMarket(force?: boolean): Promise<void>;
  installApp(pkg: string, name: string): Promise<void>;
  uninstallApp(pkg: string, name: string): Promise<void>;
  runDeploy(): Promise<void>;
  showProfileOnBar(id: string): Promise<void>;

  addProfile(): string;
  duplicateProfile(id: string): void;
  deleteProfile(id: string): void;
  addWidget(profileId: string, w: Widget, index?: number): void;
  updateWidget(uid: string, mutate: (w: Widget) => void, coalesce?: string, silent?: boolean): void;
  removeWidget(uid: string): void;
  duplicateWidget(uid: string): void;
  moveWidget(profileId: string, from: number, to: number): void;
  addAutomation(): string;
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

function defaultDoc(): Doc {
  const id = "profile_" + uid();
  return {
    version: 1,
    profiles: [{
      id, name: "Main", isDefault: true, showName: true,
      widgets: [newWidget("TIME"), newWidget("WEATHER"), newWidget("TIMER")],
    }],
    automations: [],
    integrations: { weather: { apiKey: "", metric: true }, homeAssistant: { url: "", token: "" } },
    modules: [],
    modulesManaged: false,
  };
}

function normalize(doc: Doc): Doc {
  const d = { ...defaultDoc(), ...doc };
  d.integrations = { ...defaultDoc().integrations, ...doc.integrations };
  if (!d.profiles.length) d.profiles = defaultDoc().profiles;
  if (!d.profiles.some((p) => p.isDefault)) d.profiles[0].isDefault = true;
  return d;
}

export function findWidget(doc: Doc, wuid: string): { profile: Profile; widget: Widget; index: number } | null {
  for (const profile of doc.profiles) {
    const index = profile.widgets.findIndex((w) => w.uid === wuid);
    if (index >= 0) return { profile, widget: profile.widgets[index], index };
  }
  return null;
}

export function isDirty(s: Pick<State, "doc" | "status">): boolean {
  const serial = s.status.bar?.serialNo;
  return s.doc.deployedHash !== docHash(s.doc) || (!!serial && s.doc.deployedTo !== serial);
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let initStarted = false;
let lastCoalesce: { key: string; at: number } | null = null;
const HISTORY = 100;

export const useApp = create<State>((set, get) => ({
  ready: false,
  info: null,
  doc: defaultDoc(),
  view: { kind: "profile", id: "" },
  selected: null,
  status: { state: "idle", bar: null, error: null, localIp: null },
  catalog: { apps: [], devices: [], triggers: [], loaded: false },
  deploy: { phase: "idle" },
  toasts: [],
  pcLog: [],
  connectOpen: false,
  market: { apps: [], plugins: [], state: "idle" },
  appJobs: {},
  past: [],
  future: [],

  async init() {
    if (initStarted) return;
    initStarted = true;
    const [info, stored, status] = await Promise.all([
      api.appInfo().catch(() => null),
      api.loadDoc().catch(() => null),
      api.status().catch(() => null),
    ]);
    const doc = stored ? normalize(stored) : defaultDoc();
    set({
      info, doc, ready: true,
      view: { kind: "profile", id: doc.profiles[0].id },
      status: status ?? get().status,
      connectOpen: !status || status.state === "idle",
    });
    if (!stored) void api.saveDoc(doc);

    await on<BarStatus>("bar-status", (s) => {
      const prev = get().status.state;
      set({ status: s });
      if (s.state === "online" && prev !== "online") {
        void get().loadCatalog();
        void checkAppJobs(0);
      }
    });
    await on<PcActionEvent>("pc-action", (e) => {
      set({ pcLog: [e, ...get().pcLog].slice(0, 50) });
      if (!e.ok) get().toast({ kind: "error", title: "Blocked a request from the bar", body: e.error ?? undefined });
    });
    await on<PushEnvelope>("bar-push", (e) => {
      if (e.act === ACT.appManagerEvent) onAppEvent(e.data);
    });
    setInterval(() => void checkAppJobs(60_000), 20_000);
    if (status?.state === "online") void get().loadCatalog();
  },

  update(mutate, coalesce, silent) {
    const before = get().doc;
    const next = structuredClone(before);
    mutate(next);
    const now = Date.now();
    const merge = silent || (coalesce && lastCoalesce?.key === coalesce && now - lastCoalesce.at < 1200);
    if (!silent) lastCoalesce = coalesce ? { key: coalesce, at: now } : null;
    set({
      doc: next,
      past: merge ? get().past : [...get().past, before].slice(-HISTORY),
      future: silent ? get().future : [],
    });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void api.saveDoc(get().doc), 350);
  },

  undo() {
    const { past, doc, future } = get();
    if (!past.length) return;
    lastCoalesce = null;
    const prev = past[past.length - 1];
    set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future] });
    fixSelection();
    void api.saveDoc(prev);
  },

  redo() {
    const { past, doc, future } = get();
    if (!future.length) return;
    lastCoalesce = null;
    const next = future[0];
    set({ doc: next, past: [...past, doc], future: future.slice(1) });
    fixSelection();
    void api.saveDoc(next);
  },

  setView(v) {
    set({ view: v, selected: null });
  },
  select(wuid) {
    set({ selected: wuid });
  },
  setConnectOpen(open) {
    set({ connectOpen: open });
  },

  toast(t) {
    const id = uid("t");
    set({ toasts: [...get().toasts, { ...t, id }].slice(-4) });
    setTimeout(() => get().dismissToast(id), t.kind === "error" ? 7000 : 3800);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  async loadCatalog() {
    const req = <T,>(act: number, data?: unknown) => api.request<T>(act, data).catch(() => null);
    const [apps, triggers, devices] = await Promise.all([
      req<BarApp[]>(ACT.getAppList),
      req<{ triggers: TriggerType[] }>(ACT.triggerCatalog),
      req<unknown[]>(ACT.getDevices),
    ]);
    set({
      catalog: {
        apps: Array.isArray(apps) ? apps : [],
        triggers: triggers?.triggers ?? [],
        devices: (Array.isArray(devices) ? devices : []).flatMap((d) => {
          const o = d as Record<string, unknown>;
          const id = String(o.id ?? o.entityId ?? "");
          const deviceType = String(o.deviceType ?? o.type ?? "");
          return id && deviceType ? [{ id, name: String(o.name ?? id), deviceType }] : [];
        }),
        loaded: true,
      },
    });
  },

  async loadMarket(force) {
    const m = get().market;
    if (m.state === "loading" || (m.state === "ready" && !force)) return;
    set({ market: { ...m, state: "loading", error: undefined } });
    try {
      const [apps, plugins] = await Promise.all([api.storeApps(), api.storePlugins()]);
      set({ market: { apps, plugins, state: "ready" } });
    } catch (e) {
      set({ market: { ...get().market, state: "error", error: errorMessage(e) } });
    }
  },

  async installApp(pkg, name) {
    if (Object.keys(get().appJobs).length) return;
    setJob(pkg, { name, phase: "starting" });
    try {
      // The bar answers right away, then reports progress (act 30601).
      await api.request(ACT.appManager, { type: 1, appType: APP_TYPE, packageName: pkg }, 15000);
    } catch (e) {
      setJob(pkg, null);
      get().toast({ kind: "error", title: `Couldn't install ${name}`, body: errorMessage(e) });
    }
  },

  async uninstallApp(pkg, name) {
    if (Object.keys(get().appJobs).length) return;
    setJob(pkg, { name, phase: "uninstalling" });
    try {
      await api.request(ACT.appManager, { type: 2, packageName: pkg }, 30000);
      get().toast({ kind: "success", title: `Removed ${name} from the bar` });
    } catch (e) {
      get().toast({ kind: "error", title: `Couldn't remove ${name}`, body: errorMessage(e) });
    } finally {
      setJob(pkg, null);
      void get().loadCatalog();
    }
  },

  async runDeploy() {
    if (get().deploy.phase === "running") return;
    const doc = get().doc;
    let step = "Preparing";
    const progress = (s: string) => {
      step = s;
      set({ deploy: { phase: "running", step: s } });
    };
    progress("Preparing");
    const warnings: string[] = [];
    try {
      const published = new Map<string, string>();
      const publish = async (png: string) => {
        if (!published.has(png)) published.set(png, await api.publishIcon(png));
        return published.get(png)!;
      };
      const plan = await buildPlan(
        doc,
        async (w) => {
          if (!w.icon) return undefined;
          return w.icon.kind === "url" ? w.icon.url : publish(w.icon.png);
        },
        async (w) => {
          const fallback = w.type === "PC_CONTROL" && w.pc ? PC_ACTIONS[w.pc.action].glyph : w.type === "HOT_KEY_GROUP" ? "layout-grid" : "layers";
          const icon = w.icon?.kind === "url" ? w.icon.url : w.icon?.png ?? (await glyphPng(fallback, "#ffffff"));
          return publish(await cardArtPng(w.bgColor ?? "#24252b", icon, w.iconScale));
        },
        publish,
      );

      // Firmware 1.0.9 moved the batch scene save to 30500 and accepts an
      // empty list (which clears removed automations); older firmware didn't.
      const legacy = firmwareBefore(get().status.bar?.ver, "1.0.9");
      const scenesAct = legacy ? ACT.saveScenesLegacy : ACT.saveScenes;
      const sendScenes = plan.scenes.length > 0 || !legacy;
      // Each message must fit in one line; check before sending anything so
      // a failed deploy doesn't leave the bar half-updated.
      if (sendScenes && !fitsOneLine(scenesAct, plan.scenes)) {
        throw new Error(`Your multi-actions and automations are too large to send in one go (${kb(lineSize(scenesAct, plan.scenes))} of 8 KB). Remove a few actions and try again.`);
      }
      if (!fitsOneLine(ACT.saveProfiles, plan.profiles)) {
        throw new Error(`Your profiles are too large to send in one go (${kb(lineSize(ACT.saveProfiles, plan.profiles))} of 8 KB). Remove a few cards, actions or shortcut-group buttons, or shorten long names, commands and text.`);
      }

      if (plan.modules) {
        progress("Sending modules");
        await api.request(ACT.coreBarConfig, plan.modules);
      }
      if (plan.appConfigs.length) {
        progress("Sending integrations");
        for (const cfg of plan.appConfigs) {
          await api.request(ACT.appConfig, cfg, 10000).catch((e) => {
            const name = cfg.packageName.endsWith("weather") ? "Weather" : "Home Assistant";
            warnings.push(`${name}: ${errorMessage(e)}`);
          });
        }
      }
      if (sendScenes) {
        progress("Sending actions and automations");
        await api.request(scenesAct, plan.scenes, 10000);
      }
      progress("Sending profiles");
      await api.request(ACT.saveProfiles, plan.profiles, 10000);
      await api.setAllowedActions(plan.allowed);

      // The bar keeps showing its previous profile id, which may no longer
      // exist; show the profile being edited (or the default one). Firmware
      // 1.0.9 also doesn't redraw after a save, so ask it to.
      const view = get().view;
      const showId = view.kind === "profile" ? view.id : (doc.profiles.find((p) => p.isDefault) ?? doc.profiles[0]).id;
      await api.request(ACT.switchProfile, showId).catch(() => {});
      await api.refreshScreen().catch(() => {});

      const serial = get().status.bar?.serialNo;
      const hash = docHash(doc);
      // Record the deploy without adding an undo step.
      const cur = structuredClone(get().doc);
      cur.deployedHash = hash;
      cur.deployedAt = Date.now();
      cur.deployedTo = serial;
      set({ doc: cur, deploy: { phase: "done", at: Date.now(), warnings } });
      void api.saveDoc(cur);
      if (warnings.length) get().toast({ kind: "error", title: "Deployed with warnings", body: warnings.join("\n") });
      else get().toast({ kind: "success", title: "Deployed to your bar" });
    } catch (e) {
      const message = errorMessage(e);
      set({ deploy: { phase: "error", message, step } });
      get().toast({ kind: "error", title: `Deploy failed while ${step.toLowerCase()}`, body: message });
    }
  },

  async showProfileOnBar(id) {
    try {
      await api.request(ACT.switchProfile, id);
    } catch (e) {
      get().toast({ kind: "error", title: "Couldn't switch profile", body: errorMessage(e) });
    }
  },

  addProfile() {
    const id = "profile_" + uid();
    const n = get().doc.profiles.length + 1;
    get().update((d) => {
      d.profiles.push({ id, name: `Profile ${n}`, isDefault: false, showName: true, widgets: [] });
    });
    set({ view: { kind: "profile", id }, selected: null });
    return id;
  },
  duplicateProfile(id) {
    const nid = "profile_" + uid();
    get().update((d) => {
      const i = d.profiles.findIndex((p) => p.id === id);
      if (i < 0) return;
      const copy = structuredClone(d.profiles[i]);
      copy.id = nid;
      copy.name = `${copy.name} copy`;
      copy.isDefault = false;
      copy.widgets = copy.widgets.map((w) => ({ ...w, uid: uid("w") }));
      d.profiles.splice(i + 1, 0, copy);
    });
    set({ view: { kind: "profile", id: nid }, selected: null });
  },
  deleteProfile(id) {
    const doc = get().doc;
    if (doc.profiles.length <= 1) return;
    const i = doc.profiles.findIndex((p) => p.id === id);
    get().update((d) => {
      const wasDefault = d.profiles[i].isDefault;
      d.profiles.splice(i, 1);
      if (wasDefault) d.profiles[0].isDefault = true;
    });
    const next = get().doc.profiles[Math.max(0, i - 1)];
    set({ view: { kind: "profile", id: next.id }, selected: null });
  },

  addWidget(profileId, w, index) {
    get().update((d) => {
      const p = d.profiles.find((x) => x.id === profileId);
      if (!p) return;
      p.widgets.splice(index ?? p.widgets.length, 0, w);
    });
    set({ selected: w.uid });
  },
  updateWidget(wuid, mutate, coalesce, silent) {
    get().update((d) => {
      const f = findWidget(d, wuid);
      if (f) mutate(f.widget);
    }, coalesce ? `${wuid}:${coalesce}` : undefined, silent);
  },
  removeWidget(wuid) {
    get().update((d) => {
      const f = findWidget(d, wuid);
      if (f) f.profile.widgets.splice(f.index, 1);
    });
    if (get().selected === wuid) set({ selected: null });
  },
  duplicateWidget(wuid) {
    const f = findWidget(get().doc, wuid);
    if (!f) return;
    const copy = { ...structuredClone(f.widget), uid: uid("w") };
    get().addWidget(f.profile.id, copy, f.index + 1);
  },
  moveWidget(profileId, from, to) {
    get().update((d) => {
      const p = d.profiles.find((x) => x.id === profileId);
      if (!p) return;
      const [w] = p.widgets.splice(from, 1);
      p.widgets.splice(to, 0, w);
    });
  },

  addAutomation() {
    const a: Automation = { id: uid("auto_"), name: "New automation", enabled: true, triggers: [], actions: [] };
    get().update((d) => d.automations.push(a));
    set({ view: { kind: "automations", id: a.id } });
    return a.id;
  },
}));

function setJob(pkg: string, job: Omit<AppJob, "at"> | null) {
  const jobs = { ...useApp.getState().appJobs };
  if (job) jobs[pkg] = { ...job, at: Date.now() };
  else delete jobs[pkg];
  useApp.setState({ appJobs: jobs });
}

function appName(pkg: string): string {
  const s = useApp.getState();
  return s.appJobs[pkg]?.name
    ?? s.catalog.apps.find((a) => a.application === pkg)?.appName
    ?? s.market.apps.find((a) => a.application === pkg)?.appName
    ?? pkg;
}

/** Install progress (act 30601): `{packageName, type: DOWNLOAD|INSTALL, result: 1–100}`
 * or `{packageName, type: STATUS, result: DOWNLOADING|INSTALLING|INSTALLED|FAIL}`.
 * The bar sends these to every connected computer, so installs started
 * elsewhere show up too. */
function onAppEvent(data: unknown) {
  const d = (data ?? {}) as { packageName?: string; type?: string; result?: unknown };
  const pkg = d.packageName;
  if (!pkg) return;
  const s = useApp.getState();
  const name = appName(pkg);
  const job = s.appJobs[pkg];
  if (d.type === "DOWNLOAD" || d.type === "INSTALL") {
    const progress = typeof d.result === "number" ? Math.max(0, Math.min(100, d.result)) : undefined;
    setJob(pkg, { name, phase: d.type === "DOWNLOAD" ? "downloading" : "installing", progress });
  } else if (d.type === "STATUS") {
    if (d.result === "DOWNLOADING") setJob(pkg, { name, phase: "downloading", progress: job?.phase === "downloading" ? job.progress : undefined });
    else if (d.result === "INSTALLING") setJob(pkg, { name, phase: "installing" });
    else if (d.result === "INSTALLED" || d.result === "FAIL") {
      setJob(pkg, null);
      void s.loadCatalog();
      if (d.result === "INSTALLED") s.toast({ kind: "success", title: `${name} is installed on the bar` });
      else s.toast({ kind: "error", title: `The bar couldn't install ${name}`, body: "It may have lost its internet connection, or another app was installing. Try again." });
    }
  }
}

/** Clears installs the bar stopped reporting on (e.g. the connection dropped
 * before the last event) once it says it's no longer busy with them. */
async function checkAppJobs(quietFor: number) {
  const s = useApp.getState();
  if (s.status.state !== "online") return;
  for (const [pkg, job] of Object.entries(s.appJobs)) {
    if (job.phase === "uninstalling" || Date.now() - job.at < quietFor) continue;
    const r = await api.request<{ status?: string }>(ACT.appManager, { type: 0, packageName: pkg }).catch(() => null);
    if (r && r.status !== "INSTALLING" && r.status !== "DOWNLOADING" && useApp.getState().appJobs[pkg]?.at === job.at) {
      setJob(pkg, null);
      void useApp.getState().loadCatalog();
    }
  }
}

function fixSelection() {
  const { selected, doc, view } = useApp.getState();
  if (selected && !findWidget(doc, selected)) useApp.setState({ selected: null });
  if (view.kind === "profile" && !doc.profiles.some((p) => p.id === view.id)) {
    useApp.setState({ view: { kind: "profile", id: doc.profiles[0].id } });
  }
}
