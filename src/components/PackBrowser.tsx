import { useEffect, useState } from "react";
import { AlertTriangle, LayoutGrid, Plus, Search } from "lucide-react";
import { api, errorMessage, type StorePlugin } from "../lib/api";
import { useApp } from "../lib/store";
import { packWidget, useStoreSearch } from "../lib/market";
import { isMac } from "../lib/hid";
import { Button, Empty, Modal, Spinner } from "./ui";

/** Shortcut packs from the UltraBar store. Adding one downloads it and puts a
 * shortcut-group card into the profile. */
export function PackBrowser({ profileId, index, onClose }: { profileId: string; index?: number; onClose: () => void }) {
  const market = useApp((s) => s.market);
  const [adding, setAdding] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const search = useStoreSearch(query, api.storePlugins);
  const plugins = search.results ?? market.plugins;

  useEffect(() => {
    void useApp.getState().loadMarket();
  }, []);

  const add = async (p: StorePlugin) => {
    const s = useApp.getState();
    setAdding(p.id);
    try {
      const pack = await api.storePluginPack(p);
      const { widget, skipped } = await packWidget(pack, p);
      s.addWidget(profileId, widget, index);
      const n = widget.group?.buttons.length ?? 0;
      s.toast({
        kind: "success",
        title: `Added ${widget.name}`,
        body: skipped
          ? `${n} buttons. ${skipped === 1 ? "One more was" : `${skipped} more were`} left out: packs can only add shortcuts, text and web links.`
          : `${n} buttons. Deploy to send it to the bar.`,
      });
      onClose();
    } catch (e) {
      s.toast({ kind: "error", title: `Couldn't add ${p.name}`, body: errorMessage(e) });
    } finally {
      setAdding(null);
    }
  };

  return (
    <Modal title="Shortcut packs" icon={<LayoutGrid size={16} className="faint" />} onClose={onClose} wide>
      <p className="muted" style={{ margin: "0 0 14px" }}>
        Ready-made sets of buttons from the UltraBar store. A pack becomes one card; tapping it on the bar opens a page of buttons.
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
          {plugins.map((p) => (
            <div className="group-row" key={p.id}>
              <span className="ico">{p.icon ? <img src={p.icon} alt="" /> : <LayoutGrid size={16} />}</span>
              <div className="txt">
                <b>{p.name}</b>
                <span>{[p.desc, p.author && `by ${p.author}`].filter(Boolean).join(" · ")}</span>
              </div>
              <Button size="sm" disabled={adding !== null} onClick={() => void add(p)}>
                {adding === p.id ? <Spinner /> : <Plus size={13} />} Add
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
