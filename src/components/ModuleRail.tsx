// Add-on modules drawn next to the bar preview, where the user placed them.
import type { CSSProperties } from "react";
import type { ModuleEndpoint, ModuleSetup } from "../lib/model";
import { DOT_KEYS, KNOB_BUTTON, PRODUCTS } from "../lib/modules";
import { keyRuns } from "../lib/deploy";
import { useApp } from "../lib/store";

/** One module as a small device. `active` keys are tinted (they do something
 * in this profile); `selectedKey` is outlined; `onKey` makes keys clickable. */
export function ModuleDevice({ m, setup, selectedKey, onKey, size }: {
  m: ModuleEndpoint;
  setup?: ModuleSetup;
  selectedKey?: string;
  onKey?: (code: string) => void;
  size: string;
}) {
  const keyClass = (code: string) =>
    `mod-key${keyRuns(setup?.keys?.[code]) ? " active" : ""}${selectedKey === code ? " selected" : ""}${onKey ? " click" : ""}`;
  // Keys are buttons only when they can be picked (the tile itself is a button).
  const key = ({ code, style, title, children, extra = "" }: { code: string; style?: CSSProperties; title: string; children?: React.ReactNode; extra?: string }) =>
    onKey ? (
      <button type="button" className={`${keyClass(code)}${extra}`} style={style} title={title} aria-pressed={selectedKey === code}
        onClick={(e) => { e.stopPropagation(); onKey(code); }}>{children}</button>
    ) : (
      <span className={`${keyClass(code)}${extra}`} style={style}>{children}</span>
    );
  if (m.productId === "DOT_KEY") {
    // 140 × 140 body; keys 56 × 56, 56 × 56 and 56 × 118 with 6 px gaps (the official app's drawing).
    const [top, bottom, tall] = DOT_KEYS;
    return (
      <div className="mod-body mod-dotkey" style={{ "--m": size } as CSSProperties}>
        {key({ code: top.code, title: top.label, style: { left: "7.9%", top: "7.9%", width: "40%", height: "40%", borderRadius: "50%" } })}
        {key({ code: bottom.code, title: bottom.label, style: { left: "7.9%", top: "52.1%", width: "40%", height: "40%", borderRadius: "50%" } })}
        {key({ code: tall.code, title: tall.label, style: { left: "52.1%", top: "7.9%", width: "40%", height: "84.3%", borderRadius: "999px" } })}
      </div>
    );
  }
  if (m.productId === "KNOB_KEY") {
    const turns = !!(setup?.knob?.left || setup?.knob?.right);
    return (
      <div className="mod-body mod-knob" style={{ "--m": size } as CSSProperties}>
        {key({ code: KNOB_BUTTON, title: "Press", extra: ` knob-cap${turns ? " turns" : ""}`, children: <span className="knob-dot" /> })}
      </div>
    );
  }
  const Icon = PRODUCTS[m.productId]?.icon;
  return (
    <div className="mod-body mod-other" style={{ "--m": size } as CSSProperties}>
      {Icon && <Icon size="40%" strokeWidth={1.5} color="rgba(255,255,255,0.55)" />}
    </div>
  );
}

/** Modules on one side of the bar, nearest to the bar first. */
export function ModuleSide({ side, modules, profileId }: { side: "left" | "right"; modules: ModuleEndpoint[]; profileId: string }) {
  const selected = useApp((s) => s.selectedModule);
  const online = useApp((s) => s.moduleOnline);
  const connected = useApp((s) => s.status.state === "online");
  const setups = useApp((s) => s.doc.profiles.find((p) => p.id === profileId)?.modules);
  if (!modules.length) return null;
  const ordered = side === "left" ? [...modules].reverse() : modules;
  return (
    <div className={`mod-side ${side}`}>
      {ordered.map((m) => {
        const state = connected ? online[m.serialNumber] : undefined;
        return (
          <button
            key={m.serialNumber} type="button"
            className={`mod-tile${selected === m.serialNumber ? " selected" : ""}`}
            title={`${m.name}${state === false ? " (not attached)" : ""}`}
            onClick={(e) => { e.stopPropagation(); useApp.getState().selectModule(m.serialNumber); }}
          >
            <ModuleDevice m={m} setup={setups?.find((x) => x.serialNumber === m.serialNumber)} size="100%" />
            {state !== undefined && <span className={`mod-state${state ? " on" : ""}`} />}
            <span className="mod-name truncate">{m.name}</span>
          </button>
        );
      })}
    </div>
  );
}
