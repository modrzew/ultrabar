import { useEffect, useState } from "react";
import { AlertTriangle, Check, Download, LayoutGrid, Plus, RefreshCw, Search } from "lucide-react";
import { api, type InstalledPack, type StorePlugin } from "../lib/api";
import { useApp } from "../lib/store";
import { packWidget, usableButtons, useStoreSearch } from "../lib/market";
import { isMac } from "../lib/hid";
import { Button, Empty, Modal, Spinner } from "./ui";

/** Shortcut packs from the UltraBar store. Installing one keeps it on this
 * computer and lists it in the card list: the whole pack as a shortcut-group
 * card (tapping it on the bar opens a page of buttons), and each button as
 * its own card or action. */
export function PackBrowser({ profileId, index, onClose }: { profileId: string; index?: number; onClose: () => void }) {
  const market = useApp((s) => s.market);
  const installed = useApp((s) => s.packs.list);
  const busy = useApp((s) => s.packs.busy);
  const [query, setQuery] = useState("");
  const search = useStoreSearch(query, api.storePlugins);
  const plugins = search.results ?? market.plugins;

  useEffect(() => {
    void useApp.getState().loadMarket();
  }, []);

  const install = async (p: StorePlugin, update: boolean) => {
    const s = useApp.getState();
    const done = await s.installPack(p);
    if (!done) return;
    const skipped = done.pack.buttons.length - usableButtons(done.pack).length;
    s.toast({
      kind: "success",
      title: `${update ? "Updated" : "Installed"} ${done.plugin.name}`,
      body: `Its buttons are in the card list now. ${skipped ? `${skipped === 1 ? "One button was" : `${skipped} buttons were`} left out: packs can only add shortcuts, text and web links.` : ""}`.trim(),
    });
  };

  const add = async (p: InstalledPack) => {
    const s = useApp.getState();
    const { widget } = await packWidget(p.pack, p.plugin);
    s.addWidget(profileId, widget, index);
    s.toast({ kind: "success", title: `Added ${widget.name}`, body: `${widget.group?.buttons.length ?? 0} buttons. Deploy to send it to the bar.` });
    onClose();
  };

  return (
    <Modal title="Shortcut packs" icon={<LayoutGrid size={16} className="faint" />} onClose={onClose} wide>
      <p className="muted" style={{ margin: "0 0 14px" }}>
        Ready-made sets of buttons from the UltraBar store. Install a pack to find it in the card list: the whole pack as one card that opens a page of buttons, or any button on its own.
        {isMac && " Most packs use Windows shortcuts (Ctrl rather than ⌘)."}
      </p>
      <div className="input-affix" style={{ marginBottom: 12 }}>
        <Search size={13} style={{ position: "absolute", left: 9, color: "var(--text-3)" }} />
        <input className="input" style={{ paddingLeft: 28 }} placeholder="Search packs" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-label="Search packs" autoFocus />
        {search.loading && <span className="suffix"><Spinner /></span>}
      </div>
      {search.error ? (
        <Empty icon={<AlertTriangle size={22} />} title="Couldn't search the store">{search.error}</Empty>
      ) : market.state === "error" && !search.results ? (
        <Empty icon={<AlertTriangle size={22} />} title="Couldn't load the store" action={<Button onClick={() => void useApp.getState().loadMarket(true)}>Try again</Button>}>
          {market.error}
        </Empty>
      ) : market.state !== "ready" && !search.results ? (
        <div className="row" style={{ justifyContent: "center", padding: 32 }}><Spinner /></div>
      ) : !plugins.length ? (
        search.results
          ? <Empty icon={<Search size={22} />} title="No matches">Nothing in the store matches “{query.trim()}”.</Empty>
          : <Empty icon={<LayoutGrid size={22} />} title="No packs in the store" />
      ) : (
        <div className="group">
          {plugins.map((p) => {
            const have = installed.find((x) => x.plugin.id === p.id);
            const newer = !!have && (p.versionCode ?? 0) > (have.plugin.versionCode ?? 0);
            const working = busy[p.id];
            return (
              <div className="group-row" key={p.id}>
                <span className="ico">{p.icon ? <img src={p.icon} alt="" /> : <LayoutGrid size={16} />}</span>
                <div className="txt">
                  <b>{p.name}{have && !newer && <span className="chip ok" style={{ marginLeft: 8 }}><Check size={10} /> Installed</span>}</b>
                  <span>{[p.desc, p.author && `by ${p.author}`, p.versionName].filter(Boolean).join(" · ")}</span>
                </div>
                {working ? <Spinner /> : !have ? (
                  <Button size="sm" onClick={() => void install(p, false)}><Download size={13} /> Install</Button>
                ) : (
                  <div className="row" style={{ gap: 6 }}>
                    {newer && <Button size="sm" onClick={() => void install(p, true)}><RefreshCw size={12} /> Update</Button>}
                    <Button size="sm" onClick={() => void add(have)} title="Add the whole pack as one card"><Plus size={13} /> Add to profile</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
