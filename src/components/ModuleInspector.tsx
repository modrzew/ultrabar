// Right-hand panel for a module selected in the bar preview: what its keys
// (and a knob's turns) do in this profile, and where it's drawn.
import { useEffect, useState } from "react";
import { ArrowLeft, Boxes, ChevronDown, ChevronRight, Copy, Folder, Info, Laptop, Lightbulb, MonitorSmartphone, RefreshCw, X } from "lucide-react";
import { useApp } from "../lib/store";
import { ACT, api } from "../lib/api";
import type { KeyBinding, KeyEvent, KnobTarget, ModuleEndpoint, ModuleSetup } from "../lib/model";
import { DOT_KEYS, KNOB_BUTTON, OFFLINE_KNOB_TARGETS, PRODUCTS, knobTargetName, movedPlacements, placedModules } from "../lib/modules";
import { KEY_EVENTS, gestureRuns } from "../lib/deploy";
import { isMac } from "../lib/hid";
import { GestureEditor } from "./GestureEditor";
import { ModuleDetails } from "./ModuleDetails";
import { ModuleDevice } from "./ModuleRail";
import { Button, Modal, Segmented, Spinner } from "./ui";

type Update = (mut: (s: ModuleSetup) => void) => void;

export function ModuleInspector({ profileId, serial }: { profileId: string; serial: string }) {
  const m = useApp((s) => s.doc.modules.find((x) => x.serialNumber === serial));
  const profile = useApp((s) => s.doc.profiles.find((p) => p.id === profileId));
  const profiles = useApp((s) => s.doc.profiles.length);
  const online = useApp((s) => (s.status.state === "online" ? s.moduleOnline[serial] : undefined));
  const [details, setDetails] = useState(false);
  if (!m || !profile) return null;
  const s = useApp.getState();
  const setup = profile.modules?.find((x) => x.serialNumber === serial);
  const update: Update = (mut) => s.updateModuleSetup(profileId, m, mut);
  const Icon = PRODUCTS[m.productId]?.icon ?? Boxes;

  const copyToAll = () => {
    s.update((d) => {
      const src = d.profiles.find((p) => p.id === profileId)?.modules?.find((x) => x.serialNumber === serial);
      if (!src) return;
      for (const p of d.profiles) {
        if (p.id === profileId) continue;
        p.modules = [...(p.modules ?? []).filter((x) => x.serialNumber !== serial), structuredClone(src)];
      }
    });
    s.toast({ kind: "success", title: `${m.name} works the same in every profile now` });
  };

  return (
    <>
      <div className="panel-head">
        <Button variant="ghost" icon size="sm" onClick={() => s.selectModule(null)} aria-label="Back to library" title="Back to library (Esc)">
          <ArrowLeft size={15} />
        </Button>
        <h3><Icon size={14} className="faint" /> <span className="truncate">{m.name}</span></h3>
        <Button variant="ghost" icon size="sm" onClick={() => setDetails(true)} title="Module details" aria-label="Module details"><Info size={14} /></Button>
      </div>
      {details && <ModuleDetails serial={serial} onClose={() => setDetails(false)} />}
      <div className="panel-body" key={serial}>
        {online === false && (
          <div className="callout warn" style={{ marginBottom: 12 }}>
            <Info size={14} />
            <div>The bar says this module isn't attached right now. You can still set it up.</div>
          </div>
        )}
        {m.productId === "DOT_KEY" ? (
          <DotKeyEditor m={m} setup={setup} update={update} />
        ) : m.productId === "KNOB_KEY" ? (
          <KnobEditor m={m} setup={setup} update={update} />
        ) : (
          <div className="callout"><Info size={14} /><div>This app can't set up a {PRODUCTS[m.productId]?.name ?? "module like this"} yet.</div></div>
        )}

        <div className="panel-section">
          <h4>Next to the bar</h4>
          <Placement serial={serial} />
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>Only changes how it's drawn here. The bar can't tell where a module is attached.</p>
        </div>

        <div className="panel-section">
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            These keys apply to the “{profile.name}” profile; each profile can give them different jobs.
          </p>
          {profiles > 1 && setup && (
            <div><Button size="sm" onClick={copyToAll}><Copy size={12} /> Use in all profiles</Button></div>
          )}
        </div>
      </div>
    </>
  );
}

function Placement({ serial }: { serial: string }) {
  const doc = useApp((s) => s.doc);
  const s = useApp.getState();
  const { left, right } = placedModules(doc);
  const side: "left" | "right" = left.some((m) => m.serialNumber === serial) ? "left" : "right";
  const list = side === "left" ? left : right;
  const i = list.findIndex((m) => m.serialNumber === serial);
  const move = (to: "closer" | "further" | "left" | "right") => s.update((d) => { d.modulePlacement = movedPlacements(d, serial, to); });
  return (
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <Segmented value={side} onChange={(v) => v !== side && move(v)} options={[{ value: "left", label: "Left side" }, { value: "right", label: "Right side" }]} />
      {list.length > 1 && (
        <>
          <Button size="sm" disabled={i <= 0} onClick={() => move("closer")}>Nearer the bar</Button>
          <Button size="sm" disabled={i >= list.length - 1} onClick={() => move("further")}>Further out</Button>
        </>
      )}
    </div>
  );
}

function KeyBindingEditor({ binding, onChange, what }: { binding?: KeyBinding; onChange: (b: KeyBinding) => void; what: string }) {
  const [ev, setEv] = useState<KeyEvent>("click");
  const short: Record<KeyEvent, string> = { click: "Click", double: "Double", long: "Hold" };
  const options = KEY_EVENTS.map((e) => {
    const g = binding?.[e.key];
    const n = g?.actions.length ?? 0;
    const label = !n ? short[e.key] : gestureRuns(g) ? `${short[e.key]} · ${n}` : `${short[e.key]} · off`;
    return { value: e.key, label };
  });
  const verb = ev === "click" ? "click" : ev === "double" ? "double-click" : "hold";
  return (
    <div className="stack" style={{ gap: 12 }}>
      <Segmented full value={ev} onChange={setEv} options={options} />
      <GestureEditor key={ev} when={`${verb} ${what}`} gesture={binding?.[ev]} onChange={(g) => onChange({ ...binding, [ev]: g })} />
    </div>
  );
}

function DotKeyEditor({ m, setup, update }: { m: ModuleEndpoint; setup?: ModuleSetup; update: Update }) {
  const [key, setKey] = useState<string>(DOT_KEYS[0].code);
  const label = DOT_KEYS.find((k) => k.code === key)?.label ?? "Key";
  return (
    <>
      <div className="panel-section">
        <div className="mod-figure">
          <ModuleDevice m={m} setup={setup} selectedKey={key} onKey={setKey} size="132px" />
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12, textAlign: "center" }}>Click a key to set it up. Blue keys do something in this profile.</p>
      </div>
      <div className="panel-section">
        <h4>{label}</h4>
        <KeyBindingEditor what={`the ${label.toLowerCase()}`} binding={setup?.keys?.[key]}
          onChange={(b) => update((x) => { x.keys = { ...x.keys, [key]: b }; })} />
      </div>
    </>
  );
}

function KnobEditor({ m, setup, update }: { m: ModuleEndpoint; setup?: ModuleSetup; update: Update }) {
  const [pick, setPick] = useState<null | "right" | "left">(null);
  const targets = [setup?.knob?.right, setup?.knob?.left];
  const usesPc = targets.some((t) => t?.type === "PC_VOLUME" || t?.type === "PC_BRIGHT");
  const usesPcBright = targets.some((t) => t?.type === "PC_BRIGHT");
  const setTarget = (dir: "right" | "left", t: KnobTarget | undefined) =>
    update((x) => {
      x.knob = { ...x.knob, [dir]: t };
      if (!x.knob.right && !x.knob.left) delete x.knob;
    });
  return (
    <>
      <div className="panel-section">
        <div className="mod-figure">
          <ModuleDevice m={m} setup={setup} size="120px" />
        </div>
      </div>
      <div className="panel-section">
        <h4>Turn</h4>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          The first turn picks what to control, so the knob can handle two things. Keep turning either way to adjust it; after 3 seconds at rest, the next turn picks again.
        </p>
        <TargetRow label="Turn right first" target={setup?.knob?.right} onChoose={() => setPick("right")} onClear={() => setTarget("right", undefined)} />
        <TargetRow label="Turn left first" target={setup?.knob?.left} onChoose={() => setPick("left")} onClear={() => setTarget("left", undefined)} />
        {usesPc && (
          <div className="callout">
            <Info size={14} />
            <div>
              This computer makes the change while this app is running and “Let the bar control this computer” is on in Settings.
              {usesPcBright && (isMac ? " Brightness works on built-in and Apple displays." : " Brightness needs a monitor with DDC/CI turned on.")}
            </div>
          </div>
        )}
      </div>
      <div className="panel-section">
        <h4>Press</h4>
        <KeyBindingEditor what="the knob" binding={setup?.keys?.[KNOB_BUTTON]}
          onChange={(b) => update((x) => { x.keys = { ...x.keys, [KNOB_BUTTON]: b }; })} />
      </div>
      {pick && <KnobTargetPicker onClose={() => setPick(null)} onPick={(t) => { setTarget(pick, t); setPick(null); }} />}
    </>
  );
}

function targetIcon(t: { id: string; type?: string }) {
  if (t.id.startsWith("pc:")) return <Laptop size={14} />;
  if (t.id.startsWith("local:")) return <MonitorSmartphone size={14} />;
  return <Lightbulb size={14} />;
}

function TargetRow({ label, target, onChoose, onClear }: { label: string; target?: KnobTarget; onChoose: () => void; onClear: () => void }) {
  return (
    <div className="action-row" onClick={onChoose} style={{ cursor: "pointer" }}>
      <span className="ico" style={{ marginLeft: 4 }}>{target ? targetIcon(target) : <ChevronRight size={14} />}</span>
      <span className="txt">
        <b>{label}</b>
        <span>{target ? knobTargetName(target) : "Nothing. Click to choose"}</span>
      </span>
      {target && (
        <Button variant="ghost" icon size="sm" aria-label="Clear" onClick={(e) => { e.stopPropagation(); onClear(); }}><X size={13} /></Button>
      )}
    </div>
  );
}

interface KnobNode { id: string; name: string; last: boolean; type?: string }

const BRANCH_NAMES: Record<string, string> = {
  "pc:root": "This computer", "local:root": "The bar", light: "Lights", air: "Air conditioners", fan: "Fans",
  curtain: "Curtains", audio_player: "Media players",
};

function KnobTargetPicker({ onClose, onPick }: { onClose: () => void; onPick: (t: KnobTarget) => void }) {
  const online = useApp((s) => s.status.state === "online");
  const [children, setChildren] = useState<Record<string, KnobNode[] | "loading" | "error">>({});
  const [open, setOpen] = useState<Set<string>>(new Set(["pc:root", "local:root"]));

  const load = async (id: string) => {
    setChildren((c) => ({ ...c, [id]: "loading" }));
    try {
      const r = await api.request<KnobNode[]>(ACT.knobTargets, id);
      setChildren((c) => ({ ...c, [id]: Array.isArray(r) ? r : [] }));
    } catch {
      setChildren((c) => ({ ...c, [id]: "error" }));
    }
  };

  useEffect(() => {
    if (!online) return;
    void load("").then(() => { void load("pc:root"); void load("local:root"); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const toggle = (n: KnobNode) => {
    if (n.last) {
      if (n.type) onPick({ id: n.id, type: n.type, name: knobTargetName(n) });
      return;
    }
    const next = new Set(open);
    if (next.has(n.id)) next.delete(n.id);
    else {
      next.add(n.id);
      if (!children[n.id] || children[n.id] === "error") void load(n.id);
    }
    setOpen(next);
  };

  const render = (list: KnobNode[] | "loading" | "error" | undefined, depth: number): React.ReactNode => {
    if (list === "loading" || list === undefined) return <div className="tree-empty"><Spinner /></div>;
    if (list === "error") return <div className="tree-empty">Couldn't load.</div>;
    if (!list.length) return <div className="tree-empty">{depth ? "None. Home Assistant devices appear here once the bar is connected to it." : "Nothing to control."}</div>;
    // This computer and the bar first; then Home Assistant device groups.
    const sorted = depth ? list : [...list].sort((a, b) => Number(!a.id.includes(":")) - Number(!b.id.includes(":")));
    return sorted.map((n) => (
      <div key={n.id}>
        <button type="button" className="tree-item" onClick={() => toggle(n)}>
          {n.last ? targetIcon(n) : open.has(n.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {!n.last && <Folder size={13} />}
          <span className="truncate">{n.last ? knobTargetName(n) : BRANCH_NAMES[n.id] ?? n.name}</span>
        </button>
        {!n.last && open.has(n.id) && <div className="tree-children">{render(children[n.id], depth + 1)}</div>}
      </div>
    ));
  };

  return (
    <Modal title="What should the knob control?" onClose={onClose} footer={<Button onClick={onClose}>Cancel</Button>}>
      <div className="stack" style={{ gap: 2, minHeight: 200 }}>
        {online ? (
          <>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <Button variant="ghost" icon size="sm" title="Reload" onClick={() => { setChildren({}); void load(""); }}><RefreshCw size={12} /></Button>
            </div>
            {render(children[""], 0)}
          </>
        ) : (
          <>
            <p className="faint" style={{ margin: "0 0 6px", fontSize: 12 }}>Offline: connect to your bar to also see Home Assistant devices.</p>
            {OFFLINE_KNOB_TARGETS.map((t) => (
              <button key={t.id} type="button" className="tree-item" onClick={() => onPick(t)}>
                {targetIcon(t)} <span className="truncate">{t.name}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
