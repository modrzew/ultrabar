import { useMemo, useState, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { LayoutGrid, Plus, Search } from "lucide-react";
import { useApp } from "../lib/store";
import type { PcAction, Widget, WidgetType } from "../lib/model";
import { PC_ACTIONS, WIDGETS, newWidget } from "../lib/widgets";
import { glyphPng } from "../lib/icons";
import { barAppIconUrl } from "../lib/deploy";
import { PackBrowser } from "./PackBrowser";

export interface LibItem {
  key: string;
  label: string;
  sub: string;
  icon: ReactNode;
  add: (profileId: string, index?: number) => void;
}

function addWidget(profileId: string, w: Widget, index?: number) {
  useApp.getState().addWidget(profileId, w, index);
  // Icon-only cards get a matching symbol right away.
  if (w.type === "PC_CONTROL" || w.type === "SCENE") {
    const glyph = w.type === "SCENE" ? "layers" : PC_ACTIONS[w.pc!.action].glyph;
    void glyphPng(glyph, "#ffffff").then((png) =>
      useApp.getState().updateWidget(w.uid, (x) => { if (!x.icon) x.icon = { kind: "glyph", glyph, color: "#ffffff", png }; }, undefined, true),
    );
  }
}

function basic(type: WidgetType, sub?: string): LibItem {
  const def = WIDGETS[type];
  const Icon = def.icon;
  return {
    key: type, label: def.label, sub: sub ?? def.description, icon: <Icon size={16} />,
    add: (pid, i) => addWidget(pid, newWidget(type), i),
  };
}

function pcItem(action: PcAction, sub: string): LibItem {
  const def = PC_ACTIONS[action];
  const Icon = def.icon;
  return {
    key: `pc:${action}`, label: def.label, sub, icon: <Icon size={16} />,
    add: (pid, i) => addWidget(pid, newWidget("PC_CONTROL", { pc: action === "hotkey" ? { action, keys: [] } : { action } }), i),
  };
}

export function Library({ profileId }: { profileId: string }) {
  const [q, setQ] = useState("");
  const catalog = useApp((s) => s.catalog);
  const online = useApp((s) => s.status.state === "online");
  const barIp = useApp((s) => s.status.bar?.ip);
  const [packs, setPacks] = useState<{ index?: number } | null>(null);

  const groups = useMemo(() => {
    const g: { title: string; items: LibItem[]; note?: string }[] = [
      { title: "Essentials", items: [basic("TIME"), basic("WORLD_TIME"), basic("WEATHER"), basic("TIMER"), basic("SOUNDSCAPE")] },
      {
        title: "This computer",
        items: [
          pcItem("hotkey", "Typed by the bar over USB"),
          pcItem("startApp", "Launch an application"),
          pcItem("openBrowser", "Open a link in your browser"),
          pcItem("openFile", "Open a document or folder"),
          pcItem("execCmd", "Run a shell command"),
          pcItem("inputText", "Type a snippet of text"),
        ],
      },
      { title: "Automation", items: [basic("SCENE", "Run several actions with one tap")] },
      {
        title: "Shortcut packs",
        items: [{
          key: "packs", label: "Browse shortcut packs", sub: "Zoom, OBS, Photoshop and more from the store",
          icon: <LayoutGrid size={16} />, add: (_pid, index) => setPacks({ index }),
        }],
      },
    ];
    const apps = catalog.apps.filter((a) => a.allowProfile !== false);
    g.push({
      title: "Apps on the bar",
      items: apps.map((a) => ({
        key: `app:${a.application}`, label: a.appName, sub: a.application,
        icon: barIp ? <img src={barAppIconUrl(a.application, barIp)} alt="" /> : <Plus size={14} />,
        add: (pid, i) => addWidget(pid, newWidget("APPS", { name: a.appName, app: { package: a.application } }), i),
      })),
      note: !online ? "Connect to your bar to list its apps." : apps.length ? undefined : "No extra apps are installed on the bar.",
    });
    if (catalog.devices.length) {
      g.push({
        title: "Devices",
        items: catalog.devices.map((d) => ({
          key: `dev:${d.id}`, label: d.name, sub: d.deviceType.toLowerCase().replace(/_/g, " "),
          icon: <Plus size={14} />,
          add: (pid, i) => addWidget(pid, newWidget("DEVICE", { name: d.name, device: { id: d.id, deviceType: d.deviceType } }), i),
        })),
      });
    }
    return g;
  }, [catalog, online, barIp]);

  const query = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !query || `${i.label} ${i.sub}`.toLowerCase().includes(query)) }))
    .filter((g) => g.items.length || (!query && g.note));

  return (
    <>
      <div className="panel-head"><h3>Add cards</h3></div>
      <div className="panel-body">
        <div className="lib-search input-affix">
          <Search size={13} style={{ position: "absolute", left: 9, color: "var(--text-3)" }} />
          <input className="input" style={{ paddingLeft: 28 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </div>
        {filtered.map((g) => (
          <div className="lib-group" key={g.title}>
            <h4>{g.title}</h4>
            {g.items.map((it) => <LibraryItem key={it.key} item={it} profileId={profileId} />)}
            {g.note && !query && <div className="lib-note">{g.note}</div>}
          </div>
        ))}
        {!filtered.length && <div className="faint" style={{ padding: "8px 2px" }}>Nothing matches “{q}”.</div>}
      </div>
      {packs && <PackBrowser profileId={profileId} index={packs.index} onClose={() => setPacks(null)} />}
    </>
  );
}

function LibraryItem({ item, profileId }: { item: LibItem; profileId: string }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `lib:${item.key}`, data: { kind: "lib", item } });
  return (
    <button ref={setNodeRef} className="lib-item" {...attributes} {...listeners} onClick={() => item.add(profileId)} title={`Add ${item.label}`}>
      <span className="glyph">{item.icon}</span>
      <span className="txt">
        <b>{item.label}</b>
        <span>{item.sub}</span>
      </span>
      <Plus size={14} className="add" />
    </button>
  );
}
