# UltraWorkSpace desktop UI — structure & behaviour notes

For building a similar configurator (web or native). Reconstructed from the Qt app's compiled UI classes (`UM::*`), its embedded Qt stylesheets (`resources/theme/dark/*.qss`), and object names. Layout intent is solid; exact pixel sizes are runtime-computed and only partially recoverable.

The app is **Qt 6 Widgets**, frameless (uses FramelessHelper) with a custom title bar, single dark theme, English + Simplified-Chinese strings. It's a **project-based editor**: you open a `.umpf` project file (local SQLite), edit a visual model of the bar, and **Deploy** pushes it to the hardware. The editor is the source of truth; the bar never sends its config back.

---

## Design tokens (from the QSS — directly reusable)

Dark, flat, rounded, one accent.

| Token | Value | Use |
|---|---|---|
| App background | `#2b2d30` | main window canvas |
| Panel / title bar | `#3c3f43` | title bars, raised panels |
| Panel alt / group | `#343538`, `#2e3134`, `#313232` | nested panels, list group headers |
| Card background | `#232426` / `#23272a` | widget cards, list content items |
| Bar "screen" | `#0e0f0f` (near-black) | the simulated device display |
| Divider (dark) | `#1e1f22` | 1px separators |
| Divider (light) | `#42454d` / `#4a4d50` | panel borders |
| Text | `#f1f1f1` | primary |
| **Accent (selection/primary)** | `#515ff8` / `#4e5ae1` | selected item, primary button, checked tab |
| Danger | `#d24d4d` | disconnect / delete buttons |
| Status online | `#57965c` (green `#3a8b04` dot) | |
| Status connecting | `#e0d63c` (amber) | |
| Status offline | `#d9534f` (red, dot `#8b0404`) | |
| Radius | 4px (items), 6px (buttons), 17px (big rounded panels), 20px (cards) | |
| Hover convention | overlay the base with a low-alpha white, e.g. `#20f5f5f5` | hover; `#30f5f5f5` pressed |
| Card name font | 10px; section titles 14px | |

Buttons come in three QSS styles reused everywhere: `primary_button` (accent fill), `red_button` (danger), plain `windowButton` (ghost/icon).

---

## Top-level flow

1. **StartWindow** (launcher). Left: big logo + "Welcome to **Ultra WorkSpace**" + version. Right (`rightPanel`): "Recent Project List" with New Project / Open buttons, or an empty-state ("No recent projects found. You can create a new project or open an existing one."). Recent list persists in `recent_project_list.json`. New → **NewProjectWindow** (Project Name + Save Path chooser → creates the `.umpf`).
2. **MainWindow** opens on a project. This is the editor (below).
3. Secondary windows launched from the title bar: **StoreWindow** (apps/plugins), **SettingsWindow** (just "Launch at startup" today), **Automation** window, and the **MainCoreBarDialog** (find/connect a bar).

---

## MainWindow layout (the important one)

A single editor screen, left-to-right columns separated by 1px `divider`s:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ MainTitleBar:  [≡ menu] [Automation] [App & Plugin Store]   [Deploy project]│
│                                         … [Close Project][Save As][Settings]│
├──────────────┬──────────────────────────────────────────────┬──────────────┤
│ LEFT RAIL    │  CENTER: CoreBar editor                       │ RIGHT:       │
│              │                                               │ Widget List  │
│ Profile      │  MainCoreBarWidget (status header):           │ (palette)    │
│  selector    │   [CoreBar name ▾] [● Online/Offline] [⟳]     │              │
│  + device    │                                               │ grouped,     │
│  list        │  CoreBarDeviceScreenUI:                       │ collapsible  │
│              │   the simulated bar screen (#0e0f0f), a        │ catalog of   │
│              │   HORIZONTAL STRIP of cards you scroll/drag    │ draggable    │
│              │                                               │ widgets      │
│              │  (selecting a card swaps the right side to     │              │
│              │   its Params Editor instead of the palette)    │              │
└──────────────┴──────────────────────────────────────────────┴──────────────┘
```

### MainTitleBar
Fixed-height bar (`#3c3f43`). Left: hamburger menu (`:/main/image/window_menu.png`) → Close Project / Save Project As / Settings. Then **Automation** and **App and Plugin Store** entry buttons (icon + label). Right: the prominent **Deploy project** button (`deployButton`) — disabled/"CoreBar is offline" when not connected. Standard window min/max/close live in the frameless chrome.

### Left rail — profiles + devices
- **MainProfileWidget** (`profilePanel`, rounded 17px): a "Profile ▾" dropdown. Picking shows the profile list; "New Profile…" opens a small Name dialog; each item has a ⋮ menu → Rename / Delete (with "This action cannot be undone." confirm). The selected profile item is filled with the accent (`#515ff8`). **A profile is a full saved layout of the bar**; switching profiles swaps the whole strip.
- **MainDeviceListWidget**: list of attached hardware (the Core Bar itself as `CoreBarDeviceUI`, plus add-on modules). Empty state: "Before adding a module, you need to add the CoreBar first." → "Add Now". Online/offline shown with the green/red pill (`deviceModuleOnline/Offline`). Add-on module UIs exist for dot-key, knob-key, sense-cube, vivo-cube (each drawn as a little device graphic).

### Center — the simulated bar display (this is the core interaction)
- **MainCoreBarWidget** is a status header: CoreBar name dropdown, a colored status label (Online `#57965c` / Connection… `#e0d63c` / Offline `#d9534f`) with icon, a reconnect button, and "Change CoreBar".
- **CoreBarDeviceScreenUI** renders the physical bar's screen as a **near-black horizontal strip** that scrolls sideways; it logs `cardX / cardWidth / scrollX / screenWidth`, i.e. cards are laid out in a single horizontal row sized to the real screen's aspect. Each card = one widget on the device.
- **Drag & drop**: the strip is a drop target for MIME type **`application/core-bar-widget`**. You drag an item from the right-hand palette onto the strip to add a widget; drag cards within the strip to reorder (that's the `DragFlowLayout` family — `DragFlowLayout`/`DragFlowLayoutContainer`/`DragFlowLayoutWidget`). A dropped item carries `{id, from, widgetType, config, configPanel, screen}`.
- **Selecting a card** opens its editor on the right (the right column is effectively a stack: palette when nothing is selected, Params Editor when a card is selected).

### Right column — two modes
1. **CoreBarWidgetListPanel** (`coreBarWidgetListPanel`, `#242424`): the **widget palette**. A titled ("Widget List") vertical list of **collapsible groups**, each group a category of draggable widgets:
   - `basic` — Clock, World Clock, Accu Weather, Timer, White Noise
   - `pcCtrl` — System (CPU / Memory / Storage / Network) + PC Control actions
   - `multiAction` — Multi-Action
   - `app` — installed apps (from the bar)
   - `homeAssistant` — HA scenes/entities (loaded live)
   - `module` — module-specific widgets (Sense Cube sensors, PC Boot…)
   - `pcCtrlGroup` — shortcut groups
   - plus per-plugin groups appended dynamically
   Group header `#2e3134`, content item `#23272a`, both with pressed-state overlays.
2. **MainProfileParamsEditor** (`mainProfileParamsEditorTitleBar`): title "Params Editor", a **Save** (primary) + **Reset** button row, and a `QStackedWidget` body that swaps in the editor for whichever card type is selected. "Save successful" toast on save.

### Per-card config editors (what each widget exposes)
Each card type has a `newConfigEditor`. Common pattern: a **Name** field, an **Icon** row with a **CoreBarCardIconEditor** (icon preview + "+Zoom In" / "-Zoom Out", "Zoom: N%"; this is the `iconScale`), then type-specific fields:
- **Clock**: none. **Timer**: HH:MM:SS. **World Clock**: time-zone (from `time_zone.json`). **Weather**: lat/lon. **White Noise**: soundscape picker (`white_noise_sound_list.json`).
- **PC Control** (`CoreBarCardPCCtrlEditor`): a `type` selector — `hotKey`, `inputText`, `openFileOrFolder`, `startApp`, `openBrowser`, `execCmd` — each with its own inputs (hotkey recorder, text box, file/app picker, URL, command). Builds the nested `deploymentData.param.payload` scene-action structure.
- **Multi-Action**: an ordered **Action List** editor (add/remove scene actions).
- **App / HA / module / PC-boot / Sense-cube**: pick the backing device/app/entity.

---

## Connect-a-bar dialog (MainCoreBarDialog)

"Search Core Bar" header with a busy spinner (`coreBusy`). A table (`coreBarList`) with columns **IP** and **SN** (header `listHeader`, `columnDivider`); rows (`listItem`) highlight with the accent when selected. Buttons: **Manual** (type IP/SN by hand), **Select**, **Add**. On pick it logs `sn / ip / port`, pairs, and saves the bar into the project. This is the front-end over the UDP discovery + `act 101` pairing.

---

## Behaviour notes worth copying

- **Project model, explicit deploy.** All edits are local and instant; nothing touches the bar until **Deploy**. Deploy then runs the ordered push (modules → profiles → app configs → automations → asset-zip upload). A web UI should mirror this: edit a local model, then one "Deploy" action.
- **Profiles = full layouts.** The top-level unit is a profile (a complete ordered set of widgets). Switching profiles swaps everything. Keep that as your primary object.
- **The bar is a 1-D strip.** Not a grid — a single horizontal row of fixed-aspect cards. Design the canvas as a horizontally scrolling track with drag-to-reorder and drag-from-palette-to-add.
- **Palette ↔ inspector swap.** The right column is the palette by default and becomes the selected card's property inspector on selection — a familiar builder pattern.
- **Icons are per-widget with a zoom/scale.** Each card has an image plus an `iconScale` (default 60, editable via +/- zoom). Local images get uploaded as assets on deploy; `http(s)` icons are passed through.
- **Status is always visible** (online/connecting/offline with color), and Deploy is gated on a live connection.
- **Empty states everywhere** ("No recent projects", "No CoreBar Added", "No profile") with a primary call-to-action — worth replicating.

## Source pointers
- Stylesheets (colors/sizes, directly readable): `ubx/resources/theme/dark/*.qss` — especially `base.qss`, `main_window.qss`, `home_window.qss`, `home_core_bar_dialog.qss`.
- Layout logic: the `UM::*` classes in the macOS binary (`mac_x64_dm.dis`); key ones named above. Re-extract any class's layout with `tools/uinotes.py mac_x64_dm.dis 'UM::ClassName'`.
- Protocol those UIs drive: `PROTOCOL.md`.

---

# Addendum: config editors & the Automation window

## The single most important thing: config forms are schema-driven
Don't hand-build a form per widget/action. The app has **one generic form renderer** that builds controls from a component/param spec the **bar** returns (via `act 1205`, `30700`, `30751`, etc.). Replicate that renderer once and every widget, scene action, app capability, and automation trigger gets its form "for free," including future ones you've never seen.

A component/param spec item looks like:
```json
{
  "id": "1",
  "key": "property",                 // or used as the output id
  "label": "Target value",           // field label (also seen as "name")
  "uiType": "INPUT|SELECT|SEEKBAR|COLOR_PICKER",
  "inputType": "INT|STR",            // for INPUT
  "options": [{"label":"On","value":"1"}],   // for SELECT
  "min": 1, "max": 100, "unit": "second",    // for INPUT/SEEKBAR
  "required": true,
  "dataSource": {"act": 30702, "dependsOn": ["id"]}  // populate SELECT by calling this act
}
```

**Exactly four control types** (classes `UM::Action*ConfigItem`, renderer `SceneActionConfigPanel` / `AutoConfigInputUI`):
| uiType | control | notes |
|---|---|---|
| `INPUT` | text/number field | `inputType INT` → integer only (regex `^-?[0-9]+$`) + range check; errors "No data entered", "The entered number is out of range." `unit` shown as suffix. |
| `SELECT` | dropdown | from static `options[]`, or fetched live via `dataSource.act`; empty → "options is empty". |
| `SEEKBAR` | slider | `min`/`max` (e.g. brightness 1–100). |
| `COLOR_PICKER` | color swatch | renders a colored ■; value is a color string. |

**Cascading selects**: a field with `dataSource.dependsOn:["id","property"]` re-queries its `act` whenever a parent field changes (device → property → value). The renderer disables children until parents are set ("Please select '%1' first.") and validates required fields on save ("Please configure '%1'"). A Refresh (⟳) button re-fetches any select.

Each filled control emits `params:[{id, value, desc}]`; the panel wraps them into the action's `deployData` as `{id, type, values:[{id, value, …}]}` plus a human-readable `configDesc` string (e.g. "App Capability: <app> -> <action> (param=val)"). The scene-action `type` is one of `PC_CONTROL`, `APP_CAPABILITY`, `PLUGIN_WIDGET`, `VIVO_CUBE_TOGGLE`.

## Per-widget editors (the non-generic bits)
Most widgets wrap the above with a **Name** field and an **Icon** row (preview + "+Zoom In"/"-Zoom Out", "Zoom: N%" → `iconScale`). Specifics:
- **Timer**: Name + Hour / Min / Second spinboxes → `param.time "HH:MM:SS"`.
- **World Clock**: Name + Time Zone dropdown (from `time_zone.json`, shows "City - Country", stores `timeZone` + `offset`, default `GMT+0:00`).
- **Weather**: latitude / longitude. **White Noise**: soundscape picker. **Clock**: nothing.
- **PC Control**: a `type` selector — `hotKey`, `inputText`, `openFileOrFolder`, `startApp`, `openBrowser`, `execCmd` — each swapping in its own control (hotkey recorder, text box, file/app picker, URL field, command field).
- **Multi-Action**: Name + Icon + a reorderable **Action List** (`SceneActionListWidget`: "Add Action", drag-to-sort rows, each row opens the `SceneActionPicker`).
- **Shortcut Group / HA Scene / App**: Name/Icon + pick the backing entity.
- **Module tap widgets** (knob/key modules): `TapDetailConfigPanel` — per-event ("Event N", single/double/long) enable toggle + a **Tap Rhythm** picker with 5 preset rhythms (`mode1`–`mode5`) and a **Play** preview.

## SceneActionPicker (the "choose an action" dialog)
Two-pane modal titled **"Action Configuration"**: left = a tree/list of action categories (lazy-loaded via `act 1205`, Reload button), right = a `QStackedLayout` that shows the selected action's generated config form (`SceneActionConfigPanel`). Footer: Add (primary) / Cancel. This same picker is reused by Multi-Action widgets and by automation actions.

## Automation window (separate window, opened from the title bar)
Its own window titled **"Automation"** with a **Deploy Automation** button (deploys via `act 30500/30501`, separate from the main profile deploy).

- **List view**: a vertical list of automations (`AutoListItem`), each showing a two-line summary — **"When** … **Then do** …" — with a ⋮ menu (Edit / Rename / Delete). Empty item → "Empty Automation". A **Create Automation** button at the bottom.
- **AutoDetailsEditor** ("Automation Editor", Cancel / Save): two stacked sections:
  - **"When"** — "Any trigger you add here will start this automation." + **Add Trigger**.
  - **"Then do"** — add actions (reuses the SceneActionPicker).
  - Saves `{id, name, enabled, show, type:"AUTO", triggers:[{type, params}], actions:[…deployData]}`.
- **Add Trigger flow**: `AutoTriggerTypeList` ("Trigger Types", Refresh) → pick a type → `AutoTriggerTypeDetail`/`AutoTriggerSelector` renders that type's params with the **same schema-driven renderer** (`AutoConfigInputUI`, cascading selects via `dataSource`). Trigger types come from `act 30700` (e.g. Device State, Profile change, App listen, Numeric threshold); their dropdowns come from `30701/30702/30703/30710/30720/30721`.

## Critical takeaways you shouldn't miss
1. **Build the generic schema-form renderer first** (INPUT/SELECT/SEEKBAR/COLOR_PICKER + cascading `dataSource` selects + required-validation + Refresh). It powers widget configs, scene actions, app capabilities, plugin widgets, and automation triggers. This is ~80% of the real UI work and makes you forward-compatible with widgets/apps you haven't seen.
2. **Automations are a separate module** with their own window, editor, deploy action, and opcodes — not part of the profile/widget flow.
3. **Actions are reused everywhere** via one SceneActionPicker (multi-action cards, shortcut groups, automation "then do"). Model "action" as a first-class reusable object with `{type, deployData{values[]}, configDesc}`.
4. **Icon + zoom is a standard sub-control** on nearly every widget (`iconScale`).
5. Everything that fills a dropdown may need a **live call to the bar** (`dataSource.act`), so your form layer needs to be async and support dependency-ordered refresh.
