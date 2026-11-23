// "App action" (APP_CAPABILITY): an action that an app on the bar offers.
// Pick the app (the options of the bar's own "App Capability" node, act 1205),
// then one of its actions (act 30750), then fill in the action's params (act
// 30751): text, a fixed list, or a list the app pages through (act 30752).
// Needs the bar online; a saved action reads the same offline because names
// and labels are kept with it.
import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ACT, api, errorMessage } from "../lib/api";
import type { AppCapability } from "../lib/model";
import { useApp, type TreeNode } from "../lib/store";
import { Button, Field, Spinner } from "./ui";

export interface CapAction {
  id: string;
  name: string;
  desc?: string;
}

export interface CapOption {
  label: string;
  value: string;
}

export interface CapParam {
  id: string;
  name: string;
  /** TEXT, TEXTAREA, NUMBER, BOOLEAN, SELECT or MULTI_SELECT (the launcher's
   * plugin protocol). */
  type?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  options?: { provider?: "STATIC" | "REMOTE" | string; items?: CapOption[] } | null;
  /** Ids of params whose value this one's options depend on. */
  dependsOn?: string[];
}

/** One page of a REMOTE param's options. */
interface OptionsPage {
  items: CapOption[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

/** Options fetched per page, as the official app asks. */
export const OPTIONS_PAGE = 20;

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** 30750 → `[{actionId, name, description, features}]` (only actions the
 * app can be called for). */
function parseActions(r: unknown): CapAction[] {
  const list = Array.isArray(r) ? r : [];
  return list.flatMap((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const id = str(o.actionId ?? o.id);
    return id ? [{ id, name: str(o.name) || id, desc: str(o.description) || undefined }] : [];
  });
}

function parseOptions(list: unknown): CapOption[] {
  return (Array.isArray(list) ? list : []).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const value = str(o.value ?? o.id);
    return value ? [{ value, label: str(o.label ?? o.name) || value }] : [];
  });
}

function parseParams(r: unknown): CapParam[] {
  const list = Array.isArray(r) ? r : [];
  return list.flatMap((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    if (!id) return [];
    const opts = (o.options ?? null) as Record<string, unknown> | null;
    return [{
      id, name: str(o.name) || id, type: str(o.type) || undefined, placeholder: str(o.placeholder) || undefined,
      required: !!o.required, maxLength: typeof o.maxLength === "number" && o.maxLength > 0 ? o.maxLength : undefined,
      options: opts ? { provider: str(opts.provider) || undefined, items: parseOptions(opts.items) } : null,
      dependsOn: Array.isArray(o.dependsOn) ? o.dependsOn.map(str).filter(Boolean) : [],
    }];
  });
}

/** 30752 passes the app's answer through: `{success, error?, items,
 * nextCursor, hasMore}`. An app's own error comes back as a reply with
 * `success: false`. */
function parsePage(r: unknown): OptionsPage {
  const o = (r ?? {}) as Record<string, unknown>;
  if (o.success === false) {
    const err = (o.error ?? {}) as Record<string, unknown>;
    throw new Error(str(err.message) || str(err.code) || "The app couldn't list the options.");
  }
  return { items: parseOptions(o.items), nextCursor: typeof o.nextCursor === "string" ? o.nextCursor : null, hasMore: !!o.hasMore };
}

/** Params typed in rather than picked. The official app shows a text field
 * for TEXT only and a list for everything else; long text and numbers get a
 * fitting field here. */
const TYPED = new Set(["TEXT", "TEXTAREA", "NUMBER"]);
export const isText = (p: CapParam) => TYPED.has(p.type ?? "TEXT");
export const isRemote = (p: CapParam) => !isText(p) && p.options?.provider === "REMOTE";

/** The values of the params `p` depends on: all 30752 sends as `params`. */
function dependsValues(p: CapParam, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries((p.dependsOn ?? []).map((d) => [d, values[d] ?? ""]));
}

/** "Notes → New note (Title: Groceries; Folder: Home)". */
export function capabilitySummary(c: AppCapability): string {
  const parts = Object.entries(c.params)
    .filter(([, v]) => v !== "")
    .map(([id, v]) => {
      const l = c.labels?.[id];
      return `${l?.name ?? id}: ${l?.value ?? v}`;
    });
  return `${c.appName} → ${c.actionName}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

/** Whether every required param has a value. */
export function capabilityComplete(c: AppCapability | null, params: CapParam[]): boolean {
  return !!c && !!c.actionId && params.every((p) => !p.required || !!c.params[p.id]);
}

/** Apps that offer actions: the options of the bar's "App Capability" node
 * (one per app that's running its capability service). A node restored from
 * a saved action has none, so ask the bar for it again. */
function useCapabilityApps(node: TreeNode, online: boolean, reload: number): CapOption[] | "loading" {
  const own = useMemo(() => parseOptions(node.components?.[0]?.options), [node]);
  const [fetched, setFetched] = useState<CapOption[] | "loading">("loading");
  useEffect(() => {
    if (!online || (own.length && !reload)) return;
    let cancelled = false;
    setFetched("loading");
    api.request<TreeNode[]>(ACT.actionTree, "sc.other").then(
      (nodes) => {
        const n = (Array.isArray(nodes) ? nodes : []).find((x) => x.type === "APP_CAPABILITY");
        if (!cancelled) setFetched(parseOptions(n?.components?.[0]?.options));
      },
      () => !cancelled && setFetched([]),
    );
    return () => { cancelled = true; };
  }, [online, own, reload]);
  return own.length && !reload ? own : fetched;
}

export function AppCapabilityForm({ node, value, onChange }: {
  /** The bar's APP_CAPABILITY node (id "capability", under "Other"). */
  node: TreeNode;
  value: AppCapability | null;
  onChange: (c: AppCapability | null, params: CapParam[]) => void;
}) {
  const online = useApp((s) => s.status.state === "online");
  const [reload, setReload] = useState(0);
  const appList = useCapabilityApps(node, online, reload);
  const apps = appList === "loading" ? [] : appList;
  const [pkg, setPkg] = useState(value?.packageName ?? "");
  const [actions, setActions] = useState<CapAction[] | "loading" | { error: string } | null>(null);
  const [params, setParams] = useState<CapParam[] | "loading" | { error: string } | null>(null);
  const [cur, setCur] = useState<AppCapability | null>(value);

  const appName = (p: string) => apps.find((a) => a.value === p)?.label ?? (value?.packageName === p ? value.appName : p);

  // Like the official app, start with the first app.
  useEffect(() => {
    if (!pkg && apps.length) setPkg(apps[0].value);
  }, [pkg, apps]);

  // Actions of the picked app.
  useEffect(() => {
    if (!online || !pkg) return;
    let cancelled = false;
    setActions("loading");
    api.request(ACT.appActions, pkg, 10000).then(
      (r) => !cancelled && setActions(parseActions(r)),
      (e) => !cancelled && setActions({ error: errorMessage(e) }),
    );
    return () => { cancelled = true; };
  }, [online, pkg, reload]);

  // Params of the picked action.
  const actionId = cur?.packageName === pkg ? cur.actionId : "";
  useEffect(() => {
    if (!online || !pkg || !actionId) {
      setParams(null);
      return;
    }
    let cancelled = false;
    setParams("loading");
    api.request(ACT.appActionParams, { actionId, packageName: pkg }, 10000).then(
      (r) => !cancelled && setParams(parseParams(r)),
      (e) => !cancelled && setParams({ error: errorMessage(e) }),
    );
    return () => { cancelled = true; };
  }, [online, pkg, actionId, reload]);

  const paramList = Array.isArray(params) ? params : [];
  const update = (next: AppCapability | null) => {
    setCur(next);
    onChange(next, paramList);
  };
  useEffect(() => {
    if (Array.isArray(params)) onChange(cur, params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  if (!online) {
    return (
      <>
        {value ? <SavedSummary c={value} /> : null}
        <p className="muted" style={{ margin: 0 }}>Connect to your bar to {value ? "change this action" : "see what its apps can do"}.</p>
      </>
    );
  }

  const pickApp = (p: string) => {
    setPkg(p);
    update(null);
  };
  const pickAction = (a: CapAction) =>
    update({ packageName: pkg, appName: appName(pkg), actionId: a.id, actionName: a.name, params: {}, labels: {} });

  const setParam = (p: CapParam, v: string, label?: string) => {
    if (!cur) return;
    const params = { ...cur.params, [p.id]: v };
    const labels = { ...cur.labels, [p.id]: { name: p.name, value: label ?? v } };
    // Params that depend on this one start over.
    for (const q of paramList) {
      if (q.dependsOn?.includes(p.id)) {
        delete params[q.id];
        delete labels[q.id];
      }
    }
    if (!v) {
      delete params[p.id];
      delete labels[p.id];
    }
    update({ ...cur, params, labels });
  };

  return (
    <>
      <Field label="App" aside={appList === "loading" ? <Spinner /> : <Button variant="ghost" icon size="sm" title="Reload" onClick={() => setReload((n) => n + 1)}><RefreshCw size={12} /></Button>}
        error={appList !== "loading" && !apps.length ? "No app on the bar offers actions right now. Apps list them while they're running." : undefined}>
        <select className="select" value={pkg} onChange={(e) => pickApp(e.target.value)} disabled={!apps.length && !pkg}>
          <option value="" disabled>Choose…</option>
          {pkg && !apps.some((a) => a.value === pkg) && <option value={pkg}>{appName(pkg)}</option>}
          {apps.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </Field>
      {pkg && (
        <Field label="Action" error={actions && !Array.isArray(actions) && actions !== "loading" ? actions.error : Array.isArray(actions) && !actions.length ? "This app doesn't offer any actions." : undefined}>
          {actions === "loading" ? <Spinner /> : Array.isArray(actions) && actions.length > 0 && (
            <div className="pick-list" role="listbox" aria-label="Action">
              {actions.map((a) => (
                <button key={a.id} type="button" role="option" aria-selected={actionId === a.id} onClick={() => actionId !== a.id && pickAction(a)}>
                  <span className="txt"><b className="truncate">{a.name}</b>{a.desc && <span>{a.desc}</span>}</span>
                </button>
              ))}
            </div>
          )}
        </Field>
      )}
      {actionId && (params === "loading" ? <Spinner /> : params && !Array.isArray(params) ? (
        <div className="callout warn"><div>Couldn't load this action's settings: {params.error}</div></div>
      ) : paramList.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>Nothing else to set up.</p>
      ) : (
        paramList.map((p) => (
          <ParamField key={p.id} p={p} cap={cur!} all={paramList} onChange={(v, label) => setParam(p, v, label)} />
        ))
      ))}
    </>
  );
}

function SavedSummary({ c }: { c: AppCapability }) {
  return (
    <div className="group">
      <div className="group-row"><div className="txt"><span>App</span><b>{c.appName}</b></div></div>
      <div className="group-row"><div className="txt"><span>Action</span><b>{c.actionName}</b></div></div>
      {Object.entries(c.params).map(([id, v]) => (
        <div className="group-row" key={id}><div className="txt"><span>{c.labels?.[id]?.name ?? id}</span><b>{c.labels?.[id]?.value ?? v}</b></div></div>
      ))}
    </div>
  );
}

function ParamField({ p, cap, all, onChange }: { p: CapParam; cap: AppCapability; all: CapParam[]; onChange: (v: string, label?: string) => void }) {
  const value = cap.params[p.id] ?? "";
  const label = p.name + (p.required ? "" : " (optional)");
  const waitingFor = (p.dependsOn ?? []).map((d) => all.find((x) => x.id === d)).filter((d): d is CapParam => !!d && !cap.params[d.id]);

  if (isText(p)) {
    const number = p.type === "NUMBER";
    const bad = number && value !== "" && Number.isNaN(Number(value));
    return (
      <Field label={label} error={bad ? "Enter a number" : undefined}>
        {p.type === "TEXTAREA" ? (
          <textarea className="textarea" rows={3} value={value} placeholder={p.placeholder} maxLength={p.maxLength} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input className="input" value={value} placeholder={p.placeholder} maxLength={p.maxLength} inputMode={number ? "decimal" : undefined}
            spellCheck={false} onChange={(e) => onChange(e.target.value)} />
        )}
      </Field>
    );
  }
  if (waitingFor.length) {
    return (
      <Field label={label}>
        <select className="select" disabled value=""><option value="">Choose “{waitingFor[0].name}” first</option></select>
      </Field>
    );
  }
  if (isRemote(p)) return <RemoteParam p={p} cap={cap} label={label} value={value} onChange={onChange} />;
  // A yes/no param without its own list gets one; what such an app expects
  // hasn't been seen yet.
  const items = p.options?.items?.length ? p.options.items : p.type === "BOOLEAN" ? [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] : [];
  return (
    <Field label={label} error={!items.length ? "No options." : undefined}>
      <select className="select" value={value} disabled={!items.length}
        onChange={(e) => onChange(e.target.value, items.find((o) => o.value === e.target.value)?.label)}>
        <option value="">{p.required ? "Choose…" : "None"}</option>
        {items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  );
}

/** A param whose options the app pages through (act 30752). Asked again
 * when a param it depends on changes. */
function RemoteParam({ p, cap, label, value, onChange }: { p: CapParam; cap: AppCapability; label: string; value: string; onChange: (v: string, label?: string) => void }) {
  const [items, setItems] = useState<CapOption[]>([]);
  const [next, setNext] = useState<{ cursor: string | null; more: boolean }>({ cursor: null, more: false });
  const [state, setState] = useState<"loading" | "ready" | { error: string }>("loading");
  // The values this param's options depend on (all that 30752 is sent).
  const deps = JSON.stringify(dependsValues(p, cap.params));

  // As the official app asks: the first page with an empty cursor, then the
  // reply's `nextCursor` for "More".
  const load = async (cursor: string) => {
    setState("loading");
    try {
      const r = parsePage(await api.request(ACT.appParamOptions, {
        actionId: cap.actionId, packageName: cap.packageName, describeId: p.id, cursor, limit: OPTIONS_PAGE, params: JSON.parse(deps),
      }, 10000));
      setItems((old) => (cursor ? [...old, ...r.items] : r.items));
      setNext({ cursor: r.nextCursor ?? null, more: !!r.hasMore });
      setState("ready");
    } catch (e) {
      setState({ error: errorMessage(e) });
    }
  };

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cap.actionId, cap.packageName, p.id, deps]);

  const saved = value && !items.some((o) => o.value === value) ? cap.labels?.[p.id]?.value ?? value : null;
  return (
    <Field label={label} error={typeof state === "object" ? state.error : state === "ready" && !items.length ? "No options." : undefined}
      aside={state === "loading" ? <Spinner /> : null}>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value, items.find((o) => o.value === e.target.value)?.label)}>
        <option value="">{p.required ? "Choose…" : "None"}</option>
        {saved && <option value={value}>{saved}</option>}
        {items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {next.more && state === "ready" && (
        <div><Button size="sm" variant="ghost" onClick={() => void load(next.cursor ?? "")}>More</Button></div>
      )}
    </Field>
  );
}
