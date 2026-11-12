# UltraBar X ("Core Bar") LAN protocol

Reverse engineered from **UltraWorkSpace V1.0.1.0**. Both installers contain the same Qt6/C++ app. The macOS build still has its C++ symbols, so most of this comes from its x86_64 slice. The Windows `.exe` has the same strings and constants.

Confidence markers: **[C]** = read directly from the code. **[I]** = inferred, check against a real bar.

---

## TL;DR

- The **bar is the server**. The PC app is a client that finds it by UDP broadcast and then opens a **TLS 1.3 TCP socket that carries newline-delimited JSON**. This is not a REST/HTTP JSON API. **[C]**
- There is HTTP, but only for side channels: a **zip upload of images on `:8080`**, and **per-app web dashboards** that apps on the bar serve on their own ports. **[C]**
- Commands are **integer opcodes** (`"act": 1108`). A request and its reply share the same `"id"`. Success is `"code": 200`. **[C]**
- Pairing happens once: send `act 101` and press **approve on the bar within 15 s** to get a token. After that, every connection starts with `act 100` and that token. **[C]**
- **A browser can't open raw TLS sockets or send UDP.** A web UI needs a small local bridge (Node/Python) that speaks this protocol and exposes HTTP/WebSocket to the page. `client/ubx_client.py` is a working stdlib reference for that bridge.
- The bar **does not give the configuration back**. There's no "get profiles" command. The PC app is the source of truth (it keeps a SQLite project file) and re-sends everything on every deploy. Your web UI has to store its own state.

---

## 1. Ports

| Port | Proto | Direction | Purpose |
|---|---|---|---|
| 5319 | UDP | PC ⇄ bar (broadcast) | Discovery **[C]** |
| `tcpPort` (taken from the discovery reply) | TCP + TLS 1.3 | PC → bar | Command channel, JSON lines **[C]** |
| 8080 | HTTP | PC → bar | Asset upload: `POST /upload/zip`, `POST /upload?serialNo=…` **[C]** |
| per app (`config.port`) | HTTP | browser → bar | App dashboards: `http://<ip>:<port>?sessionToken=<t>` **[C]** |

## 2. Discovery (UDP 5319)

- The PC binds UDP `0.0.0.0:5319` (ShareAddress | ReuseAddressHint) and sends the **18 raw ASCII bytes** `discovery.ultrabar` to the subnet broadcast address on port **5319**, **every 2 s**. **[C]**
- The bar replies with a JSON datagram. The app reads three keys and ignores datagrams from its own IP: **[C]**

```json
{"serialNo": "UBX…", "ip": "192.168.1.50", "tcpPort": 12345}
```

The bar most likely replies to the sender's address and port, so binding 5319 like the app does is the safe option. **[I]**

**Observed on a real bar (2026-11-12):** it answers both unicast and subnet-broadcast probes, one datagram per probe, sent from port 5319. It includes two extra fields the app doesn't read:

```json
{"tcpPort":7431,"ver":"1.0.1(1)","ip":"192.168.1.175","name":"ultrabar","serialNo":"5001G26071XS0016"}
```

## 3. Transport

- `connectToHostEncrypted(ip, tcpPort)` with a 5 s connect timeout. **[C]**
- TLS: protocol pinned to **TLS 1.3**, `PeerVerifyMode = VerifyNone`, `ignoreSslErrors()`. A CA cert is bundled (`CN=ultrabar.local`, O=sanytron, Shenzhen) but **it is never used to verify anything**. Any TLS 1.3 client with verification turned off can connect. **[C]**
- Framing: each message is one JSON object followed by `\n`. The receiver buffers, splits on `\n`, trims, and skips empty lines. **[C]**

## 4. Message envelope

```json
{"id": "42", "act": 1103, "code": 200, "msg": "…", "data": <any JSON>}
```

| Field | Type | Notes |
|---|---|---|
| `id` | **string** | Decimal counter (`std::to_string(++n)`). A reply echoes the request's `id`, and the API layer matches replies by `id`. **[C]** |
| `act` | int | Opcode. A reply echoes the request's `act`. **[C]** |
| `code` | int | Only sent if set. Requests omit it. Replies use **200 = OK**, anything else is an error. **[C]** |
| `msg` | string | Optional error text. Only sent if non-empty. **[C]** |
| `data` | any | Optional payload: object, array, **or a bare string** for some commands. Only sent if non-null. **[C]** |

Reply timeouts in the app: 5 s by default, 8 s for deploys, 3 s for token check, 15 s for token request. **[C]**

## 5. Session lifecycle

### 5.1 Pairing: request a token (`act 101`) **[C]**

```json
→ {"id":"1","act":101,"data":{"name":"Ultra WorkSpace","id":"550e8400-e29b-41d4-a716-446655440000"}}
← {"id":"1","act":101,"code":200,"data":{"state":0}}                 // waiting: approve on the bar
← {"id":"1","act":101,"code":200,"data":{"state":1,"token":"…"}}     // granted
```

- The bar can send **more than one reply to the same `id`**. `state:0` means "waiting for the user", `state:1` comes with the token, and `code != 200` means refused. The app's UI says *"Please authorize it on the [Core Bar] within 15 seconds."*
- The official app always sends that hardcoded client `id` (it's the example UUID from Wikipedia). Use your own UUID and `name` so the bar treats your bridge as a separate client. **[I]** (whether the bar shows the name or keys anything off the id is unconfirmed)

### 5.2 On every connect: check the token (`act 100`) **[C]**

```json
→ {"id":"2","act":100,"data":"<token>"}
← {"id":"2","act":100,"code":200}        // anything else → re-pair with act 101
```

The app only checks `act==100 && code==200` here. If no token is stored, it skips straight to `act 101`.

### 5.3 Heartbeat (`act 20`) **[C]**

- 1 s timer. Once authenticated, it sends `{"id":"n","act":20}` when ≥ 3 s have passed since the last heartbeat **and** ≥ 1.5 s since the last received message.
- If nothing is received for 15 s, the link counts as dead. Reconnect + auth is retried every 30 s.

## 6. Commands, PC → bar

`data` shapes come from the code. Response shapes are mostly **unknown** until we query a real bar.

| act | Name (from app) | `data` sent | Notes |
|---|---|---|---|
| 20 | heartbeat | none | |
| 100 | checkToken | `"<token>"` | |
| 101 | requestToken | `{"name","id"}` | multi-reply, see 5.1 |
| 1000 | getAppList | none | Array of installed apps, see 8.2 |
| 1002 | getWidgetList | `"sys.widget.iot"` | Widget/IoT catalog (Home Assistant entities etc.) |
| 1010 | deployAppConfig | `{"packageName", "config":{…}}` | Per-integration config, see 7.3 |
| 1103 | setCurrentProfile | `"<profileId>"` | Switch the active profile |
| 1108 | deployProfiles | `[profile, …]` | **Main layout config**, see 7.2 |
| 1205 | getSceneActionTree | `"<string>"` | Action catalog used by multi-action/automation editors |
| 1617 | getKnobCtrlDeviceTree | `"<string>"` | What a knob module can control |
| 1633 / 1634 | start / stopScanWifiList | none | Results probably arrive asynchronously **[I]** |
| 30100 / 30101 | start / stopDiscoveryModule | `"<string>"` / none | Scan for add-on modules |
| 30103 | pairMeshModule | `{"sn","address"}` | Error codes surface as "Mesh gateway is busy", "Network configuration timeout", "AppKey configuration failed", "Pairing timeout" |
| 30200 | readProperty | `{"serialNo","deviceId","propertyId","extra"}` | Module property read (e.g. VivoCube Wi-Fi config) |
| 30201 | writeProperty | `{"serialNo","deviceId","propertyId","value"}` | Module property write |
| 30300 | deployCoreBarConfig | `{canGateway:{endpoints:[…]}, meshGateway:{endpoints:[…]}}` | Attached modules, see 7.1 |
| 30400 / 30401 | startEpOTA / sendEpOTAData | `{gatewayType,epSn,fileSize,packSize,fileMD5}` / `{gatewayType,packNumber,isEndPack,data}` | Module firmware OTA. **Don't touch casually.** |
| 30500 | deployAutoConfig | `[automation, …]` | see 7.4 |
| 30600 | installApk / uninstallApk | `{"type":1,"appType":n,"packageName"}` / `{"type":2,"packageName"}` | The bar runs Android apps |
| 30700 | getAutoTriggerTypes | none | |
| (dynamic) | getAutoTriggerChildData | caller-supplied | The opcode comes from the trigger-type data |
| 30730 | getModuleOnlineState | `["<uid>", …]` | |
| 30750 | getAppCapabilityActions | `"<packageName>"` | |
| 30751 | getAppCapabilityActionParams | `{"actionId","packageName"}` | |
| 30752 | getAppCapabilityActionParamValues | `{"actionId","packageName","describeId","cursor","limit","params"}` | Paginated (`nextCursor`/`hasMore` in the reply **[I]**) |

## 7. Deploying a configuration

The app's "Deploy" button runs these steps in order and aborts on the first failure: **[C]**

1. Wipe the local temp folder `CoreBarAssets/`.
2. `30300` deployCoreBarConfig (modules)
3. `1108` deployProfiles. Icons for local images get written into `CoreBarAssets/image/` along the way.
4. `1010` deployAppConfig, once per integration that has `needToDeploy` set
5. `30500` deployAutoConfig
6. Zip `CoreBarAssets/` and `POST http://<ip>:8080/upload/zip`, see 9.

### 7.1 `30300` modules **[C]** (structure) / **[I]** (exact nesting)

```json
{
  "canGateway":  {"endpoints": [ <endpoint>, … ]},   // pogo-pin "QuantumLink" modules
  "meshGateway": {"endpoints": [ <endpoint>, … ]}    // wireless mesh modules
}
endpoint = {"interfaceType":"can|mesh","uid":"<int as string>","name":"…","serialNumber":"…",
            "workMode":…, "productId":…, "netId":…, "extraConfig":{…}}
```

If you have no add-on modules, sending both `endpoints` arrays empty should be fine. **[I]**

### 7.2 `1108` profiles **[C]**

`data` is an array with one object per profile:

```json
{
  "id": "<profileId>",
  "name": "Default Profile",
  "showName": true,
  "icon": "<url or file://image/…png>",
  "iconScale": 100,
  "default": true,
  "widget": [ <widget deploymentData>, … ],               // left-to-right order on the bar
  "module": [ {"productId":…, "serialNo":"…", "config":{…}}, … ]   // per-module settings for this profile
}
```

Every widget has the shape `{"id": "<short uuid>", "type": "<TYPE>", "name"?, "icon"?, "iconScale"?, "param"?: {…}}`.

| Card in UI | `type` | `param` / extra fields | |
|---|---|---|---|
| Clock | `TIME` | none | **[C]** |
| Timer | `TIMER` | `name`, `param.time = "HH:MM:SS"` | **[C]** |
| World clock | `WORLD_TIME` | `name` (time-zone name), `param.offset` (from `time_zone.json`) | **[C]** |
| Weather | `WEATHER` | `param.lat`, `param.lon`; needs the AccuWeather integration (7.3) | **[C]** |
| White noise | `SOUNDSCAPE` | `param.id` = sound id, e.g. `sys.app.soundscape.1` (list in `white_noise_sound_list.json`) | **[C]** |
| App | `APPS` | `package`, `iconUrl`, `name` | **[C]** |
| Home Assistant scene | `HA_SCENE` | `name`, `iconUrl`, `iconScale`, `param` (entity from the 1002 catalog) | **[C]** keys / **[I]** param |
| Multi-action | (`SCENE`/`ACTION` items) | `param.actions = [<action deployData>, …]` | **[C]** keys / **[I]** nesting |
| PC control | `PC_CONTROL` | `name`, `icon`, `iconScale`, `param` = action (hotKey / openFileOrFolder / startApp / openBrowser / inputText / execCmd) | **[C]** |
| Shortcut group (plugin) | `HOT_KEY_GROUP` | `name`, `icon`, `iconScale`, `button`, `param` | **[C]** keys |
| System stats | `CPU`, `MEMORY`, `STORAGE`, `NETWORK` | the **bar asks the PC** for the values (see 8) | **[C]** |
| PC boot (module) | `PC_BOOT` | `name`, `param.uid` (module uid) | **[C]** |
| Sense Cube sensors | `SENSE_CUBE`, `SENSE_CUBE_TEMP`, `_HUM`, `_ALS`, `_AUDIO`, `_RADAR` | `name`, `param.uid` | **[C]** |

**Icons:** if `icon` starts with `http`, it's sent as-is. Otherwise the PNG is written to the zip as `image/<widgetUniqueId>.png` and the field becomes `"file://image/<widgetUniqueId>.png"`. **[C]**

**PC_CONTROL and multi-action payloads** follow the bar's generic "scene action" format. The app nests it roughly like this (for `startApp`): **[I]**
`{"type":…, "objectParams":…, "values":[{"id":"1","output":{},"value":{"payload":{"action":"startApp","params":{"path":"…","launchMode":0}}}}]}`
`type` and `objectParams` are copied from the template the bar returns in `1205`. Read that template from the bar before building these.

### 7.3 `1010` integrations **[C]**

Example: AccuWeather.

```json
{"packageName":"com.ultrabar.weather","config":{"apiKey":"<your key>","metric":true}}
```

### 7.4 `30500` automations **[C]** keys / **[I]** nesting

```json
[{"id":"<uuid>","name":"…","enabled":true,"show":…,"type":"AUTO",
  "triggers":[{"type":"…","params":{…}}],
  "actions":[ <action deployData>, … ]}]
```

Trigger types come from `30700`/`getAutoTriggerChildData`.

## 8. Commands, bar → PC (`act 1000000`) **[C]**

The bar also sends requests the other way. `data = {"type": …, "payload": …}`, and the PC answers with the same `id`/`act`, `code 200`, `data:{"type", "payload"}`.

| `type` | What the official app does |
|---|---|
| `TEST` | replies 200 |
| `PC_CONTROL` | `payload.action` ∈ `execCmd {cmd}`, `openFile {path}`, `openBrowser {url}`, `startApp {path, launchMode}`, `inputText {text}`. **It really runs them.** |
| `SET_VOLUME` / `GET_VOLUME`, `SET_MUTE` / `GET_MUTE`, `SET_BRIGHTNESS` / `GET_BRIGHTNESS` | Changes or reads system audio/display (DDC/CI via dxva2 on Windows) |
| `CPU`, `MEMORY`, `STORAGE`, `NETWORK` | Replies with usage numbers (`totalReceived` / `totalSent` for network) |

If your bridge doesn't run a PC agent, **reply with a 200/empty payload or ignore these**. The system-stat and PC-control widgets just won't do anything.

### 8.1 Why your antivirus flagged the app (likely)

The PC app lets the bar trigger shell commands (`execCmd`), keystroke injection (`inputText`, global hotkey hooks), app launches and file opens. The link is TLS with no certificate check and a hardcoded client UUID. It's not necessarily malware, but heuristics often flag a remote-command + input-injection combination like this. Your web-UI approach avoids all of it.

### 8.2 App list item (`1000` reply) **[C]** keys

```json
{"application":"<package>","appName":"…","icon":"<url>","versionName":"…","versionCode":1,
 "systemApp":false,"allowProfile":true,"config":true,"port":9000,"sessionToken":"…"}
```

If `config` is true, the official app shows a "Web UI" button that opens `http://<bar-ip>:<port>?sessionToken=<sessionToken>`. These dashboards are plain HTTP and you can link to them straight from your UI.

## 9. HTTP endpoints (port 8080) **[C]**

- `POST http://<ip>:8080/upload/zip`: `multipart/form-data`, one part `name="file"; filename="core_bar_assets.zip"`, `Content-Type: application/octet-stream`. The zip contains `image/<id>.png`. The reply is JSON `{"state": <int>, "msg": "…"}`. The exact success value of `state` isn't known yet **[I]**. Whether the zip includes a top-level `CoreBarAssets/` folder depends on a pack-mode flag I haven't decoded **[I]**.
- `POST http://<ip>:8080/upload?serialNo=<module SN>`: same multipart format, file `config.tgz`. Used for VivoCube module screen layouts.
- No auth on these is visible in the client code. Don't expose them beyond your LAN.

## 10. Cloud endpoints (optional, not needed for local control)

The app also calls `https://gatewayssl.dev.aiks360.com/api/v1/base-service/pub/...` for the app/plugin store and icon library. Note the `dev` host in a release build. You don't need any of it to configure the bar. The store parts are described in "App and plugin store" at the end.

## 11. Open questions for a live bar

1. ~~Discovery reply format~~ confirmed (section 2). The command port was 7431 on this bar, but it may change, so always take it from discovery.
2. Reply payloads for `1000`, `1002`, `1205`, `30700`. These read-only queries would answer most of the [I] items above.
3. `state` success value from `/upload/zip`. Is the zip uploaded **before** or **after** `1108` taking effect? (The app uploads last.)
4. Whether a minimal `1108` (one profile with a `TIME` widget) is accepted without the earlier `30300` step.

---

# Live findings (bar 192.168.1.175, firmware 1.0.1(1), 2026-11-12)

## Device identity
From the ADB CNXN banner: `ro.product.name=ceres_b6`, `ro.product.model=CB01`, `ro.product.device=ceres-b6`. **The Core Bar is a full Android device.** AndServer (the 8080 HTTP stack) is an Android HTTP library, which fits.

## Open TCP ports
| Port | Service | Notes |
|---|---|---|
| 5555 | **ADB (Android Debug Bridge)** | **Unauthenticated.** First-contact CNXN returns `device::…` with no AUTH challenge → adb auth is disabled (`ro.adb.secure=0`). Anyone on the LAN has full `adb shell` / root-capable access. |
| 7431 | TLS 1.3 command channel | The `tcpPort` from discovery. Confirmed working. |
| 8080 | AndServer/2.1.11 (HTTP) | Asset upload endpoints. `GET /` → 404 `The resource [/] is not found.` |
| 14035 | Custom command console | Greets with `\n>>> `. Rejects input: unknown → `Bad command <x>.`, empty → `Bad command received: (null)`. A proprietary diagnostic/command interface; command vocabulary unknown (not in the PC app binary — it lives in the bar firmware). |

### Security note
Two unauthenticated control surfaces (ADB 5555, console 14035) plus the no-cert-verification TLS channel mean the bar trusts anything on the local network. Fine behind a trusted LAN; do not expose this device to untrusted networks or port-forward it.

## Confirmed protocol behaviour
- Discovery reply carries `tcpPort`, `ver`, `ip`, `name`, `serialNo` (section 2). This bar: `name:"ultrabar"`, `ver:"1.0.1(1)"`, `serialNo:"5001G26071XS0016"`.
- Pairing (`act 101`) works exactly as decoded: `state:0` (waiting for approval on the bar) then `state:1` + `token`. Token check (`act 100`) then accepts on reconnect.
- Replies include a `timestamp` field (epoch ms) not seen in the disassembly, e.g. `{"act":1000,"code":200,"data":[],"id":"60456","timestamp":1794460454093}`.

## Captured read-only replies (no config was written)
- `1000` getAppList → `[]` (no extra apps installed).
- `1002` getWidgetList `"sys.widget.iot"` → `[]` (no IoT/Home-Assistant devices bound).
- `30700` getAutoTriggerTypes → `{triggers:[…], conditions:[…]}`. Labels are Simplified Chinese. Trigger `type`s: `DEVICE_STATE`, `PROFILE`, `APP_STATE`, `NUMERIC`. Each `param` has `{key,label,dataType,uiType,required,dataSource:{act,dependsOn}}`. The `dataSource.act` values are **follow-up opcodes** used to populate SELECT dropdowns: `30701` (device list), `30702` (property list, dependsOn id), `30703` (value list, dependsOn id+property), `30710` (profile list), `30720` (app package list), `30721` (app state list). `validations` carries cross-field rules (e.g. from≠to).
- `1205` getSceneActionTree is a **lazy tree**: send `""` for the root, then re-send with a node `id` to expand it. `last:true` marks a leaf action, `last:false` a branch to expand.
  - root → `DELAY`, `CHANGE_PROFILE` (profiles: `profile_2` "Default Profile", `profile_18` "New Profile"), `PC_CONTROL`, and branches `sc.corebar`, `sc.devices`, `scene`, `sc.other`.
  - `sc.corebar` → `BRIGHT` (Screen Brightness, SEEKBAR 1–100).
  - `sc.devices` → Switch / Light / Air Conditioner / Curtain / Fan / AudioPlayer (all branches).
  - `sc.other` → `ACTIVITY` (App Start), `SOUND_SCAPE` (7 soundscapes, ids `sys.app.soundscape.1..7`), `TIMER` (START/PAUSE/RESUM/CANCEL/RESTART).
  - A leaf action's `components` array is its parameter form: `{id, inputType:INT|STR, uiType:INPUT|SELECT|SEEKBAR, options?, min?, max?, unit?}`.
- `30710` → `[{label:"Default Profile",value:"profile_2",last:true},{label:"New Profile",value:"profile_18",last:true}]`. So this bar has **two profiles** configured (`profile_2`, `profile_18`).

---

# Server-side confirmation (decompiled from the bar's own apps)

Pulled over ADB: `hub.apk` (`com.ultrabar.hub`, serves 7431) and `launch.apk` (`com.ultrabar.launch`, serves 8080). Decompiled with jadx. This section is **[C] from the server code** and supersedes inferences above where they differ.

## Architecture
- `com.ultrabar.hub` is a **thin network front-end**, not the brain. Its `LanUserService` (Netty) terminates TLS, authenticates, then hands each JSON line to `BusinessProcessor`, which **wraps it in an internal binary frame and forwards it over a local MessageBridge to the launcher process** (`com.ultrabar.launch`). The launcher interprets the `act` codes and renders the bar UI. So:
  - Auth (act 100/101), heartbeat, framing, TLS → `hub`.
  - Everything else (1108, 30300, 1000, …) → `launch`.
- One exception: **`act 1010` with `packageName == "com.ultrabar.homeassistant"` is handled inside `hub`** (`HaConfigIntercept`) to validate the Home Assistant `data.config.url` + `data.config.token` before storing.

## Transport (exact)
- Netty pipeline: `SslHandler(TLS1.3, server.crt/server.key from assets)` → `IdleStateHandler(30s read, 40s write, 60s all)` → **`LineBasedFrameDecoder(maxLength=8192)`** → UTF-8 string decode → `TokenAuthHandler` → business handler → `HeartbeatHandler`.
- **Hard limit: 8192 bytes per line.** A single JSON message longer than 8192 bytes (including the newline) is dropped by the frame decoder and the connection may be closed. Large profile/automation deploys must stay under this, or be split. (This is why icons go over HTTP, not inline.)
- Replies always include `timestamp` (epoch ms). `code` 200 = OK, `-1` = auth failure.

## Auth (exact, from `TokenAuthHandler`)
- `act 100` (check token): `data` is the token **string**. If it matches a stored `AuthorizationCode.code` → reply `{"act":100,"code":200,"data":"auth_ok"}` and the socket graduates to business mode. If missing/invalid → `{"act":100,"code":-1,"msg":"auth_fail"}` **and the socket stays open** so you can immediately send `act 101`.
- `act 101` (request token): outer `id`, plus `data.id` (client UUID) and `data.name`.
  1. If 10 clients are already authorized → reject `"license limit reached. Max 10 authorized devices allowed."` **Hard cap of 10 clients.**
  2. Reply `{"act":101,"code":200,"data":{"state":0}}` and play a `key_alert` sound.
  3. The bar shows a confirm dialog titled using the client `name`, **auto-denying after 10 s** (the PC app's "15 seconds" copy is optimistic; the server window is 10 s).
  4. Approve → token. **Idempotent by `data.id`**: re-pairing with the same client UUID returns the *same* token (doesn't consume another of the 10 slots). New UUID → fresh `UUID.randomUUID()` token stored with `{ip, code, name, clientId, create}`.
  5. Reply `{"act":101,"code":200,"data":{"state":1,"token":"<uuid>"}}`. Deny/timeout → `{"act":101,"code":-1,"msg":"denied"}` and the socket closes.
- Token validation is **not IP-bound** (ip is stored but not checked). A token works from any address.
- Any act other than 100/101 **before** auth → connection closed.

## Heartbeat
`HeartbeatHandler` + `IdleStateHandler(30,40,60)`. Our client's 3 s heartbeat is well inside the 30 s read-idle window.

---

# Authoritative opcode table (from `launch.apk` `TCPMessage` enum + `MessageFactory`)

These are the exact names and handler classes. `act` is the enum value. Handlers live in `com.ultrabar.launch.common.communication.message.*`.

| act | Enum name | Handler | Direction / purpose |
|---|---|---|---|
| 10 | ERROR | — | error reply wrapper |
| 11 | EXCEPTION | — | exception reply wrapper |
| 20 | HEARTBEAT_PACKAGE | HeartbeatMessage | PC→bar keepalive. Reply `{"act":20,"code":200,"data":"success"}` (confirmed live) |
| 100 | AUTH | (hub) | check token |
| 101 | REQ_AUTH_TOKEN | (hub) | request token |
| 1000 | GET_APP_LIST | GetAppListMessage | installed Android apps (`HomeDataSource.getInsAppInfo`) |
| 1002 | GET_PROFILE_COMPONENT | GetComponentMessage | widget/component catalog for a profile |
| 1050 | GET_IMAGE | (switch) | **fetch an image from the bar** |
| 1051 | SET_SCENE_IMAGE | (switch) | **push a widget image over the socket** |
| 1052 | SET_SCENE_IMAGE_V2 | (switch) | newer image push |
| 1101 | SINGLE_SAVE_OR_UPDATE_PROFILE | SingleProfileMessage | save one profile (ProfileDTO) |
| 1103 | TRIGGER_PROFILE_CHANGE | (switch) | switch active profile |
| 1108 | BATCH_SAVE_PROFILE | BatchProfileMessage | **save all profiles** (array of ProfileDTO) |
| 1204 | SCENE_TRIGGER | — | fire a scene/action live |
| 1205 | SCENE_ACTION_V2 | GetSceneActionMessage | lazy action tree (send node id, or "") |
| 1300 | GET_DEVICE | (switch) | bound IoT devices (`[]` on this bar) |
| 1400 | DOWNLOAD | — | pull a file the bar hosts |
| 1401 | DOWNLOAD_DEL | — | delete a downloaded file |
| 1402 | LIST_DOWNLOAD_FILE | — | list downloaded files |
| 1500 | LIST_EMAIL_CONFIG | (switch) | the bar can **send email** |
| 1501 | SAVE_EMAIL_CONFIG | (switch) | store SMTP config |
| 1502 | DEL_EMAIL | (switch) | delete email config |
| 1617 | GET_KNOB_FUNCTION_DEVICE | GetSupportKnobMessage | devices a knob can control |
| 1633 | START_SCAN_WIFI | WifiScanStartMessage | scan Wi-Fi for a module |
| 1634 | STOP_SCAN_WIFI | WifiScanStopMessage | |
| 1635 | CUBE_SCAN_WIFI_LIST_RESULT | — | async Wi-Fi scan results |
| 5010 | REPORT_DATA | (switch) | PC→bar data report |
| 5020 | HOT_KEY_GROUP_CLIENT_CALL | (switch) | invoke a hotkey group |
| 5022–5037 | FAST_ACTION_* | (switch) | "Fast Action" set CRUD + broadcast |
| 20100 | SYS_REBOOT | RebootMessage | **reboot the bar** |
| 30100/30101/30102 | MODULE_START/STOP/REPLAY_DISCOVERY | *DiscoverMessage | add-on module discovery |
| 30200/30201 | MODULE_PROPERTY_READ/WRITE | Read/WritePropertyMessage | module properties |
| 30300 | SET_CORE_BAR_CONFIG | CoreBarConfigurationMessage | attached modules + timer configs |
| 30400/30401 | MODULE_OAT_START/DATA | ModuleOta*Message | module firmware OTA |
| 30500/30501 | SINGLE/BATCH_CREATE_SCENE | *CreateSceneMessage | automations |
| 30600/30601 | APP_MANAGER / _PROGRESS_EVENT | AppManagerMessage | install/uninstall apps + progress |
| 30700 | SCENE_GET_TRIGGER_PARAM | TriggerParamMessage | trigger/condition catalog |
| 30701 | SCENE_DEPENDS_DEVICES | GetDependsDeviceMessage | device dropdown source |
| 30702 | SCENE_DEPENDS_DEVICES_PROPERTY | GetDependsPropertyMessage | property dropdown |
| 30703 | SCENE_DEPENDS_DEVICES_PROPERTY_VALUE | GetDependsPropertyValueMessage | value dropdown |
| 30710 | SCENE_DEPENDS_PROFILE | ProfileDependsMessage | profile dropdown |
| 30720 | SCENE_DEPENDS_APPS | AppDependsMessage | app dropdown |
| 30721 | SCENE_DEPENDS_APPS_VALUE | AppDependsValueMessage | app-state dropdown |
| 30800 | METRICS_PULL | MetricsMessage | **PC→bar metrics push** (array of Metric). Feeds CPU/MEM/STORAGE/NETWORK widgets; empty input returns nothing |

Reply wrapper (`Response`): `{"act":<same>,"code":200,"id":<echoed>,"timestamp":<ms>,"msg":<str?>,"data":<any?>}`. Failure uses `code != 200` with `msg`. Internally the launcher also reports `code:6000` "Request api timeout" / `6001` "CoreBar reply error" (seen in the PC client).

## Core deploy schema (act 1108 `BATCH_SAVE_PROFILE`)
`data` = array of **ProfileDTO**:
```
ProfileDTO extends ProfileProperty {
  // from ProfileProperty:
  String id;           // e.g. "profile_2"
  String name;
  String icon;         // url, or file://image/<id>.png (uploaded via HTTP zip or act 1051)
  int    iconScale = 60;
  String bgColor;
  // added by ProfileDTO:
  boolean isDefault;
  List<ModuleConfig> module;    // per-module settings for this profile
  List<WidgetProperty> widget;  // the left-to-right widgets
}
```
**WidgetProperty** (`extends HomeData extends ProfileProperty`):
```
WidgetProperty {
  // ProfileProperty: id, name, icon, iconScale, bgColor
  WidgetType type;                 // enum below (serialized as its name string)
  Object  param;                   // type-specific payload (see section 7.2)
  Boolean last;                    // tree leaf marker
  List<WidgetProperty> node;       // child nodes (for grouped widgets)
  String  parentId;
}
```
**WidgetType** enum (exact accepted `type` strings):
`EMAIL_CARD, TIMER, SOUNDSCAPE, COMPUTER_INFO, SET, APPS, TIME, WORLD_TIME, WEATHER, SWITCH, SCENE, CURTAIN_SWITCH, CURTAIN, LIGHT, LIGHT_TEMP, LIGHT_HS, LIGHT_HS_TEMP, AC, FAN, TEMPERATURE_SENSOR, HUMIDITY_SENSOR, AUDIO_PLAYER, HOT_KEY, PC_CONTROL, ACTION_SET`

This supersedes the PC-app-derived `type` list in 7.2: the bar additionally supports home-automation widgets (SWITCH/LIGHT*/AC/FAN/CURTAIN*/TEMPERATURE_SENSOR/HUMIDITY_SENSOR/AUDIO_PLAYER), EMAIL_CARD, COMPUTER_INFO and ACTION_SET.

## Image handling
Two paths: the HTTP zip (section 9) **or** `act 1051/1052 SET_SCENE_IMAGE(_V2)` over the socket, and `act 1050 GET_IMAGE` to read one back. A pure-socket web bridge can use 1051/1052 and skip the 8080 upload entirely — but mind the 8192-byte line limit (base64 of a PNG will blow past it, so image push is likely chunked; needs confirming before use).

## Live reads captured (bar is in near-factory state)
`GET_APP_LIST`=[], `GET_PROFILE_COMPONENT`=[], `GET_DEVICE`=[], plus the scene/trigger catalogs in the earlier section. So this bar has profiles configured but no apps/IoT devices/modules bound.

---

# Findings while building the Tauri app (2026-11-12, firmware 1.0.1(1))

Verified against the live bar unless marked **[code]** (read from `launch.apk`/`hub.apk` bytecode).

## Catalogs
- `1002` with `""` lists only **installed apps and bound IoT devices** (both empty on a bare bar). Built-in widgets (clock, weather, …) aren't in it; a configurator needs its own palette.
- `1205` leaf ids aren't unique: Soundscape and Timer both use `id:"sound"`. Match on `id` + `type`. The `scene` branch lists stored scenes (`local.scene`, option per scene id).
- Dependent dropdown acts take objects: `30702` → `{"id": …}`, `30703` → `{"id": …, "property": …}`. `30721` returns foreground/background (`"true"`/`"false"`).
- `1010` only accepts `com.ultrabar.weather` (`{apiKey, metric, language}`) and `com.ultrabar.homeassistant` (`{url, token}`) **[code]**.

## Widget payloads (`1108`/`1101`), confirmed by the launcher's converters and holders **[code]**
| type | what the bar reads |
|---|---|
| `TIME` | nothing; double-width card |
| `WORLD_TIME` | `name` (label), `param.offset` = `"GMT+5:30"` / `"GMT-3:00"` / `"GMT+0:00"`. **Must contain `:`** (parsed by `substring`). Fixed offset, no DST. Analog clock face. |
| `TIMER` | `name`, `param.time` = `"HH:MM:SS"`; the widget `id` is what `TIMER` scene actions reference |
| `WEATHER` | `param.lat`, `param.lon` (strings) |
| `SOUNDSCAPE` | the widget **`id` must be the sound id** (`sys.app.soundscape.N`); `param` is ignored |
| `APPS` | the widget **`id` is the package name** |
| `SCENE` | the widget `id` is a scene id from `30500/30501`; tap → run that scene |
| `SET` | the bar's settings panel |
| `PC_CONTROL` | `param = {output:10, payload:{action, params}}` (relayed to PCs) or `{output:5, keys:[…]}` (typed by the bar), `bgColor`, `icon`, `iconScale` |
- Hotkey `keys` are **USB HID usage IDs** (a=4 … z=29, 1..0=30..39, Enter=40, F1=58, modifiers 224–231). The hub writes them to `/dev/hidg0`, so the bar types them as a USB keyboard.
- `ProfileDTO` needs a non-empty `id` and a non-null `widget` array. Sending both `isDefault` and `default` is safe.
- **After `1108` the bar keeps its previous active profile id**, which may no longer exist → it shows "Please go to the software configuration to add widget." Send `1103 <profileId>` after deploying.

## Icons
- This firmware has **no `/upload/zip` route** (404). `8080` only serves `POST /upload?serialNo=` (module `.tgz`) and `GET /widget/icon`.
- Cards load icons with Picasso: `http(s)://`, `file://`, `file:///android_asset/…` work, `data:` URIs don't.
- Built-in icons: `http://<bar>:8080/widget/icon?id=<id>&type=<TYPE>&scheme=<n>` with scheme `ID=1, HOME_TYPE=20, APPLICATION=30, PLAYER=50` (apps: `type=application&scheme=30`).
- The app serves custom PNGs from its own LAN HTTP server (content-hashed URLs, long cache headers) and deploys those URLs.

## Scenes (multi-action, automations)
- `30501` (batch) **replaces all scenes**. `Scene = {id, name, icon, enabled, show, type: MANUAL|AUTO|MODULE, triggers:[{type, params:{key:value}}], conditions:[], actions:[ActionConfig]}`.
- `ActionConfig = {id: <1205 node id>, name, type, objectParams?, values:[{id: <component id>, value}]}`. PC control action: `{id:"1", type:"PC_CONTROL", values:[{id:"1", value:{output, payload|keys}}]}`.
- A `SCENE` card shows the scene's `icon` as its full background **only if the scene id starts with `sys.scene`**; otherwise it shows a stock photo **[code]**.

## Bar → PC push (`act 1000000`)
- Broadcast to every connected client: `{"act":1000000,"code":200,"id":"sys.push.<uuid>","data":{"type":"PC_CONTROL","payload":{"action":"execCmd","params":{"cmd":"…"}}}}`. Verified with an automation.
- This firmware only pushes `PC_CONTROL`, `ULTRA_KEY`, `ULTRA_KEY_SET`. Nothing on the bar consumes metrics (`30800`), so the CPU/RAM widgets of the PC app have no effect here **[code]**.

## Firmware bugs (1.0.1)
- **Tapping a `PC_CONTROL` card fails**: the click handler calls `ParentControlParameter.from(param)`, which only accepts a raw `JSONObject`, but the stored param is a typed `ControlParamter` (fastjson `@type`). NPE, nothing happens. This affects hotkey cards too.
- **Tapping a local scene card fails**: `ExecuteSceneEvent` calls `SceneManager.startScene(id, null)`, and `Scene.execute` calls `callback.onStart` without a null check. The scene also stays marked "executing".
- Automations (`AUTO` scenes) run actions correctly, including PC control.

## Storage
The launcher keeps everything in `/data/data/com.ultrabar.launch/shared_prefs/my_preferences.xml` as fastjson with `@type` tags (readable over the open ADB port).

---

# Firmware 1.0.9 (2026-11-12)

The bar's 1.0.9 update replaced only the launcher (`com.ultrabar.launch` 1.0.1 → 1.0.9). `com.ultrabar.hub` (TLS, framing, pairing, auth) is byte-identical, so the transport, `act 100/101` and the heartbeat are unchanged. The update did **clear all pairings**: every client has to pair again. Verified live unless marked **[code]** (read from the 1.0.9 `launch.apk`).

## Opcodes
The `TCPMessage` enum became `MessageAction` with a handler map (`MessageFactory`). Compared with 1.0.1:
- **Removed:** `1050–1052` (image get/set), `1101` (save one profile), `1400–1402` (downloads), `5010–5037` (report data, hotkey groups, fast actions), `30800` (metrics).
- **Moved:** the batch scene save is now **`30500`** (`30501` is gone; on 1.0.1, `30500` saved a single scene). The batch save still replaces all scenes, and now accepts an empty list.
- **Renamed:** `30300` is `SET_GATEWAY_CONFIG`. Same payload, but it now **destroys every module missing from the list** (`GatewayConfigWrite.clearDevice`) **[code]**.
- **New:** `30104` (gateway pairing result), `30730` (module online state, `["<uid>",…]` → `[{serialNo, online}]`), `30740`/`30741` (read/write bar settings via `{type: BASE_SET|GATEWAY_CONFIG|APP_LIST, …}`) **[code]**, `30742` (screensaver preview), `30750–30752` (app capability actions/params/options).
- `30100` takes `"mesh"` to scan wireless modules; anything else scans the pogo-pin (CAN) bus. Discovery events (`30102`) arrive in the normal envelope.
- `1103` now fails with `msg:"profile id error"` for an unknown profile id.
- **Unknown opcodes** get `{"act":10,"code":200,"id":"<request id> act error"}`. The id doesn't match the request's, so match on the `" act error"` suffix or the request just times out.

## Bar → PC pushes
The launcher wraps pushes in an internal envelope that hub 1.0.1 doesn't know (`Target.CLIENT_REPLY`), so it forwards the wrapper as is. The real message is JSON text in `data.payload`:
```json
{"data":{"integratedId":"tcp","payload":"{\"act\":1000000,\"data\":{\"payload\":{\"action\":\"execCmd\",\"params\":{\"cmd\":\"…\"}},\"type\":\"PC_CONTROL\"},\"id\":\"sys.push.…\"}","response":true},"target":"CLIENT_REPLY"}
```
No top-level `act` or `id`. Reply to the inner envelope as before (`act 1000000`, its `id`, `code 200`); the launcher waits 5 s for that ack **[code]**. A future hub update may forward the inner message directly, so accept both forms. `PushType` also gained `METRIC`, `MODULE_STATE` and `CPU/MEMORY/STORAGE/NETWORK` **[code]**.

## Widgets (`1108`)
- `WidgetType` dropped `COMPUTER_INFO`, `HOT_KEY` and **`SET`**; unknown types render as an "unsupported widget" card ("Not available"). Added `CPU`, `MEMORY`, `STORAGE`, `NETWORK`, `HOT_KEY_GROUP`, `PC_BOOT`, `SENSE_CUBE*`.
- Params now go through per-type converters (`WidgetCoverRegistry`). `PC_CONTROL` cards are **fixed**: tapping runs the action. They **ignore `bgColor`**; the icon (`getScaledBitmap(265, 265, icon, iconScale/100)` after trimming transparent borders) is all there is, so this app sends a full-card image (520×480, color + symbol) with `iconScale: 100`.
- **`SCENE` (multi-action) cards run their own `param`**: `{"type":"ACTION","actions":[ActionConfig,…]}` (also `HA_SCENE`, `LOCAL_SCENE`, which does nothing on tap). The card art is the widget's own `icon`, and the name is printed at the top. Without a `param` the card is blank and inert.
- `SOUNDSCAPE` reads `param.id`; sounds now come from a `com.ultrabar.whitenoise` content provider. The update didn't install that app, so the card shows only ▶ and the bar offers no soundscape actions.

## Screen refresh
After `1108` the launcher no longer redraws the home screen, and `1103` is ignored when the requested profile is already current (also right after a launcher restart, when the current profile is the default one). A redeploy of the visible profile therefore leaves the old cards on screen. `POST :8080/upload/zip` is back (multipart `file` = a `.zip`, query `subDir`, `isFull`) and always triggers a full home-screen reload. **Always pass `subDir`**: `isFull` defaults to `true` and empties the target folder, which without `subDir` is the launcher's whole asset folder. This app uploads an empty zip to `subDir=ultrabar-app&isFull=false` after each deploy (reply `{"msg":"ok","data":0,"state":200}`).

## Action catalog (`1205`)
- Root gains `PLUGIN_WIDGET` (no action behind it) and a stray `{"id":"corebar.volume", …}` slider with no name or type (a launcher bug).
- `sc.corebar` → `BRIGHT` (id now `corebar`, was `bright`) and new `VOLUME` (id `corebar`, value `corebar.volume`, 1–100).
- `sc.other` → `ACTIVITY`, `SOUND_SCAPE` (only with the whitenoise app) and `APP_CAPABILITY` (only with plugin apps). **Timer is no longer listed** (the method exists but isn't called), yet `TimerAction` still runs: `{id:"timer", type:"TIMER", values:[{id:"1", value:<timer widget id>}, {id:"2", value:"START|PAUSE|RESUM|CANCEL|RESTART"}]}` works from multi-action cards and automations.
- `sc.devices` adds `sc.devices.vivo`, `sc.devices.pcboot`.
- Actions still dispatch on `type` and component ids, so actions saved with the 1.0.1 node ids keep working.

## Triggers (`30700`)
`NUMERIC` is gone. `DEVICE_STATE` takes `id`, `property`, `from`, `to`.

## Apps (`1000`)
Now lists installed apps by type (`data` = `"ALL"` default, `"APP"`, `"SCREENSAVER"`). Items add `screensaver` and `configBtnName`; screensavers and Home Assistant come with `allowProfile: false`. On this bar: Calculator, Alarmclock and the StellarRing screensaver. `1002` with `""` now returns a `sys.widget.apps` node.

# App and plugin store (2026-11-12)

Verified against the live bar (launcher 1.0.9) and the vendor's API unless marked **[code]**.

## Catalog (anonymous, no login)
Base: `https://gatewayssl.dev.aiks360.com/api/v1/base-service/pub/`. Replies are `{state, msg, data: {current, size, total, records: [...]}}`.
- **Bar apps:** `POST apps/100/fetchListV2`, body `{"pi": 1, "ps": 50}`. `100` is the `appType` of bar apps. Records: `{application, appName, icon, desc, changeLog, fileUrl, md5, sha256, versionCode, versionName}`. `md5` sometimes holds the SHA-256. Some `fileUrl`s are plain `http://`. On 2026-11-12 there were 15 apps: vendor apps (Whitenoise, Home Assistant, Sonos, Notes, Radio, Files, Calculator, Alarmclock, UltraAgent) and third-party ones.
- **One app:** `POST apps/100/<package>/fetchLastVerV2`, empty body, returns one record. The bar uses this.
- **Plugins:** `GET plugin/page?pi=1&ps=50`. Records: `{id, identifier, name, desc, author, icon, file, sha256, pluginType, official, preview, versionCode, versionName}`. All 9 are `pluginType: 0` (shortcut packs), and their zips match `sha256`.

## Installing apps (`30600` / `30601`)
`data` is `{"type": 0|1|2, "packageName", "appType"}`:
- `type 0` (status): `{"status": "NOT_INSTALLED"|"DOWNLOADING"|"INSTALLING"|"INSTALLED", "versionCode", "versionName"}`. It reports `INSTALLING` for the whole download and install.
- `type 1` (install, `appType: 100`): the bar looks the package up with `fetchLastVerV2`, downloads `fileUrl` and installs it silently with no prompt on the bar. **It doesn't check the hash [code].** It replies `"success"` right away, then sends `30601` events **under the request's id**, to every connected computer. The first event arrives *before* the reply, so match replies on `id` and `act`. Events: `{packageName, type: "STATUS", result: "DOWNLOADING"|"INSTALLING"|"INSTALLED"|"FAIL"}` and `{packageName, type: "DOWNLOAD"|"INSTALL", result: 1–100}`. Installing Whitenoise (about 10 MB) took about 20 s. After `INSTALL 100` there are about 10 more quiet seconds before `INSTALLED`. Only one install runs at a time; a second one fails with `FAIL`. Installing over an installed app updates it.
- `type 2` (uninstall): replies `"success"` when done, in under a second. Built-in apps (`systemApp: true` in `1000`) can't be uninstalled.
- `1000` items carry `versionCode`, so comparing them with the catalog shows available updates.

## Shortcut packs (plugins) and `HOT_KEY_GROUP`
A pack zip has `config.json` `{name, identifier, icon, versionCode, button: [...]}` plus images. Each button is `{id, name, icon, type: "PC_CONTROL", spanSize: 1|2, param}`. `param` is the usual `{output: 5, keys}` (hotkey typed by the bar) or `{output: 10, payload: {action, params}}` (sent to the PC). Icons are `file://<path in zip>` or `http(s)` URLs. The packs use hotkeys, `openBrowser` and `inputText`.

The official app deploys a pack as one `HOT_KEY_GROUP` widget with `param: {button: [...]}`. On the bar it's an icon card with the name at the bottom, drawn like `PC_CONTROL` (`getScaledBitmap(265, 245, …)`). Tapping it opens a page with the buttons in two rows, scrolling sideways; `spanSize: 2` buttons take both rows. Button icons load like card icons and are drawn at `iconScale` (40 if missing). Taps and long presses run `output 5`/`10` like `PC_CONTROL` cards. Buttons whose `type` isn't `PC_CONTROL` do nothing **[code]**. Everything has to fit in the single `1108` line (8 KB), so large packs (Emoji has 64 buttons) need trimming.

