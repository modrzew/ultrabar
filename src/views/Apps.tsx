import { useEffect, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ArrowUpCircle, Blocks, Download, ExternalLink, Package, RefreshCw, Store, Trash2 } from "lucide-react";
import { useApp, type AppJob, type BarApp } from "../lib/store";
import { isTauri, type StoreApp } from "../lib/api";
import { barAppIconUrl } from "../lib/deploy";
import { Button, Empty, Modal, Spinner } from "../components/ui";

export function AppsView() {
  const apps = useApp((s) => s.catalog.apps);
  const status = useApp((s) => s.status);
  const market = useApp((s) => s.market);
  const jobs = useApp((s) => s.appJobs);
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState<BarApp | null>(null);
  const online = status.state === "online";
  const busy = Object.keys(jobs).length > 0;

  useEffect(() => {
    void useApp.getState().loadMarket();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    const s = useApp.getState();
    await Promise.all([online ? s.loadCatalog() : null, s.loadMarket(true)]);
    setRefreshing(false);
  };

  const openDashboard = (a: BarApp) => {
    const url = `http://${status.bar?.ip}:${a.port}?sessionToken=${encodeURIComponent(a.sessionToken ?? "")}`;
    if (isTauri) void openUrl(url);
    else window.open(url, "_blank");
  };

  const inStore = new Map(market.apps.map((a) => [a.application, a]));
  const available = market.apps.filter((a) => !apps.some((b) => b.application === a.application));
  const install = (a: { application: string; appName: string }) => void useApp.getState().installApp(a.application, a.appName);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1>Apps</h1>
            <p>Apps on your bar, and more from the UltraBar store. The bar downloads and installs store apps itself, so it needs internet access.</p>
          </div>
          <Button disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
        </div>

        <section>
          <h3 className="section-title"><Blocks size={14} /> On your bar</h3>
          <div className="group">
            {!online ? (
              <Empty icon={<Blocks size={24} />} title="Bar not connected">Connect to your bar to see which apps it has.</Empty>
            ) : apps.length === 0 ? (
              <Empty icon={<Package size={24} />} title="No extra apps">The bar only has its built-in features right now.</Empty>
            ) : (
              apps.map((a) => {
                const store = inStore.get(a.application);
                const update = store?.versionCode && a.versionCode !== undefined && store.versionCode > a.versionCode ? store : null;
                const job = jobs[a.application];
                return (
                  <AppRow
                    key={a.application}
                    icon={status.bar?.ip ? barAppIconUrl(a.application, status.bar.ip) : null}
                    name={a.appName}
                    sub={[a.versionName && `Version ${a.versionName}`, a.systemApp && "built in", a.screensaver && "screensaver"].filter(Boolean).join(" · ")}
                  >
                    {job ? <JobProgress job={job} /> : (
                      <>
                        {a.config && a.port ? <Button size="sm" onClick={() => openDashboard(a)}><ExternalLink size={12} /> Settings page</Button> : null}
                        {update && (
                          <Button size="sm" disabled={busy} onClick={() => install(a)} title={`Install version ${update.versionName ?? update.versionCode} from the store`}>
                            <ArrowUpCircle size={12} /> Update to {update.versionName ?? update.versionCode}
                          </Button>
                        )}
                        {!a.systemApp && (
                          <Button size="sm" variant="ghost" icon className="danger" disabled={busy} onClick={() => setRemoving(a)} aria-label={`Remove ${a.appName}`} title="Remove from the bar">
                            <Trash2 size={13} />
                          </Button>
                        )}
                      </>
                    )}
                  </AppRow>
                );
              })
            )}
          </div>
        </section>

        <section>
          <h3 className="section-title"><Store size={14} /> From the UltraBar store</h3>
          {market.state === "error" ? (
            <div className="callout warn">
              <AlertTriangle size={14} />
              <div>{market.error} <button className="link" onClick={() => void useApp.getState().loadMarket(true)}>Try again</button></div>
            </div>
          ) : market.state !== "ready" ? (
            <div className="group"><div className="row" style={{ justifyContent: "center", padding: 24 }}><Spinner /></div></div>
          ) : (
            <div className="group">
              {available.length === 0 ? (
                <Empty icon={<Store size={24} />} title="Nothing new">Everything in the store is already on your bar.</Empty>
              ) : (
                available.map((a) => (
                  <StoreRow key={a.application} a={a} job={jobs[a.application]} disabled={!online || busy} onInstall={() => install(a)} />
                ))
              )}
            </div>
          )}
          {market.state === "ready" && available.length > 0 && !online && (
            <p className="faint" style={{ margin: "8px 2px 0", fontSize: 12 }}>Connect to your bar to install apps.</p>
          )}
        </section>
      </div>
      {removing && (
        <RemoveDialog
          app={removing}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            void useApp.getState().uninstallApp(removing.application, removing.appName);
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}

function AppRow({ icon, name, sub, children }: { icon: string | null; name: string; sub: string; children: ReactNode }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="group-row">
      <span className="ico">{icon && !broken ? <img src={icon} alt="" onError={() => setBroken(true)} /> : <Package size={16} />}</span>
      <div className="txt">
        <b>{name}</b>
        {sub && <span>{sub}</span>}
      </div>
      <div className="row" style={{ gap: 6, flex: "none" }}>{children}</div>
    </div>
  );
}

function StoreRow({ a, job, disabled, onInstall }: { a: StoreApp; job?: AppJob; disabled: boolean; onInstall: () => void }) {
  const sub = [a.desc?.trim(), a.versionName && `Version ${a.versionName}`].filter(Boolean).join(" · ");
  return (
    <AppRow icon={a.icon ?? null} name={a.appName || a.application} sub={sub || a.application}>
      {job ? <JobProgress job={job} /> : (
        <Button size="sm" disabled={disabled} onClick={onInstall}><Download size={12} /> Install</Button>
      )}
    </AppRow>
  );
}

const PHASE: Record<AppJob["phase"], string> = {
  starting: "Starting…",
  downloading: "Downloading",
  installing: "Installing",
  uninstalling: "Removing…",
};

function JobProgress({ job }: { job: AppJob }) {
  const pct = job.progress;
  // After 100% Android still optimizes the app for several seconds.
  const label = job.phase === "installing" && pct === 100 ? "Finishing…"
    : pct !== undefined && (job.phase === "downloading" || job.phase === "installing") ? `${PHASE[job.phase]} ${pct}%`
    : PHASE[job.phase];
  return (
    <div className="job" aria-live="polite">
      <span>{label}</span>
      <div className="progress">
        {pct !== undefined ? <div style={{ width: `${pct}%` }} /> : <div className="indeterminate" />}
      </div>
    </div>
  );
}

function RemoveDialog({ app, onClose, onConfirm }: { app: BarApp; onClose: () => void; onConfirm: () => void }) {
  const cards = useApp((s) => s.doc.profiles.reduce((n, p) => n + p.widgets.filter((w) => w.app?.package === app.application).length, 0));
  return (
    <Modal
      title={`Remove ${app.appName}?`}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={onConfirm}>Remove</Button></>}
    >
      <p className="muted" style={{ margin: 0 }}>
        The bar uninstalls the app and its data.
        {cards > 0 && ` ${cards === 1 ? "One card opens" : `${cards} cards open`} it and won't work until you install it again.`}
      </p>
    </Modal>
  );
}
