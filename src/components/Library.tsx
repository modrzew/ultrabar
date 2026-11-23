import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, LayoutGrid, MoreHorizontal, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useApp } from "../lib/store";
import type { PcAction, Widget, WidgetType } from "../lib/model";
import { DISCORD_OPS, DISCORD_ORDER, PC_ACTIONS, WIDGETS, newWidget, pcMeta, pcSummary } from "../lib/widgets";
import { glyphPng } from "../lib/icons";
import { barAppIconUrl } from "../lib/deploy";
import { buttonWidget, packUpdate, packWidget, usableButtons } from "../lib/market";
import { errorMessage, type InstalledPack } from "../lib/api";
import { PackBrowser } from "./PackBrowser";
import { Button, Menu, Spinner, useMenu } from "./ui";

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
    const glyph = w.type === "SCENE" ? "layers" : pcMeta(w.pc).glyph;
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

/** Adds a card made from an installed pack (the whole pack, or one button). */
function addFromPack(profileId: string, index: number | undefined, make: () => Promise<Widget>) {
  make().then(
    (w) => useApp.getState().addWidget(profileId, w, index),
    (e) => useApp.getState().toast({ kind: "error", title: "Couldn't add that card", body: errorMessage(e) }),
  );
}

/** The whole pack first (a shortcut-group card), then each usable button as
 * its own computer-action card, as in the official app. */
function packItems(p: InstalledPack): LibItem[] {
  const buttons = usableButtons(p.pack);
  const id = p.plugin.id;
  const icon = (src: string | null | undefined, fallback: ReactNode) => (src ? <img src={src} alt="" /> : fallback);
  return [
    {
      key: `pack:${id}`, label: p.plugin.name, sub: `Whole pack · ${buttons.length} button${buttons.length === 1 ? "" : "s"}`,
      icon: icon(p.pack.icon ?? p.plugin.icon, <LayoutGrid size={16} />),
      add: (pid, i) => addFromPack(pid, i, async () => (await packWidget(p.pack, p.plugin)).widget),
    },
    ...buttons.map(({ b, pc, index }) => {
      const Icon = pcMeta(pc).icon;
      return {
        key: `pack:${id}:${index}`, label: b.name.trim() || PC_ACTIONS[pc.action].label, sub: `${PC_ACTIONS[pc.action].verb} ${pcSummary(pc)}`,
        icon: icon(b.icon, <Icon size={16} />),
        add: (pid: string, i?: number) => addFromPack(pid, i, () => buttonWidget(b, pc)),
      };
    }),
  ];
}

interface LibGroup {
  title: string;
  items: LibItem[];
  note?: string;
  /** Installed pack: can be folded, reloaded and uninstalled. */
  pack?: InstalledPack;
}

/** Folded pack groups, kept across visits to the card list. */
const FOLDED_KEY = "ultrabar.foldedPacks";
function loadFolded(): Set<number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]") as number[]);
  } catch {
    return new Set();
  }
}

export function Library({ profileId }: { profileId: string }) {
  const [q, setQ] = useState("");
  const catalog = useApp((s) => s.catalog);
  const online = useApp((s) => s.status.state === "online");
  const barIp = useApp((s) => s.status.bar?.ip);
  const installed = useApp((s) => s.packs.list);
  const [packs, setPacks] = useState<{ index?: number } | null>(null);
  const [folded, setFolded] = useState(loadFolded);

  // Update checks for installed packs.
  useEffect(() => {
    if (installed.length) void useApp.getState().loadMarket();
  }, [installed.length]);

  const toggleFold = (id: number) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
  };

  const groups = useMemo(() => {
    const g: LibGroup[] = [
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
          basic("CPU"),
          basic("MEMORY"),
          basic("STORAGE"),
          basic("NETWORK"),
        ],
      },
      {
        title: "Discord",
        items: DISCORD_ORDER.map((op) => {
          const d = DISCORD_OPS[op];
          const Icon = d.icon;
          return {
            key: `discord:${op}`, label: d.label, sub: "Through the Discord app on this computer", icon: <Icon size={16} />,
            add: (pid: string, i?: number) => addWidget(pid, newWidget("PC_CONTROL", { pc: { action: "discord", discord: { op } } }), i),
          };
        }),
      },
      { title: "Automation", items: [basic("SCENE", "Run several actions with one tap")] },
      {
        title: "Shortcut packs",
        items: [{
          key: "packs", label: "Browse shortcut packs", sub: "Zoom, OBS, Photoshop and more from the store",
          icon: <LayoutGrid size={16} />, add: (_pid, index) => setPacks({ index }),
        }],
      },
      ...installed.map((p) => ({ title: p.plugin.name, items: packItems(p), pack: p })),
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
  }, [catalog, online, barIp, installed]);

  const query = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !query || `${i.label} ${i.sub} ${g.pack ? g.title : ""}`.toLowerCase().includes(query)) }))
    .filter((g) => g.items.length || (!query && g.note));

  return (
    <>
      <div className="panel-head"><h3>Add cards</h3></div>
      <div className="panel-body">
        <div className="lib-search input-affix">
          <Search size={13} style={{ position: "absolute", left: 9, color: "var(--text-3)" }} />
          <input className="input" style={{ paddingLeft: 28 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </div>
        {filtered.map((g) => {
          // A search shows matches in folded packs too.
          const fold = !!g.pack && folded.has(g.pack.plugin.id) && !query;
          return (
            <div className="lib-group" key={g.pack ? `pack:${g.pack.plugin.id}` : g.title}>
              {g.pack ? <PackHeader pack={g.pack} folded={fold} onFold={() => toggleFold(g.pack!.plugin.id)} /> : <h4>{g.title}</h4>}
              {!fold && g.items.map((it) => <LibraryItem key={it.key} item={it} profileId={profileId} />)}
              {g.note && !query && <div className="lib-note">{g.note}</div>}
            </div>
          );
        })}
        {!filtered.length && <div className="faint" style={{ padding: "8px 2px" }}>Nothing matches “{q}”.</div>}
      </div>
      {packs && <PackBrowser profileId={profileId} index={packs.index} onClose={() => setPacks(null)} />}
    </>
  );
}

/** An installed pack's group title, with fold, reload/update and uninstall. */
function PackHeader({ pack, folded, onFold }: { pack: InstalledPack; folded: boolean; onFold: () => void }) {
  const busy = useApp((s) => s.packs.busy[pack.plugin.id]);
  const store = useApp((s) => s.market.plugins);
  const menu = useMenu();
  const s = useApp.getState();
  const update = packUpdate(pack, store);
  const reload = async () => {
    // The store's current record when it has one, so a reload also updates.
    await s.loadMarket();
    const latest = useApp.getState().market.plugins.find((p) => p.id === pack.plugin.id) ?? pack.plugin;
    const done = await s.installPack(latest);
    if (done) {
      const v = done.plugin.versionName;
      s.toast({ kind: "success", title: `Reloaded ${done.plugin.name}${v ? ` (${v})` : ""}`, body: "Cards you already made from it keep their buttons." });
    }
  };
  return (
    <div className="lib-pack-head">
      <button type="button" className="fold" onClick={onFold} aria-expanded={!folded} title={folded ? "Show buttons" : "Hide buttons"}>
        {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className="truncate">{pack.plugin.name}</span>
        {update && <span className="chip accent">Update</span>}
      </button>
      {busy ? <Spinner /> : (
        <Button variant="ghost" icon size="sm" aria-label={`${pack.plugin.name} options`} onClick={(e) => menu.open(e.currentTarget)}><MoreHorizontal size={13} /></Button>
      )}
      {menu.anchor && (
        <Menu anchor={menu.anchor} onClose={menu.close} align="end" items={[
          { label: update ? `Update to ${update.versionName ?? "the latest version"}` : "Reload from the store", icon: <RefreshCw size={13} />, onSelect: () => void reload() },
          { label: "Uninstall", icon: <Trash2 size={13} />, danger: true, onSelect: () => void s.uninstallPack(pack.plugin.id) },
        ]} />
      )}
    </div>
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
