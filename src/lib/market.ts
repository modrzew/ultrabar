// Shortcut packs from the vendor's store become shortcut-group cards. (Store
// apps need nothing here: the bar downloads and installs them itself.)
import { useEffect, useState } from "react";
import { errorMessage, type InstalledPack, type Pack, type StorePlugin } from "./api";
import type { GroupButton, IconSpec, PcControl, Widget } from "./model";
import { uid } from "./model";
import { PC_ACTIONS, newWidget, pcMeta } from "./widgets";
import { glyphPng, imageUrlPng } from "./icons";
import { isSendableKey, sentKeys } from "./hid";

/** A pack button's `param` as an action this app can edit, or null.
 *
 * Only what the store's packs use is accepted: shortcuts the bar types itself
 * (keyboard keys, and the media, browser, app and power keys its hub can
 * send), typed text, and web links. Commands, programs, files and other URL
 * schemes would let a downloaded pack run things on this computer, so they're
 * left out (they can still be set up by hand). */
export function packAction(param: unknown): PcControl | null {
  const p = (param ?? {}) as { output?: unknown; keys?: unknown; payload?: { action?: unknown; params?: Record<string, unknown> } };
  if (p.output === 5) {
    const keys = Array.isArray(p.keys) ? (p.keys as unknown[]) : [];
    if (!keys.length || !keys.every((k) => typeof k === "number" && isSendableKey(k))) return null;
    // As the bar sends them: a special key alone.
    return { action: "hotkey", keys: sentKeys(keys as number[]) };
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

export type PackButton = Pack["buttons"][number];

/** A pack's buttons this app can use (see `packAction`), with their actions.
 * `index` is the button's place in the pack. */
export function usableButtons(pack: Pack): { b: PackButton; pc: PcControl; index: number }[] {
  return pack.buttons.flatMap((b, index) => {
    const pc = packAction(b.param);
    return pc ? [{ b, pc, index }] : [];
  });
}

export function buttonName(b: PackButton, pc: PcControl) {
  return b.name.trim() || PC_ACTIONS[pc.action].label;
}

/** One button of an installed pack as its own computer-action card, with the
 * button's icon (or the action's symbol) as the card's symbol at 50%, the
 * official app's default for these cards (`CBPluginWidgetItem`). */
export async function buttonWidget(b: PackButton, pc: PcControl): Promise<Widget> {
  const art = b.icon ? await imageUrlPng(b.icon, 256).catch(() => null) : null;
  const glyph = pcMeta(pc).glyph;
  const icon: IconSpec = art ? { kind: "image", png: art } : { kind: "glyph", glyph, color: "#ffffff", png: await glyphPng(glyph, "#ffffff") };
  return newWidget("PC_CONTROL", { name: buttonName(b, pc), pc, icon, iconScale: 50 });
}

/** Whether the store has a newer version of an installed pack. */
export function packUpdate(installed: InstalledPack, store: StorePlugin[]): StorePlugin | null {
  const latest = store.find((p) => p.id === installed.plugin.id);
  return latest && (latest.versionCode ?? 0) > (installed.plugin.versionCode ?? 0) ? latest : null;
}

/** The card for a downloaded pack. `skipped` counts buttons left out by `packAction`. */
export async function packWidget(pack: Pack, plugin: StorePlugin): Promise<{ widget: Widget; skipped: number }> {
  const usable = usableButtons(pack);
  const buttons: GroupButton[] = await Promise.all(
    usable.map(async ({ b, pc }) => ({
      uid: uid("b"),
      name: buttonName(b, pc),
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

export interface StoreSearch<T> {
  /** Null while the search box is empty. */
  results: T[] | null;
  loading: boolean;
  error: string | null;
}

/** The store's own keyword search, sent once typing pauses. `fetch` must be
 * a stable function (e.g. `api.storeApps`). */
export function useStoreSearch<T>(query: string, fetch: (keyword: string) => Promise<T[]>): StoreSearch<T> {
  const [state, setState] = useState<StoreSearch<T>>({ results: null, loading: false, error: null });
  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) {
      setState({ results: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(() => {
      fetch(keyword).then(
        (results) => !cancelled && setState({ results, loading: false, error: null }),
        (e) => !cancelled && setState({ results: [], loading: false, error: errorMessage(e) }),
      );
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, fetch]);
  return state;
}
