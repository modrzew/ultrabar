// Shortcut packs from the vendor's store become shortcut-group cards. (Store
// apps need nothing here: the bar downloads and installs them itself.)
import type { Pack, StorePlugin } from "./api";
import type { GroupButton, IconSpec, PcControl, Widget } from "./model";
import { uid } from "./model";
import { PC_ACTIONS, newWidget } from "./widgets";
import { glyphPng, imageUrlPng } from "./icons";

/** A pack button's `param` as an action this app can edit, or null.
 *
 * Only what the store's packs use is accepted: shortcuts the bar types itself,
 * typed text, and web links. Commands, programs, files and other URL schemes
 * would let a downloaded pack run things on this computer, so they're left out
 * (they can still be set up by hand). */
export function packAction(param: unknown): PcControl | null {
  const p = (param ?? {}) as { output?: unknown; keys?: unknown; payload?: { action?: unknown; params?: Record<string, unknown> } };
  if (p.output === 5) {
    const keys = Array.isArray(p.keys) ? p.keys : [];
    return keys.length && keys.every((k) => Number.isInteger(k) && k > 0 && k < 256) ? { action: "hotkey", keys: keys as number[] } : null;
  }
  if (p.output !== 10 || !p.payload) return null;
  const params = p.payload.params ?? {};
  const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : "");
  switch (p.payload.action) {
    case "inputText":
      return str("text") ? { action: "inputText", text: str("text") } : null;
    case "openBrowser": {
      const url = str("url").trim();
      return /^https?:\/\/\S+$/i.test(url) ? { action: "openBrowser", url } : null;
    }
    default:
      return null;
  }
}

/** The card for a downloaded pack. `skipped` counts buttons left out by `packAction`. */
export async function packWidget(pack: Pack, plugin: StorePlugin): Promise<{ widget: Widget; skipped: number }> {
  const usable = pack.buttons.flatMap((b) => {
    const pc = packAction(b.param);
    return pc ? [{ b, pc }] : [];
  });
  const buttons: GroupButton[] = await Promise.all(
    usable.map(async ({ b, pc }) => ({
      uid: uid("b"),
      name: b.name.trim() || PC_ACTIONS[pc.action].label,
      span: b.spanSize === 2 ? 2 as const : 1 as const,
      icon: (b.icon ? await imageUrlPng(b.icon).catch(() => null) : null) ?? (await glyphPng(PC_ACTIONS[pc.action].glyph, "#ffffff")),
      pc,
    })),
  );
  const art = pack.icon ? await imageUrlPng(pack.icon, 256).catch(() => null) : null;
  const icon: IconSpec = art
    ? { kind: "image", png: art }
    : { kind: "glyph", glyph: "layout-grid", color: "#ffffff", png: await glyphPng("layout-grid", "#ffffff") };
  const widget = newWidget("HOT_KEY_GROUP", {
    name: plugin.name.trim() || pack.name,
    icon,
    iconScale: 60,
    group: { buttons, pack: { id: plugin.id, name: plugin.name, versionCode: plugin.versionCode ?? undefined } },
  });
  return { widget, skipped: pack.buttons.length - buttons.length };
}
