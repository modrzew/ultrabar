import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Trash2, Workflow, X, Zap } from "lucide-react";
import { useApp, type ParamMeta, type TriggerType } from "../lib/store";
import type { Automation, Trigger } from "../lib/model";
import { uid } from "../lib/model";
import { api } from "../lib/api";
import { tr, triggerTitle } from "../lib/i18n";
import { ActionList } from "../components/Actions";
import { Button, Empty, Field, InlineInput, Modal, Spinner, Switch } from "../components/ui";

export function AutomationsView() {
  const view = useApp((s) => s.view);
  const id = view.kind === "automations" ? view.id : undefined;
  const exists = useApp((s) => s.doc.automations.some((a) => a.id === id));
  return id && exists ? <AutomationEditor id={id} /> : <AutomationList />;
}

function AutomationList() {
  const automations = useApp((s) => s.doc.automations);
  const s = useApp.getState();
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1>Automations</h1>
            <p>Let the bar react on its own: switch profiles, start a timer or run actions when something happens.</p>
          </div>
          {automations.length > 0 && <Button variant="primary" onClick={() => s.addAutomation()}><Plus size={14} /> New automation</Button>}
        </div>
        {automations.length === 0 ? (
          <div className="group">
            <Empty icon={<Workflow size={24} />} title="No automations yet"
              action={<Button variant="primary" onClick={() => s.addAutomation()}><Plus size={14} /> Create automation</Button>}>
              For example: when the bar switches to your Focus profile, start a 25‑minute timer.
            </Empty>
          </div>
        ) : (
          <div className="group">
            {automations.map((a) => (
              <div key={a.id} className="group-row click" onClick={() => s.setView({ kind: "automations", id: a.id })}>
                <span className="ico"><Zap size={16} /></span>
                <div className="txt">
                  <b>{a.name}</b>
                  <dl className="when-then" style={{ margin: "4px 0 0" }}>
                    <dt>When</dt><dd>{a.triggers.map((t) => `${triggerTitle(t.type)}: ${t.summary}`).join(" or ") || "No trigger yet"}</dd>
                    <dt>Then</dt><dd>{a.actions.map((x) => x.summary).join(", then ") || "No actions yet"}</dd>
                  </dl>
                </div>
                <span onClick={(e) => e.stopPropagation()}>
                  <Switch checked={a.enabled} label="Enabled" onChange={(v) => s.update((d) => { d.automations.find((x) => x.id === a.id)!.enabled = v; })} />
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>Automations run on the bar itself and are sent with Deploy.</p>
      </div>
    </div>
  );
}

function AutomationEditor({ id }: { id: string }) {
  const a = useApp((s) => s.doc.automations.find((x) => x.id === id))!;
  const s = useApp.getState();
  const [picking, setPicking] = useState(false);
  const set = (mut: (a: Automation) => void) => s.update((d) => mut(d.automations.find((x) => x.id === id)!));
  return (
    <div className="page">
      <div className="page-inner">
        <div className="row">
          <Button variant="ghost" size="sm" onClick={() => s.setView({ kind: "automations" })}><ArrowLeft size={14} /> Automations</Button>
        </div>
        <div className="page-head" style={{ alignItems: "center" }}>
          <div className="grow editor-head" style={{ padding: 0 }}>
            <InlineInput className="name-input" value={a.name} onCommit={(v) => set((x) => { x.name = v; })} />
          </div>
          <span className="row muted" style={{ gap: 8 }}>
            {a.enabled ? "On" : "Off"}
            <Switch checked={a.enabled} onChange={(v) => set((x) => { x.enabled = v; })} label="Enabled" />
          </span>
          <Button variant="ghost" icon className="danger" title="Delete automation"
            onClick={() => { s.update((d) => { d.automations = d.automations.filter((x) => x.id !== id); }); s.setView({ kind: "automations" }); }}>
            <Trash2 size={15} />
          </Button>
        </div>

        <section>
          <h3 className="section-title">When</h3>
          <div className="action-list">
            {a.triggers.map((t) => (
              <div className="action-row" key={t.uid}>
                <span className="ico" style={{ marginLeft: 4 }}><Zap size={14} /></span>
                <span className="txt"><b>{triggerTitle(t.type)}</b><span>{t.summary}</span></span>
                <Button variant="ghost" icon size="sm" aria-label="Remove trigger" onClick={() => set((x) => { x.triggers = x.triggers.filter((y) => y.uid !== t.uid); })}><X size={13} /></Button>
              </div>
            ))}
            <button type="button" className="add-row" onClick={() => setPicking(true)}><Plus size={14} /> {a.triggers.length ? "Add another trigger" : "Add trigger"}</button>
          </div>
          {a.triggers.length > 1 && <p className="faint" style={{ fontSize: 12, margin: "6px 2px 0" }}>Any one of these triggers starts the automation.</p>}
        </section>

        <section>
          <h3 className="section-title">Then</h3>
          <ActionList actions={a.actions} onChange={(actions) => set((x) => { x.actions = actions; })} />
        </section>
      </div>
      {picking && <TriggerPicker onClose={() => setPicking(false)} onAdd={(t) => { set((x) => { x.triggers.push(t); }); setPicking(false); }} />}
    </div>
  );
}

type Opt = { label: string; value: string };

function TriggerPicker({ onClose, onAdd }: { onClose: () => void; onAdd: (t: Trigger) => void }) {
  const types = useApp((s) => s.catalog.triggers);
  const online = useApp((s) => s.status.state === "online");
  const loaded = useApp((s) => s.catalog.loaded);
  const [type, setType] = useState<TriggerType | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!type && types.length) setType(types.find((t) => t.type === "PROFILE") ?? types[0]);
  }, [types, type]);

  const missing = type?.params.filter((p) => p.required && !params[p.key]) ?? [];
  const violation = type?.validations?.find((v) => v.rule === "NOT_EQUAL" && v.fields.every((f) => params[f]) && new Set(v.fields.map((f) => params[f])).size === 1);

  const add = () => {
    if (!type) return;
    onAdd({ uid: uid("t"), type: type.type, params, summary: triggerSummary(type, params, labels) });
  };

  return (
    <Modal wide title="Add a trigger" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!type || missing.length > 0 || !!violation} onClick={add}>Add trigger</Button></>}>
      {!online ? (
        <Empty icon={<Zap size={22} />} title="Connect to your bar">The bar provides the list of triggers it supports.</Empty>
      ) : !loaded ? (
        <div className="empty"><Spinner /></div>
      ) : (
        <div className="picker" style={{ margin: "0 -18px -18px", height: "calc(100% + 18px)" }}>
          <div className="picker-tree">
            {types.map((t) => (
              <button key={t.type} type="button" className="tree-item" aria-selected={type?.type === t.type}
                onClick={() => { setType(t); setParams({}); setLabels({}); }}>
                <Zap size={14} />
                <span className="truncate">{triggerTitle(t.type, t.name)}</span>
              </button>
            ))}
          </div>
          <div className="picker-form">
            {type && (
              <>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{triggerTitle(type.type, type.name)}</div>
                  {type.desc && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{tr(type.desc)}</div>}
                </div>
                {type.params.map((p) => (
                  <ParamField key={`${type.type}:${p.key}`} p={p} params={params}
                    onChange={(v, label) => {
                      setParams((s) => {
                        const next = { ...s, [p.key]: v };
                        // Clear fields that depend on this one.
                        for (const q of type.params) if (q.dataSource?.dependsOn?.includes(p.key)) delete next[q.key];
                        return next;
                      });
                      setLabels((s) => ({ ...s, [p.key]: label }));
                    }} />
                ))}
                {violation && <div className="callout warn">“{tr(type.params.find((p) => p.key === violation.fields[0])?.label)}” and “{tr(type.params.find((p) => p.key === violation.fields[1])?.label)}” can't be the same.</div>}
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function ParamField({ p, params, onChange }: { p: ParamMeta; params: Record<string, string>; onChange: (v: string, label: string) => void }) {
  const profiles = useApp((s) => s.doc.profiles);
  const deps = p.dataSource?.dependsOn ?? [];
  const blockedBy = deps.find((d) => !params[d]);
  const depKey = deps.map((d) => params[d]).join("|");
  const [opts, setOpts] = useState<Opt[] | null>(null);
  const [loading, setLoading] = useState(false);

  const act = p.dataSource?.act;
  const local = useMemo<Opt[] | null>(() => (act === 30710 ? profiles.map((x) => ({ label: x.name, value: x.id })) : null), [act, profiles]);

  useEffect(() => {
    if (!act || local || blockedBy) return;
    let cancelled = false;
    setLoading(true);
    const data = deps.length ? Object.fromEntries(deps.map((d) => [d, params[d]])) : {};
    api.request<Opt[]>(act, data)
      .then((r) => !cancelled && setOpts((Array.isArray(r) ? r : []).map((o) => ({ label: tr(o.label), value: String(o.value) }))))
      .catch(() => !cancelled && setOpts([]))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act, local, blockedBy, depKey]);

  const label = tr(p.label);
  const options = local ?? opts ?? p.options?.map((o) => ({ label: tr(o.label), value: o.value }));
  if (act || options) {
    const list = options ?? [];
    return (
      <Field label={label}
        hint={blockedBy ? `Choose “${tr(blockedBy === "id" ? "设备" : blockedBy === "property" ? "状态属性" : blockedBy)}” first.` : undefined}
        error={!blockedBy && !loading && options && !list.length ? (act === 30701 ? "No devices are connected to the bar." : act === 30720 ? "No apps found on the bar." : "Nothing to choose from.") : undefined}>
        <select className="select" value={params[p.key] ?? ""} disabled={!!blockedBy || loading || !list.length}
          onChange={(e) => onChange(e.target.value, list.find((o) => o.value === e.target.value)?.label ?? e.target.value)}>
          <option value="" disabled>{loading ? "Loading…" : "Choose…"}</option>
          {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
    );
  }
  return (
    <Field label={label}>
      <input className="input" value={params[p.key] ?? ""} onChange={(e) => onChange(e.target.value, e.target.value)} />
    </Field>
  );
}

function triggerSummary(t: TriggerType, params: Record<string, string>, labels: Record<string, string>): string {
  const l = (k: string) => labels[k] ?? params[k] ?? "?";
  switch (t.type) {
    case "PROFILE": return `From ${l("from")} to ${l("to")}`;
    case "APP_STATE": return `${l("package")} · ${l("in").toLowerCase()}`;
    case "DEVICE_STATE": return `${l("id")} · ${l("property")}: ${l("from")} → ${l("to")}`;
    case "NUMERIC": return `${l("id")} · ${l("property")} between ${l("above")} and ${l("below")}`;
    default: return t.params.map((p) => `${tr(p.label)}: ${l(p.key)}`).join(", ");
  }
}
