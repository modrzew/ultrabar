import { useRef, useState, type CSSProperties } from "react";
import { ImagePlus } from "lucide-react";
import type { Widget } from "../../lib/model";
import { CARD_COLORS, GLYPHS, GLYPH_COLORS, glyphPng, imageFilePng } from "../../lib/icons";
import { Field, Segmented, Slider } from "../ui";
import { useApp } from "../../lib/store";

type Setter = (mut: (w: Widget) => void, coalesceKey?: string) => void;

export function IconEditor({ w, set }: { w: Widget; set: Setter }) {
  const [tab, setTab] = useState<"symbol" | "image">(w.icon?.kind === "image" ? "image" : "symbol");
  const file = useRef<HTMLInputElement>(null);
  const toast = useApp((s) => s.toast);
  const glyph = w.icon?.kind === "glyph" ? w.icon.glyph : null;
  const color = w.icon?.kind === "glyph" ? w.icon.color : "#ffffff";
  const src = w.icon ? (w.icon.kind === "url" ? w.icon.url : w.icon.png) : null;

  const setGlyph = async (g: string, c: string) => {
    const png = await glyphPng(g, c);
    set((x) => { x.icon = { kind: "glyph", glyph: g, color: c, png }; });
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const png = await imageFilePng(f);
      set((x) => { x.icon = { kind: "image", png }; x.iconScale = Math.max(x.iconScale, 80); });
    } catch {
      toast({ kind: "error", title: "Couldn't read that image" });
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 14 }}>
        <div className="icon-preview" style={{ background: w.bgColor ?? "#24252b", "--scale": `${w.iconScale}%` } as CSSProperties}>
          {src && <img src={src} alt="" />}
        </div>
        <div className="grow stack" style={{ gap: 8 }}>
          <Segmented full value={tab} onChange={setTab} options={[{ value: "symbol", label: "Symbol" }, { value: "image", label: "Image" }]} />
          <Field label="Size" aside={<span className="faint mono" style={{ fontSize: 11 }}>{w.iconScale}%</span>}>
            <Slider min={20} max={100} value={w.iconScale} onChange={(v) => set((x) => { x.iconScale = v; }, "scale")} />
          </Field>
        </div>
      </div>

      {tab === "symbol" ? (
        <>
          <div className="glyph-grid">
            {Object.entries(GLYPHS).map(([name, Icon]) => (
              <button key={name} type="button" aria-pressed={glyph === name} title={name.replace(/-/g, " ")} onClick={() => void setGlyph(name, color)}>
                <Icon size={16} />
              </button>
            ))}
          </div>
          <Field label="Symbol color">
            <div className="swatches">
              {GLYPH_COLORS.map((c) => (
                <button key={c} type="button" className="swatch" style={{ background: c }} aria-pressed={glyph !== null && color === c}
                  aria-label={c} onClick={() => glyph && void setGlyph(glyph, c)} disabled={!glyph} />
              ))}
            </div>
          </Field>
        </>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
          <button type="button" className="add-row" onClick={() => file.current?.click()}><ImagePlus size={14} /> Choose an image…</button>
          <span className="faint" style={{ fontSize: 11.5 }}>PNG with a transparent background looks best. The bar loads icons from this computer, so keep the app running when you deploy.</span>
        </div>
      )}

      <Field label="Card color">
        <div className="swatches">
          {CARD_COLORS.map((c) => (
            <button key={c} type="button" className="swatch" style={{ background: c }} aria-pressed={(w.bgColor ?? "#24252b") === c} aria-label={c}
              onClick={() => set((x) => { x.bgColor = c; })} />
          ))}
          <label className="swatch custom" title="Custom color" aria-pressed={!CARD_COLORS.includes(w.bgColor ?? "#24252b")}>
            <input type="color" value={w.bgColor ?? "#24252b"} onChange={(e) => set((x) => { x.bgColor = e.target.value; }, "bg")} />
          </label>
        </div>
      </Field>
    </div>
  );
}
