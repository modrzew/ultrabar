import { useEffect, useRef, useState } from "react";
import { Boxes, Check, Info, Plus, ScanSearch, Trash2 } from "lucide-react";
import { ModuleDetails } from "../components/ModuleDetails";
import { PRODUCTS, productKey } from "../lib/modules";
import { ACT, api, errorMessage, on, type PushEnvelope } from "../lib/api";
import { useApp } from "../lib/store";
import type { ModuleEndpoint } from "../lib/model";
import { Button, Empty, InlineInput, Spinner } from "../components/ui";

/** Discovery replies carry the module's endpoint as JSON; field names vary
 * slightly between module types, so read them leniently. */
function toEndpoint(raw: unknown): ModuleEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const serial = String(o.serialNumber ?? o.serialNo ?? o.sn ?? "");
  const uidv = String(o.uid ?? o.id ?? o.netId ?? serial);
  if (!serial && !uidv) return null;
  const productId = productKey(o.productId ?? o.product ?? o.type);
  return {
    uid: uidv, serialNumber: serial, productId,
    name: String(o.name ?? PRODUCTS[productId]?.name ?? "Module"),
    interfaceType: String(o.interfaceType ?? "can"),
    netId: typeof o.netId === "number" ? o.netId : undefined,
    workMode: typeof o.workMode === "number" ? o.workMode : undefined,
    extraConfig: o.extraConfig,
  };
}

export function ModulesView() {
  const doc = useApp((s) => s.doc);
  const online = useApp((s) => s.status.state === "online");
  const s = useApp.getState();
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<ModuleEndpoint[]>([]);
  const [details, setDetails] = useState<string | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let off: (() => void) | undefined;
    void on<PushEnvelope>("bar-push", (e) => {
      if (e.act !== ACT.moduleDiscovered) return;
      const ep = toEndpoint(e.data);
      if (ep) setFound((f) => (f.some((x) => x.uid === ep.uid && x.serialNumber === ep.serialNumber) ? f : [...f, ep]));
    }).then((u) => (off = u));
    return () => {
      off?.();
      clearTimeout(stopTimer.current);
    };
  }, []);

  useEffect(() => () => { if (scanning) void api.request(ACT.moduleDiscoveryStop).catch(() => {}); }, [scanning]);

  const scan = async () => {
    setFound([]);
    setScanning(true);
    try {
      await api.request(ACT.moduleDiscoveryStart, "");
      clearTimeout(stopTimer.current);
      stopTimer.current = setTimeout(() => {
        setScanning(false);
        void api.request(ACT.moduleDiscoveryStop).catch(() => {});
      }, 20000);
    } catch (e) {
      setScanning(false);
      s.toast({ kind: "error", title: "Couldn't start scanning", body: errorMessage(e) });
    }
  };

  const add = (m: ModuleEndpoint) => void s.addModule(m);
  const added = (m: ModuleEndpoint) => doc.modules.some((x) => x.serialNumber === m.serialNumber);
  const onlineMap = useApp((st) => st.moduleOnline);
  useEffect(() => { void s.loadModuleState(); }, [doc.modules.length, online, s]);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1>Modules</h1>
            <p>Add-on keys, knobs and cubes that attach to the bar. Once added, they appear next to the bar in each profile, where you choose what their keys do.</p>
          </div>
          <Button variant={doc.modules.length ? "default" : "primary"} disabled={!online || scanning} onClick={() => void scan()}>
            {scanning ? <Spinner /> : <ScanSearch size={14} />} {scanning ? "Scanning…" : "Scan for modules"}
          </Button>
        </div>

        {(scanning || found.length > 0) && (
          <section>
            <h3 className="section-title">{scanning ? <><Spinner /> Looking for modules. Attach one now or press its pairing button.</> : "Found"}</h3>
            <div className="group">
              {found.length === 0 && <div className="group-row faint">Nothing yet…</div>}
              {found.map((m) => <ModuleRow key={`${m.uid}:${m.serialNumber}`} m={m} action={added(m) ? <span className="chip ok"><Check size={11} /> Added</span> : <Button size="sm" onClick={() => add(m)}><Plus size={12} /> Add</Button>} />)}
            </div>
          </section>
        )}

        {doc.modulesManaged && doc.modules.length > 0 && (
          <div className="callout">
            <Info size={14} />
            <div>Deploy sends this list to the bar, and the bar forgets modules that aren't on it. Keep every module you use here.</div>
          </div>
        )}

        <section>
          {doc.modules.length > 0 && <h3 className="section-title">Your modules</h3>}
          <div className="group">
            {doc.modules.length === 0 ? (
              <Empty icon={<Boxes size={24} />} title="No modules added">
                {online ? "Attach a module to the bar, then scan to add it." : "Connect to your bar to scan for modules."}
                {!doc.modulesManaged && <><br />Until you add one here, Deploy leaves the bar's existing module setup alone.</>}
              </Empty>
            ) : (
              doc.modules.map((m, i) => (
                <ModuleRow key={`${m.uid}:${i}`} m={m} editable online={online ? onlineMap[m.serialNumber] : undefined}
                  onRename={(name) => s.update((d) => { d.modules[i].name = name; })}
                  action={<>
                    <Button variant="ghost" icon size="sm" title="Details" aria-label={`Details of ${m.name}`} onClick={() => setDetails(m.serialNumber)}><Info size={14} /></Button>
                    <Button variant="ghost" icon size="sm" className="danger" title="Remove" onClick={() => s.update((d) => {
                    const serial = d.modules[i].serialNumber;
                    d.modules.splice(i, 1);
                    // Its key setups and position go too.
                    for (const p of d.profiles) p.modules = p.modules?.filter((x) => x.serialNumber !== serial);
                    if (d.modulePlacement) delete d.modulePlacement[serial];
                  })}><Trash2 size={14} /></Button>
                  </>} />
              ))
            )}
          </div>
        </section>
      </div>
      {details && <ModuleDetails serial={details} onClose={() => setDetails(null)} />}
    </div>
  );
}

function ModuleRow({ m, action, editable, onRename, online }: { m: ModuleEndpoint; action: React.ReactNode; editable?: boolean; onRename?: (n: string) => void; online?: boolean }) {
  const product = PRODUCTS[m.productId];
  const Icon = product?.icon ?? Boxes;
  return (
    <div className="group-row">
      <span className="ico"><Icon size={16} /></span>
      <div className="txt">
        {editable && onRename ? <InlineInput className="input" value={m.name} onCommit={onRename} /> : <b>{m.name}</b>}
        <span>{product?.name ?? m.productId} · {m.serialNumber || m.uid}{m.interfaceType === "mesh" ? " · wireless" : ""}</span>
      </div>
      {online !== undefined && <span className={`chip${online ? " ok" : ""}`}>{online ? "Attached" : "Not attached"}</span>}
      {action}
    </div>
  );
}
