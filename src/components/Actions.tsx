import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle, AppWindow, ChevronDown, ChevronRight, Command, Folder, GripVertical, Hourglass, LayoutGrid, Plus,
  RefreshCw, SunMedium, Timer, Waves, X, Zap,
} from "lucide-react";
import { ACT, api } from "../lib/api";
import { useApp, type Component, type TreeNode } from "../lib/store";
import type { Action, PcControl } from "../lib/model";
import { uid } from "../lib/model";
import { PC_ACTIONS, pcIsComplete, pcSummary } from "../lib/widgets";
import { tr } from "../lib/i18n";
import { Button, Field, Modal, Slider, Spinner } from "./ui";
import { PcControlEditor } from "./editors/PcControlEditor";

// Used when the bar is offline, so actions can still be edited. Mirrors the
// bar's own catalog (act 1205) for firmware 1.0.1.
const OFFLINE_ROOT: TreeNode[] = [
  { id: "sc.delay", last: true, name: "Delay", type: "DELAY", components: [{ id: "1", uiType: "INPUT", inputType: "INT", min: 1, max: 300, unit: "second" }] },
  { id: "profile", last: true, name: "Switch Profile", type: "CHANGE_PROFILE", objectName: "Corebar", components: [{ id: "1", uiType: "SELECT", inputType: "STR", options: [] }] },
  { id: "1", last: true, name: "PC Control", type: "PC_CONTROL", objectName: "Corebar" },
  { id: "sc.corebar", last: false, name: "CoreBar" },
  { id: "sc.other", last: false, name: "Other" },
];
const OFFLINE_CHILDREN: Record<string, TreeNode[]> = {
  "sc.corebar": [{ id: "bright", last: true, name: "Screen Brightness", type: "BRIGHT", objectName: "Corebar", components: [{ id: "corebar.bright", uiType: "SEEKBAR", inputType: "INT", min: 1, max: 100 }] }],
  "sc.other": [
    { id: "activity", last: true, name: "App Start", type: "ACTIVITY", objectName: "App", components: [{ id: "1", uiType: "SELECT", inputType: "STR", options: [] }] },
    { id: "sound", last: true, name: "Soundscape", type: "SOUND_SCAPE", objectName: "Soundscape", components: [{ id: "1", uiType: "SELECT", inputType: "STR", options: [
      { label: "Moonlit Serenade", value: "sys.app.soundscape.1" }, { label: "The Leviathan's Whisper", value: "sys.app.soundscape.2" },
      { label: "Hearth’s Lullaby", value: "sys.app.soundscape.3" }, { label: "Dusktide", value: "sys.app.soundscape.4" },
      { label: "HissBubble", value: "sys.app.soundscape.5" }, { label: "Sonata of Sunrise", value: "sys.app.soundscape.6" },
      { label: "Serenade of Droplets", value: "sys.app.soundscape.7" },
    ] }] },
    { id: "sound", last: true, name: "Timer", type: "TIMER", objectName: "Timer", components: [
      { id: "1", uiType: "INPUT", inputType: "STR", name: "定时器" },
      { id: "2", uiType: "SELECT", inputType: "STR", name: "动作", options: [
        { label: "启动", value: "START" }, { label: "暂停", value: "PAUSE" }, { label: "恢复暂停", value: "RESUM" },
        { label: "取消", value: "CANCEL" }, { label: "重启", value: "RESTART" },
      ] },
    ] },
  ],
};

const NAME: Record<string, string> = {
  DELAY: "Wait", CHANGE_PROFILE: "Switch profile", PC_CONTROL: "Computer action", BRIGHT: "Screen brightness",
  ACTIVITY: "Open app on the bar", SOUND_SCAPE: "Play soundscape", TIMER: "Control a timer",
};
const BRANCH_NAME: Record<string, string> = { "sc.corebar": "Bar", "sc.devices": "Devices", scene: "Scenes", "sc.other": "Other" };

export function actionIcon(a: { type?: string; pc?: PcControl }, size = 14): ReactNode {
  if (a.type === "PC_CONTROL") {
    const I = a.pc ? PC_ACTIONS[a.pc.action].icon : Command;
    return <I size={size} />;
  }
  const map: Record<string, ReactNode> = {
    DELAY: <Hourglass size={size} />, CHANGE_PROFILE: <LayoutGrid size={size} />, BRIGHT: <SunMedium size={size} />,
    ACTIVITY: <AppWindow size={size} />, SOUND_SCAPE: <Waves size={size} />, TIMER: <Timer size={size} />,
  };
  return map[a.type ?? ""] ?? <Zap size={size} />;
}

function nodeTitle(n: TreeNode) {
  return (n.type && NAME[n.type]) || BRANCH_NAME[n.id] || tr(n.name);
}

// ─────────────────────────── List ───────────────────────────

export function ActionList({ actions, onChange }: { actions: Action[]; onChange: (a: Action[]) => void }) {
  const [editing, setEditing] = useState<Action | "new" | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = actions.findIndex((a) => a.uid === e.active.id);
    const to = actions.findIndex((a) => a.uid === e.over!.id);
    onChange(arrayMove(actions, from, to));
  };
  return (
    <div className="action-list">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext items={actions.map((a) => a.uid)} strategy={verticalListSortingStrategy}>
          {actions.map((a) => (
            <ActionRow key={a.uid} a={a} onEdit={() => setEditing(a)} onRemove={() => onChange(actions.filter((x) => x.uid !== a.uid))} />
          ))}
        </SortableContext>
      </DndContext>
      <button type="button" className="add-row" onClick={() => setEditing("new")}><Plus size={14} /> Add action</button>
      {editing && (
        <ActionPicker
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={(a) => {
            onChange(editing === "new" ? [...actions, a] : actions.map((x) => (x.uid === a.uid ? a : x)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ActionRow({ a, onEdit, onRemove }: { a: Action; onEdit: () => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: a.uid });
  const incomplete = a.type === "PC_CONTROL" && !pcIsComplete(a.pc);
  return (
    <div
      ref={setNodeRef} className={`action-row${incomplete ? " warn" : ""}`} onClick={onEdit}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 2 : undefined, position: "relative" }}
    >
      <span className="handle" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()}><GripVertical size={14} /></span>
      <span className="ico">{actionIcon(a)}</span>
      <span className="txt">
        <b>{NAME[a.type] ?? tr(a.name)}</b>
        <span>{incomplete ? <><AlertTriangle size={10} style={{ color: "var(--warning)" }} /> Not set up yet</> : a.summary}</span>
      </span>
      <Button variant="ghost" icon size="sm" aria-label="Remove action" onClick={(e) => { e.stopPropagation(); onRemove(); }}><X size={13} /></Button>
    </div>
  );
}

// ─────────────────────────── Picker ───────────────────────────

function useTree() {
  const online = useApp((s) => s.status.state === "online");
  const [children, setChildren] = useState<Record<string, TreeNode[] | "loading" | "error">>({});
  const load = async (id: string, force = false) => {
    if (!force && children[id] && children[id] !== "error") return;
    if (!online) {
      setChildren((c) => ({ ...c, [id]: id === "" ? OFFLINE_ROOT : OFFLINE_CHILDREN[id] ?? [] }));
      return;
    }
    setChildren((c) => ({ ...c, [id]: "loading" }));
    try {
      const nodes = await api.request<TreeNode[]>(ACT.actionTree, id);
      setChildren((c) => ({ ...c, [id]: Array.isArray(nodes) ? nodes : [] }));
    } catch {
      setChildren((c) => ({ ...c, [id]: id === "" ? OFFLINE_ROOT : "error" }));
    }
  };
  return { children, load, online };
}

export function ActionPicker({ initial, onClose, onSave }: { initial?: Action; onClose: () => void; onSave: (a: Action) => void }) {
  const tree = useTree();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [node, setNode] = useState<TreeNode | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [pc, setPc] = useState<PcControl>(initial?.pc ?? { action: "startApp" });

  useEffect(() => {
    void tree.load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.online]);

  // When editing, select the matching node once the root loads.
  const root = tree.children[""];
  useEffect(() => {
    if (!initial || node || !Array.isArray(root)) return;
    const all = [...root, ...Object.values(tree.children).flatMap((c) => (Array.isArray(c) ? c : []))];
    const match = all.find((n) => n.last && n.type === initial.type && n.id === initial.nodeId) ?? all.find((n) => n.last && n.type === initial.type);
    const restored: TreeNode = match ?? { id: initial.nodeId, name: initial.name, type: initial.type, last: true, objectName: initial.objectName, objectParams: initial.objectParams, components: [] };
    setNode(restored);
    setValues(Object.fromEntries(initial.values.map((v) => [v.id, v.value])));
  }, [root, initial, node, tree.children]);

  const toggle = (n: TreeNode) => {
    if (n.last) {
      if (node?.id !== n.id || node?.type !== n.type) {
        setNode(n);
        setValues(defaults(n));
      }
      return;
    }
    const next = new Set(open);
    if (next.has(n.id)) next.delete(n.id);
    else {
      next.add(n.id);
      void tree.load(n.id);
    }
    setOpen(next);
  };

  const comps = node?.components ?? [];
  const missing = node && node.type !== "PC_CONTROL" ? comps.filter((c) => values[c.id] === undefined || values[c.id] === "").map((c) => c.id) : [];
  const valid = !!node && (node.type === "PC_CONTROL" ? pcIsComplete(pc) : missing.length === 0);

  const save = () => {
    if (!node) return;
    const base = { uid: initial?.uid ?? uid("a"), nodeId: node.id, type: node.type ?? "", name: node.name, objectName: node.objectName, objectParams: node.objectParams };
    if (node.type === "PC_CONTROL") {
      onSave({ ...base, values: [], pc, summary: `${PC_ACTIONS[pc.action].label}: ${pcSummary(pc)}` });
    } else {
      const vals = comps.map((c) => ({ id: c.id, value: coerce(c, values[c.id]) }));
      onSave({ ...base, values: vals, summary: summarize(node, values) });
    }
  };

  const renderNodes = (list: TreeNode[] | "loading" | "error" | undefined, depth = 0): ReactNode => {
    if (list === "loading" || list === undefined) return <div className="tree-empty"><Spinner /></div>;
    if (list === "error") return <div className="tree-empty">Couldn't load.</div>;
    if (!list.length) return <div className="tree-empty">{depth === 0 ? "No actions available." : "Nothing here yet."}</div>;
    return list.map((n, i) => (
      <div key={`${n.id}:${n.type ?? ""}:${i}`}>
        <button type="button" className="tree-item" aria-selected={!!node && n.last && node.id === n.id && node.type === n.type} onClick={() => toggle(n)}>
          {n.last ? actionIcon({ type: n.type }) : open.has(n.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {!n.last && <Folder size={13} />}
          <span className="truncate">{nodeTitle(n)}</span>
        </button>
        {!n.last && open.has(n.id) && <div className="tree-children">{renderNodes(tree.children[n.id], depth + 1)}</div>}
      </div>
    ));
  };

  return (
    <Modal
      wide title={initial ? "Edit action" : "Add an action"} onClose={onClose}
      footer={
        <>
          {!tree.online && <span className="faint" style={{ marginRight: "auto", fontSize: 12 }}>Offline: showing the built-in actions.</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={save}>{initial ? "Save" : "Add action"}</Button>
        </>
      }
    >
      <div className="picker" style={{ margin: "0 -18px -18px", height: "calc(100% + 18px)" }}>
        <div className="picker-tree">
          <div className="row" style={{ justifyContent: "space-between", padding: "2px 4px 6px 8px" }}>
            <span className="faint" style={{ fontSize: 11, fontWeight: 600 }}>ACTIONS</span>
            {tree.online && <Button variant="ghost" icon size="sm" title="Reload" onClick={() => { setOpen(new Set()); void tree.load("", true); }}><RefreshCw size={12} /></Button>}
          </div>
          {renderNodes(root)}
        </div>
        <div className="picker-form">
          {!node ? (
            <div className="empty" style={{ margin: "auto" }}>
              <div className="art"><Zap size={22} /></div>
              <h3>Choose an action</h3>
              <p>Pick something on the left to set it up.</p>
            </div>
          ) : (
            <>
              <div className="row" style={{ gap: 10 }}>
                <span className="ico" style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--surface-3)" }}>{actionIcon({ type: node.type, pc })}</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{nodeTitle(node)}</div>
                  {node.objectName && <div className="faint" style={{ fontSize: 12 }}>{tr(node.objectName)}</div>}
                </div>
              </div>
              {node.type === "PC_CONTROL" ? (
                <PcControlEditor value={pc} onChange={setPc} />
              ) : comps.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>Nothing to set up.</p>
              ) : (
                comps.map((c) => (
                  <ComponentField key={c.id} node={node} c={c} value={values[c.id]} onChange={(v) => setValues((s) => ({ ...s, [c.id]: v }))} />
                ))
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function defaults(n: TreeNode): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const c of n.components ?? []) {
    if (c.uiType === "SEEKBAR") v[c.id] = Math.round(((c.min ?? 0) + (c.max ?? 100)) / 2);
    else if (n.type === "DELAY") v[c.id] = 5;
    else if (n.type === "TIMER" && c.id === "2") v[c.id] = "START";
  }
  return v;
}

function coerce(c: Component, v: unknown) {
  if (c.inputType === "INT") return Number(v);
  return v === undefined ? "" : String(v);
}

/** Options for a component, swapping in this app's own data where the bar's
 * list would be stale (profiles, timers) or empty (apps). */
function useOptions(node: TreeNode, c: Component): { label: string; value: string }[] | null {
  const profiles = useApp((s) => s.doc.profiles);
  const apps = useApp((s) => s.catalog.apps);
  return useMemo(() => {
    if (node.type === "CHANGE_PROFILE") return profiles.map((p) => ({ label: p.name, value: p.id }));
    if (node.type === "TIMER" && c.id === "1") {
      return profiles.flatMap((p) => p.widgets.filter((w) => w.type === "TIMER").map((w) => ({ label: `${w.name} (${p.name})`, value: w.uid })));
    }
    if (node.type === "ACTIVITY") return apps.map((a) => ({ label: a.appName, value: a.application }));
    if (c.uiType === "SELECT") return (c.options ?? []).map((o) => ({ label: tr(o.label), value: o.value }));
    return null;
  }, [node.type, c, profiles, apps]);
}

function ComponentField({ node, c, value, onChange }: { node: TreeNode; c: Component; value: unknown; onChange: (v: unknown) => void }) {
  const options = useOptions(node, c);
  const label = tr(c.name) || (node.type === "DELAY" ? "Wait for" : node.type === "CHANGE_PROFILE" ? "Profile" : node.type === "BRIGHT" ? "Brightness" : node.type === "SOUND_SCAPE" ? "Sound" : node.type === "ACTIVITY" ? "App" : "Value");

  if (options) {
    const empty = node.type === "TIMER" ? "Add a Timer card to a profile first." : node.type === "ACTIVITY" ? "No apps found on the bar." : "No options available.";
    return (
      <Field label={label} error={!options.length ? empty : undefined}>
        <select className="select" value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} disabled={!options.length}>
          <option value="" disabled>Choose…</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
    );
  }
  if (c.uiType === "SEEKBAR") {
    const v = Number(value ?? c.min ?? 0);
    return (
      <Field label={label} aside={<span className="mono faint">{v}{c.unit ? ` ${c.unit}` : ""}</span>}>
        <Slider min={c.min ?? 0} max={c.max ?? 100} value={v} onChange={onChange} />
      </Field>
    );
  }
  if (c.uiType === "COLOR_PICKER") {
    return (
      <Field label={label}>
        <input type="color" value={String(value ?? "#ffffff")} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }
  const isInt = c.inputType === "INT";
  const n = Number(value);
  const outOfRange = isInt && value !== undefined && value !== "" && (Number.isNaN(n) || (c.min !== undefined && n < c.min) || (c.max !== undefined && n > c.max));
  return (
    <Field label={label} error={outOfRange ? `Enter a number from ${c.min ?? "…"} to ${c.max ?? "…"}` : undefined}
      hint={isInt && c.min !== undefined ? `${c.min}–${c.max}${c.unit ? ` ${c.unit}s` : ""}` : undefined}>
      <div className="input-affix">
        <input className={`input${outOfRange ? " invalid" : ""}`} inputMode={isInt ? "numeric" : undefined} value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(isInt ? e.target.value.replace(/[^\d-]/g, "") : e.target.value)} />
        {c.unit && <span className="suffix">{c.unit === "second" ? "sec" : c.unit}</span>}
      </div>
    </Field>
  );
}

function summarize(node: TreeNode, values: Record<string, unknown>): string {
  const doc = useApp.getState().doc;
  const apps = useApp.getState().catalog.apps;
  const first = values[(node.components ?? [])[0]?.id ?? "1"];
  switch (node.type) {
    case "DELAY": return `${first} second${Number(first) === 1 ? "" : "s"}`;
    case "CHANGE_PROFILE": return doc.profiles.find((p) => p.id === first)?.name ?? String(first);
    case "BRIGHT": return `${first}%`;
    case "ACTIVITY": return apps.find((a) => a.application === first)?.appName ?? String(first);
    case "TIMER": {
      const timer = doc.profiles.flatMap((p) => p.widgets).find((w) => w.uid === values["1"]);
      const verb = tr((node.components?.[1]?.options ?? []).find((o) => o.value === values["2"])?.label) || String(values["2"]);
      return `${verb} “${timer?.name ?? "timer"}”`;
    }
    default: {
      const parts = (node.components ?? []).map((c) => {
        const v = values[c.id];
        const opt = c.options?.find((o) => o.value === v);
        return tr(opt?.label) || String(v ?? "");
      });
      return parts.filter(Boolean).join(", ") || tr(node.name);
    }
  }
}
