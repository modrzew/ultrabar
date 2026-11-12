# UltraBar

A desktop app (Tauri 2 + React) for configuring an UltraBar X display bar over the local network. It replaces the vendor's UltraWorkSpace app.

## Run

```sh
bun install
bun run tauri dev        # development
bun run tauri build      # macOS: src-tauri/target/release/bundle/{macos,dmg}; Windows: bundle/nsis
```

Requires Rust (stable) and Bun. macOS asks for **Local Network** access on first launch; allow it, or the app can't find the bar. Typing text into other apps ("Type text" actions) needs **Accessibility** access for UltraBar.

## Releases and updates

Run the **Release** workflow (Actions → Release → Run workflow, pick the version bump). It sets the version, tags it, publishes a GitHub release listing the commits since the last one, and then **Apps** builds the macOS app (Apple Silicon `.dmg`) and the Windows app (64-bit `-setup.exe`), attaches them with the update packages, and writes the update manifest (`latest.json`). If one platform's build fails, the manifest only offers the other; re-run the failed job to add it.

The app checks for a newer release at launch and every hour. When there is one, **Update available** appears above the bar's card in the sidebar; it shows what's new, then downloads the update, replaces the app in place and restarts it.

- **First install on a Mac:** open the `.dmg` from the release and drag UltraBar to Applications. It isn't notarized, so macOS blocks the first launch: allow it under System Settings › Privacy & Security › Open Anyway. Updates after that need nothing, because the app downloads them itself and macOS doesn't quarantine them.
- **First install on Windows:** run the `-setup.exe` from the release. It isn't code signed, so SmartScreen warns first: More info › Run anyway. It installs for your user, without admin rights. Allow UltraBar on private networks when Windows Firewall asks: the bar connects back to it, for custom icons among other things. Updates reinstall over the same folder, so neither question comes back.
- **Signing (macOS):** every release is signed with the same self-signed certificate, so macOS keeps UltraBar's permissions (Accessibility for "Type text") across updates. An ad-hoc signature would change with every build and drop them. Don't replace the certificate: a new one resets those permissions on every Mac once.
- **Repo secrets:** `TAURI_SIGNING_PRIVATE_KEY` (signs the update; the public key is in `tauri.conf.json`), `MACOS_SIGNING_CERTIFICATE` (base64 of the `.p12`) and `MACOS_SIGNING_CERTIFICATE_PASSWORD`. Keep copies of the originals: without the updater key, installed apps can't update.

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
- "Type text" actions only work on macOS so far; on Windows they report an error.

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
