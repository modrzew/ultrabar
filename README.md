# UltraBar

A desktop app (Tauri 2 + React) for configuring an UltraBar X display bar over the local network. It replaces the vendor's UltraWorkSpace app.

## Run

```sh
bun install
bun run tauri dev        # development
bun run tauri build      # macOS: produces src-tauri/target/release/bundle/{macos,dmg}
```

Requires Rust (stable) and Bun. macOS asks for **Local Network** access on first launch; allow it, or the app can't find the bar. Typing text into other apps ("Type text" actions) needs **Accessibility** access for UltraBar.

## What it does

- **Connect:** finds bars by UDP broadcast (or by IP) and pairs once (tap Approve on the bar). Reconnects automatically, re-discovers the bar if its IP changes, and remembers the pairing per bar.
- **Profiles:** full layouts edited on a to-scale preview of the bar (1424×280). Drag cards from the library or click to add, drag to reorder, ⌫ to delete, ⌘D to duplicate, ⌘Z/⇧⌘Z to undo/redo.
- **Cards:** clock, world clock, weather, timer, soundscape, bar settings, apps installed on the bar, smart-home devices, computer actions (keyboard shortcut, open app/website/file, run command, type text) and multi-action cards. Icon cards get a symbol or image, card color and size.
- **Automations:** "when X then Y" rules built from the bar's own trigger and action catalogs (profile changes, app state, device state and thresholds).
- **Modules:** scan for and add add-on modules. The module list is only sent once you manage modules here (no firmware OTA).
- **Integrations:** AccuWeather key and units, Home Assistant URL and token.
- **Deploy:** sends everything in one go. It flags unfinished cards first, and switches the bar to the profile you're looking at.
- **Computer actions:** the bar asks this app to open/run things. Only actions from the layout you last deployed are executed; anything else is blocked and logged (Settings).
- **Layout file:** export/import as JSON (Settings).

The bar can't report its configuration back, so this app's layout (stored in the app data directory) is the source of truth.

## Known limitations

- **Firmware 1.0.1 can't run computer-action or multi-action cards when they're tapped.** Both are bugs in the bar's own click handlers (details in `PROTOCOL.md`). The same actions work from automations. The editor shows a note on those cards when the connected bar runs 1.0.1.
- Custom icons are served from this computer, so keep the app running when you deploy. The bar caches them afterwards (multi-action artwork wasn't seen to load on 1.0.1).
- World clocks use a fixed UTC offset (the bar has no DST rules); redeploy after a DST change.
- Module discovery and the module list are implemented from the protocol but untested without hardware. Per-module button bindings aren't implemented yet.
- Weather needs your own AccuWeather API key.

## Layout

```
src-tauri/src/
  connection.rs   TLS session actor: auth/pairing, heartbeat, request/reply matching, reconnect
  discovery.rs    UDP discovery
  pc_agent.rs     bar → computer requests, allowlist
  icons.rs        LAN HTTP server for custom icons
  store.rs        settings (client id, tokens, allowlist) and the layout file
  protocol.rs, tls.rs, lib.rs (Tauri commands)
src/
  lib/            store (zustand), deploy payload builder, widget catalog, HID keys, time zones
  views/          profile editor, automations, modules, integrations, apps, settings
  components/     cards, library, inspector + editors, action picker, connect sheet, UI kit
```

Running the frontend in a plain browser (`bun run dev`) uses an in-memory mock bar (`src/lib/mock.ts`), which is handy for UI work.

Protocol notes: `PROTOCOL.md` (including findings from building this app). UI notes from the original app: `UI_NOTES.md`.
