import { useEffect, useState } from "react";
import {
  AlertTriangle, ArrowUpFromLine, Blocks, Boxes, Check, CheckCircle2, CircleArrowDown, Copy, LayoutGrid, MoreHorizontal, Pencil,
  Plug, Plus, Settings, Star, Trash2, Workflow, XCircle,
} from "lucide-react";
import { isDirty, useApp } from "./lib/store";
import { isMac } from "./lib/hid";
import { findProblems } from "./lib/deploy";
import { Button, InlineInput, Menu, Modal, Spinner, useMenu } from "./components/ui";
import { ProfileEditor } from "./views/ProfileEditor";
import { AutomationsView } from "./views/Automations";
import { ModulesView } from "./views/Modules";
import { IntegrationsView } from "./views/Integrations";
import { AppsView } from "./views/Apps";
import { SettingsView } from "./views/Settings";
import { ConnectSheet, statusDot, statusText } from "./components/ConnectSheet";
import { UpdateDialog } from "./components/UpdateDialog";
import { useUpdateCheck } from "./lib/updates";

export default function App() {
  const ready = useApp((s) => s.ready);
  const view = useApp((s) => s.view);
  const connectOpen = useApp((s) => s.connectOpen);

  useEffect(() => {
    void useApp.getState().init();
  }, []);

  useGlobalShortcuts();

  if (!ready) return <div className="app" />;

  return (
    <div className="app">
      <TitleBar />
      <Sidebar />
      <main className="main">
        {view.kind === "profile" && <ProfileEditor profileId={view.id} />}
        {view.kind === "automations" && <AutomationsView />}
        {view.kind === "modules" && <ModulesView />}
        {view.kind === "integrations" && <IntegrationsView />}
        {view.kind === "apps" && <AppsView />}
        {view.kind === "settings" && <SettingsView />}
      </main>
      {connectOpen && <ConnectSheet />}
      <Toasts />
    </div>
  );
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.closest("input, textarea, select, [contenteditable]") !== null;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const s = useApp.getState();
      if (document.querySelector(".backdrop")) return;
      if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        s.redo();
        return;
      }
      if (typing) return;
      if ((e.key === "Backspace" || e.key === "Delete") && s.selected) {
        e.preventDefault();
        s.removeWidget(s.selected);
      } else if (mod && e.key.toLowerCase() === "d" && s.selected) {
        e.preventDefault();
        s.duplicateWidget(s.selected);
      } else if (e.key === "Escape" && s.selected) {
        s.select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function TitleBar() {
  const view = useApp((s) => s.view);
  const doc = useApp((s) => s.doc);
  const crumb =
    view.kind === "profile" ? doc.profiles.find((p) => p.id === view.id)?.name
    : view.kind === "automations" ? "Automations"
    : view.kind === "modules" ? "Modules"
    : view.kind === "integrations" ? "Integrations"
    : view.kind === "apps" ? "Apps"
    : "Settings";
  return (
    <header className={`titlebar${isMac ? " mac" : ""}`} data-tauri-drag-region>
      <span className="title" data-tauri-drag-region>ultrabar</span>
      <span className="crumb" data-tauri-drag-region>/ {crumb}</span>
      <div className="spacer" data-tauri-drag-region />
      <DeployButton />
    </header>
  );
}

function DeployButton() {
  const status = useApp((s) => s.status);
  const deploy = useApp((s) => s.deploy);
  const doc = useApp((s) => s.doc);
  const dirty = useApp((s) => isDirty(s));
  const triggerTypes = useApp((s) => s.catalog.triggers).map((t) => t.type);
  const [confirm, setConfirm] = useState(false);
  const online = status.state === "online";
  const running = deploy.phase === "running";

  const start = () => {
    const problems = findProblems(doc, triggerTypes);
    if (!doc.deployedAt || problems.length) setConfirm(true);
    else void useApp.getState().runDeploy();
  };

  let label = "Deploy";
  if (running) label = deploy.step + "…";
  else if (online && !dirty) label = "Deployed";

  return (
    <>
      <Button
        variant={online && dirty ? "primary" : "default"}
        className={`deploy-btn${online && !dirty && !running ? " synced" : ""}`}
        disabled={!online || running}
        title={!online ? "Connect to your bar to deploy" : dirty ? "Send your changes to the bar" : "The bar matches this layout. Click to send it again."}
        onClick={start}
      >
        {running ? <Spinner /> : online && !dirty ? <Check size={14} /> : <ArrowUpFromLine size={14} />}
        {label}
      </Button>
      {confirm && <DeployConfirm onClose={() => setConfirm(false)} />}
    </>
  );
}

function DeployConfirm({ onClose }: { onClose: () => void }) {
  const doc = useApp((s) => s.doc);
  const bar = useApp((s) => s.status.bar);
  const triggerTypes = useApp((s) => s.catalog.triggers).map((t) => t.type);
  const problems = findProblems(doc, triggerTypes);
  const first = !doc.deployedAt;
  return (
    <Modal
      title={first ? "Replace the layout on your bar?" : "Some cards aren't finished"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { onClose(); void useApp.getState().runDeploy(); }}>
            {problems.length ? "Deploy anyway" : "Deploy"}
          </Button>
        </>
      }
    >
      <div className="stack">
        {first && (
          <p className="muted" style={{ margin: 0 }}>
            Deploying sends every profile, card and automation in this app to <b style={{ color: "var(--text)" }}>{bar?.name ?? "your bar"}</b> and
            replaces what's on it now. Profiles set up elsewhere will be removed.
          </p>
        )}
        {problems.length > 0 && (
          <>
            <p className="muted" style={{ margin: 0 }}>These won't work on the bar until you fix them:</p>
            <div className="problems">
              {problems.slice(0, 8).map((p, i) => (
                <button
                  key={i} className="problem" type="button"
                  onClick={() => {
                    if (p.profileId) {
                      useApp.getState().setView({ kind: "profile", id: p.profileId });
                      useApp.getState().select(p.widgetUid ?? null);
                    } else if (p.where === "Weather") useApp.getState().setView({ kind: "integrations" });
                    onClose();
                  }}
                >
                  <AlertTriangle size={13} />
                  <span><b>{p.where}</b> · {p.message}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Sidebar() {
  const doc = useApp((s) => s.doc);
  const view = useApp((s) => s.view);
  const status = useApp((s) => s.status);
  const setView = useApp((s) => s.setView);
  const addProfile = useApp((s) => s.addProfile);
  const [renaming, setRenaming] = useState<string | null>(null);

  const nav = (kind: "automations" | "modules" | "integrations" | "apps" | "settings", label: string, Icon: typeof Plug, meta?: string | number) => (
    <button className={`side-item${view.kind === kind ? " active" : ""}`} onClick={() => setView({ kind } as never)}>
      <Icon size={15} />
      <span className="label">{label}</span>
      {meta !== undefined && <span className="meta">{meta}</span>}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="scroll">
        <div className="side-heading">
          <span>Profiles</span>
          <Button variant="ghost" size="sm" icon title="New profile" onClick={() => { const id = addProfile(); setRenaming(id); }}>
            <Plus size={14} />
          </Button>
        </div>
        {doc.profiles.map((p) => (
          <ProfileItem
            key={p.id} id={p.id} name={p.name} count={p.widgets.length} isDefault={p.isDefault}
            active={view.kind === "profile" && view.id === p.id}
            renaming={renaming === p.id}
            onRename={(r) => setRenaming(r ? p.id : null)}
          />
        ))}
        <div className="side-heading" style={{ marginTop: 10 }}><span>Bar</span></div>
        {nav("automations", "Automations", Workflow, doc.automations.length || undefined)}
        {nav("modules", "Modules", Boxes, doc.modules.length || undefined)}
        {nav("integrations", "Integrations", Plug)}
        {nav("apps", "Apps", Blocks)}
        {nav("settings", "Settings", Settings)}
      </div>
      <UpdateNotice />
      <button className="device-card" onClick={() => useApp.getState().setConnectOpen(true)}>
        <span className={`dot ${statusDot(status.state)}`} />
        <span className="grow">
          <div className="name truncate">{status.bar?.name ?? "No bar connected"}</div>
          <div className="sub truncate">{statusText(status)}</div>
        </span>
      </button>
    </aside>
  );
}

/** Shows up above the bar's card once a newer release is out. */
function UpdateNotice() {
  const version = useUpdateCheck();
  const [open, setOpen] = useState(false);
  if (!version) return null;
  return (
    <>
      <button className="update-card" onClick={() => setOpen(true)}>
        <CircleArrowDown size={16} />
        <span className="grow">
          <div className="name truncate">Update available</div>
          <div className="sub truncate">Version {version}</div>
        </span>
      </button>
      {open && <UpdateDialog version={version} onClose={() => setOpen(false)} />}
    </>
  );
}

function ProfileItem({ id, name, count, isDefault, active, renaming, onRename }: {
  id: string; name: string; count: number; isDefault: boolean; active: boolean; renaming: boolean; onRename: (on: boolean) => void;
}) {
  const s = useApp.getState();
  const menu = useMenu();
  const many = useApp((st) => st.doc.profiles.length > 1);
  const online = useApp((st) => st.status.state === "online");
  return (
    <div
      className={`side-item${active ? " active" : ""}`}
      role="button" tabIndex={0}
      onClick={() => s.setView({ kind: "profile", id })}
      onDoubleClick={() => onRename(true)}
      onKeyDown={(e) => e.key === "Enter" && s.setView({ kind: "profile", id })}
    >
      <LayoutGrid size={15} />
      {renaming ? (
        <InlineInput
          value={name} autoFocus
          onCommit={(v) => s.update((d) => { d.profiles.find((p) => p.id === id)!.name = v; })}
          onDone={() => onRename(false)}
        />
      ) : (
        <span className="label">{name}</span>
      )}
      {isDefault && <Star size={11} fill="currentColor" style={{ color: "var(--text-3)" }} aria-label="Default profile" />}
      {!renaming && (
        <>
          <span className="meta">{count}</span>
          <Button
            variant="ghost" size="sm" icon className="more" data-open={!!menu.anchor} aria-label="Profile options"
            onClick={(e) => { e.stopPropagation(); menu.open(e.currentTarget); }}
          >
            <MoreHorizontal size={14} />
          </Button>
        </>
      )}
      {menu.anchor && (
        <Menu
          anchor={menu.anchor} onClose={menu.close}
          items={[
            { label: "Rename", icon: <Pencil size={14} />, onSelect: () => onRename(true) },
            { label: "Duplicate", icon: <Copy size={14} />, onSelect: () => s.duplicateProfile(id) },
            {
              label: "Make default", icon: <Star size={14} />, disabled: isDefault,
              onSelect: () => s.update((d) => d.profiles.forEach((p) => (p.isDefault = p.id === id))),
            },
            { label: "Show on the bar now", icon: <ArrowUpFromLine size={14} />, disabled: !online, onSelect: () => void s.showProfileOnBar(id) },
            { separator: true, label: "" },
            { label: "Delete", icon: <Trash2 size={14} />, danger: true, disabled: !many, onSelect: () => s.deleteProfile(id) },
          ]}
        />
      )}
    </div>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.kind === "success" ? <CheckCircle2 size={16} /> : t.kind === "error" ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
          <div>
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
