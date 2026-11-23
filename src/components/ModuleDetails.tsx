// What the bar knows about one module, as in the official app's "Detail"
// dialog: name, product, serial number, net ID, and the module's own software
// version, read from the module while the bar is online.
import { useEffect, useState } from "react";
import { Boxes, RefreshCw } from "lucide-react";
import { ACT, api, errorMessage } from "../lib/api";
import { PRODUCTS } from "../lib/modules";
import { useApp } from "../lib/store";
import { Button, InlineInput, Modal, Spinner } from "./ui";

type Version = { state: "loading" } | { state: "ok"; value: string } | { state: "error"; message: string } | { state: "offline" };

/** Reads a module's app version (act 30200, property 5 of device 0). The
 * module answers `{result: "<version>"}`. */
export async function readModuleVersion(serialNo: string): Promise<string> {
  const r = await api.request<{ result?: unknown }>(ACT.readModuleProperty, { serialNo, deviceId: 0, propertyId: 5, extra: null }, 8000);
  const v = r && typeof r === "object" ? r.result : r;
  if (v === undefined || v === null || v === "") throw new Error("The module didn't report a version.");
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function ModuleDetails({ serial, onClose }: { serial: string; onClose: () => void }) {
  const m = useApp((s) => s.doc.modules.find((x) => x.serialNumber === serial));
  const barOnline = useApp((s) => s.status.state === "online");
  const managed = useApp((s) => s.doc.modulesManaged);
  const attached = useApp((s) => s.moduleOnline[serial]);
  const [version, setVersion] = useState<Version>({ state: "offline" });

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!barOnline) {
      setVersion({ state: "offline" });
      return;
    }
    let cancelled = false;
    setVersion({ state: "loading" });
    readModuleVersion(serial).then(
      (value) => !cancelled && setVersion({ state: "ok", value }),
      (e) => !cancelled && setVersion({ state: "error", message: errorMessage(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [serial, barOnline, attempt]);

  if (!m) return null;
  const product = PRODUCTS[m.productId];
  const Icon = product?.icon ?? Boxes;
  const rename = (name: string) => useApp.getState().update((d) => {
    const x = d.modules.find((y) => y.serialNumber === serial);
    if (x) x.name = name;
  });

  return (
    <Modal title="Module details" icon={<Icon size={16} className="faint" />} onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}>
      <div className="details">
        <span>Name</span>
        <InlineInput className="input" value={m.name} onCommit={rename} />
        <span>Product</span>
        <span>{product?.name ?? m.productId} <span className="faint mono">{m.productId}</span></span>
        <span>Serial number</span>
        <span className="mono">{m.serialNumber || "—"}</span>
        <span>Net ID</span>
        <span className="mono">{m.netId ?? "—"}</span>
        <span>Connection</span>
        <span>{m.interfaceType === "mesh" ? "Wireless" : "Attached to the bar"}{barOnline && attached !== undefined ? ` · ${attached ? "online" : "not attached now"}` : ""}</span>
        <span>App version</span>
        <span className="row" style={{ gap: 6 }}>
          {version.state === "loading" ? <Spinner />
            : version.state === "ok" ? <span className="mono">{version.value}</span>
            : version.state === "offline" ? <span className="faint">Connect to your bar to read it</span>
            : <span className="faint">{version.message}</span>}
          {barOnline && version.state !== "loading" && (
            <Button variant="ghost" icon size="sm" onClick={() => setAttempt((n) => n + 1)} title="Read again" aria-label="Read the version again"><RefreshCw size={12} /></Button>
          )}
        </span>
      </div>
      <p className="faint" style={{ margin: "14px 0 0", fontSize: 12 }}>
        {managed ? "Deploy sends a new name to the bar." : "The name is only used in this app until you add a module here, after which Deploy sends your module list to the bar."}
      </p>
    </Modal>
  );
}
