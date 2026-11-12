import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Blocks, ExternalLink, Package, RefreshCw } from "lucide-react";
import { useApp, type BarApp } from "../lib/store";
import { isTauri } from "../lib/api";
import { barAppIconUrl } from "../lib/deploy";
import { Button, Empty } from "../components/ui";

export function AppsView() {
  const apps = useApp((s) => s.catalog.apps);
  const status = useApp((s) => s.status);
  const [refreshing, setRefreshing] = useState(false);
  const online = status.state === "online";

  const refresh = async () => {
    setRefreshing(true);
    await useApp.getState().loadCatalog();
    setRefreshing(false);
  };

  const openDashboard = (a: BarApp) => {
    const url = `http://${status.bar?.ip}:${a.port}?sessionToken=${encodeURIComponent(a.sessionToken ?? "")}`;
    if (isTauri) void openUrl(url);
    else window.open(url, "_blank");
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1>Apps on the bar</h1>
            <p>Apps installed on your bar. Add them to a profile from the card library; some also have their own settings page.</p>
          </div>
          <Button disabled={!online || refreshing} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
        </div>
        <div className="group">
          {!online ? (
            <Empty icon={<Blocks size={24} />} title="Bar not connected">Connect to your bar to see which apps it has.</Empty>
          ) : apps.length === 0 ? (
            <Empty icon={<Package size={24} />} title="No extra apps">The bar only has its built-in features right now.</Empty>
          ) : (
            apps.map((a) => <AppRow key={a.application} a={a} ip={status.bar?.ip} onOpen={() => openDashboard(a)} />)
          )}
        </div>
      </div>
    </div>
  );
}

function AppRow({ a, ip, onOpen }: { a: BarApp; ip?: string; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="group-row">
      <span className="ico">{ip && !broken ? <img src={barAppIconUrl(a.application, ip)} alt="" onError={() => setBroken(true)} /> : <Package size={16} />}</span>
      <div className="txt">
        <b>{a.appName}</b>
        <span>{a.application}{a.versionName ? ` · ${a.versionName}` : ""}{a.systemApp ? " · built in" : ""}</span>
      </div>
      {a.config && a.port ? <Button size="sm" onClick={onOpen}><ExternalLink size={12} /> Open settings page</Button> : null}
    </div>
  );
}
