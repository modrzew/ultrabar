import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, CloudSun, Download, Eye, EyeOff, Home, Info, LogOut, MessageCircle, RefreshCw, XCircle } from "lucide-react";
import { HA_PACKAGE, useApp } from "../lib/store";
import { api, errorMessage, isTauri } from "../lib/api";
import { haUrl } from "../lib/deploy";
import { Button, Field, Segmented, Spinner } from "../components/ui";

function open(url: string) {
  if (isTauri) void openUrl(url);
  else window.open(url, "_blank");
}

function Secret({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-affix">
      <input className="input mono" type={show ? "text" : "password"} value={value} placeholder={placeholder} spellCheck={false} autoComplete="off"
        onChange={(e) => onChange(e.target.value)} style={{ paddingRight: 34 }} />
      <button type="button" className="btn ghost icon sm" style={{ position: "absolute", right: 3 }} onClick={() => setShow(!show)} aria-label={show ? "Hide" : "Show"}>
        {show ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
    </div>
  );
}

function StatusLine({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  const Icon = ok ? CheckCircle2 : ok === false ? XCircle : Info;
  const color = ok ? "var(--success)" : ok === false ? "var(--danger)" : "var(--text-3)";
  return (
    <div className="row" style={{ gap: 8, fontSize: 12.5, alignItems: "flex-start" }}>
      <Icon size={14} style={{ color, flex: "none", marginTop: 2 }} />
      <span className="muted" style={{ whiteSpace: "normal" }}>{children}</span>
    </div>
  );
}

export function IntegrationsView() {
  const integ = useApp((s) => s.doc.integrations);
  const s = useApp.getState();
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1>Integrations</h1>
            <p>Services the bar and this computer talk to. Weather and Home Assistant settings are sent to the bar with Deploy.</p>
          </div>
        </div>

        <section>
          <h3 className="section-title"><CloudSun size={14} /> Weather</h3>
          <div className="group"><div className="group-pad">
            <Field label="AccuWeather API key" hint={<>Weather cards need a free key from <button className="link" onClick={() => open("https://developer.accuweather.com/")}>developer.accuweather.com</button>.</>}>
              <Secret value={integ.weather.apiKey} placeholder="Paste your key"
                onChange={(v) => s.update((d) => { d.integrations.weather.apiKey = v; }, "weather-key")} />
            </Field>
            <Field label="Units">
              <div>
                <Segmented value={integ.weather.metric ? "metric" : "imperial"}
                  onChange={(v) => s.update((d) => { d.integrations.weather.metric = v === "metric"; })}
                  options={[{ value: "metric", label: "°C · km/h" }, { value: "imperial", label: "°F · mph" }]} />
              </div>
            </Field>
          </div></div>
        </section>

        <HomeAssistantSection />
        <DiscordSection />
      </div>
    </div>
  );
}

function HomeAssistantSection() {
  const ha = useApp((s) => s.doc.integrations.homeAssistant);
  const online = useApp((s) => s.status.state === "online");
  const loaded = useApp((s) => s.catalog.loaded);
  const haApp = useApp((s) => s.catalog.apps.find((a) => a.application === HA_PACKAGE));
  const devices = useApp((s) => s.catalog.devices.length);
  const loggedIn = useApp((s) => s.haLoggedIn);
  const installing = useApp((s) => !!s.appJobs[HA_PACKAGE]);
  const deployedHash = useApp((s) => s.doc.deployedHash);
  const s = useApp.getState();
  const [checking, setChecking] = useState(false);

  const refresh = async () => {
    setChecking(true);
    await s.loadCatalog().finally(() => setChecking(false));
  };

  const url = ha.url.trim();
  const sent = haUrl(url);
  let host = "";
  try { host = url ? new URL(sent).hostname : ""; } catch { /* shown below */ }
  const local = /^(\d+\.){3}\d+$/.test(host) || host.endsWith(".local") || !host.includes(".");

  return (
    <section>
      <h3 className="section-title"><Home size={14} /> Home Assistant</h3>
      <div className="group"><div className="group-pad">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Put lights, switches and scenes on the bar, use them in automations and control them with a Knob. The bar's Home Assistant app connects to your server; these settings are sent to it with Deploy.
        </p>

        {online && loaded && !haApp && (
          <div className="callout warn">
            <Info size={14} />
            <div className="grow">The bar needs its Home Assistant app first. It's free in the store.</div>
            <Button size="sm" disabled={installing} onClick={() => void s.installApp(HA_PACKAGE, "Home Assistant")}>
              {installing ? <Spinner /> : <Download size={12} />} Install on the bar
            </Button>
          </div>
        )}

        <Field label="Server address"
          hint={url && sent !== url ? <>Sent as <span className="mono">{sent}</span></> : "Use an address the bar can reach on your network, e.g. http://192.168.1.20:8123."}>
          <input className="input mono" placeholder="http://192.168.1.20:8123" value={ha.url} spellCheck={false}
            onChange={(e) => s.update((d) => { d.integrations.homeAssistant.url = e.target.value; }, "ha-url")} />
        </Field>
        {host && !local && (
          <div className="callout">
            <Info size={14} />
            <div>
              This looks like an internet address. If it sits behind a login page (Cloudflare Access, an auth proxy), the bar can't get through.
              Prefer the server's local address, like <span className="mono">http://192.168.1.20:8123</span>.
            </div>
          </div>
        )}
        <Field label="Long-lived access token" hint="Create one in Home Assistant under your profile › Security.">
          <Secret value={ha.token} placeholder="eyJhbGciOi…"
            onChange={(v) => s.update((d) => { d.integrations.homeAssistant.token = v; }, "ha-token")} />
        </Field>

        {online && haApp && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
              <StatusLine ok={loggedIn}>
                {loggedIn
                  ? <>The bar is connected to Home Assistant and sees {devices} {devices === 1 ? "device" : "devices"}. Add them from <b>Devices</b> in the card library.</>
                  : loggedIn === false
                    ? deployedHash ? "The bar's Home Assistant app isn't logged in. Check the address and token, then deploy." : "Not connected yet. Deploy to send these settings to the bar."
                    : "Couldn't check the connection."}
              </StatusLine>
              <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={checking}>
                {checking ? <Spinner /> : <RefreshCw size={12} />} Check
              </Button>
            </div>
          </div>
        )}
      </div></div>
    </section>
  );
}

function DiscordSection() {
  const status = useApp((s) => s.discord);
  const s = useApp.getState();
  const [clientId, setClientId] = useState(status?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<null | "save" | "signin" | "check">(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void s.refreshDiscord(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (status && !clientId) setClientId(status.clientId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.clientId]);

  const run = async (kind: "save" | "signin" | "check", f: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const save = () => run("save", async () => {
    const st = await api.discordSetApp(clientId, secret);
    setSecret("");
    useApp.setState({ discord: st });
  });
  const signIn = () => run("signin", async () => {
    if (clientId.trim() !== (status?.clientId ?? "") || secret) await api.discordSetApp(clientId, secret);
    setSecret("");
    useApp.setState({ discord: await api.discordSignIn() });
  });
  const signOut = () => run("save", async () => useApp.setState({ discord: await api.discordSignOut() }));

  const changed = clientId.trim() !== (status?.clientId ?? "") || !!secret;
  const name = status?.user?.globalName || status?.user?.username;

  return (
    <section>
      <h3 className="section-title"><MessageCircle size={14} /> Discord</h3>
      <div className="group"><div className="group-pad">
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Join voice channels, mute, deafen, play soundboard sounds and toggle your camera or screen share from the bar. This computer does it through the Discord app, so Discord has to be running here.
        </p>

        {status?.signedIn ? (
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
              <StatusLine ok={status.connected ? true : status.error ? false : null}>
                {status.connected
                  ? <>Connected to Discord{name ? <> as <b>{name}</b></> : null}.</>
                  : status.error ?? <>Signed in{name ? <> as <b>{name}</b></> : null}. Connects when a Discord action runs.</>}
              </StatusLine>
              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run("check", () => s.refreshDiscord(true))}>
                  {busy === "check" ? <Spinner /> : <RefreshCw size={12} />} Check
                </Button>
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void signOut()}><LogOut size={12} /> Sign out</Button>
              </div>
            </div>
            <p className="faint" style={{ margin: 0, fontSize: 12 }}>Add Discord actions from the card library, or use them in multi-actions, automations and module buttons.</p>
          </div>
        ) : (
          <>
            <details className="steps" open={!status?.configured}>
              <summary className="link" style={{ fontSize: 12.5 }}>How to set this up (once, about 2 minutes)</summary>
              <ol style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }} className="muted">
                <li>Open the <button className="link" onClick={() => open("https://discord.com/developers/applications")}>Discord Developer Portal</button> and create a new application (any name, e.g. “UltraBar”).</li>
                <li>Under <b>OAuth2</b>, copy the <b>Client ID</b>, reset and copy the <b>Client Secret</b>, and add <span className="mono">{status?.redirectUri ?? "http://localhost"}</span> under <b>Redirects</b>.</li>
                <li>Paste both below and click <b>Sign in</b>. Discord asks you to authorize the app.</li>
              </ol>
              <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>
                Discord only lets its approved partners (like Elgato) use this for everyone, so each person uses their own application. Your secret and sign-in stay on this computer.
              </p>
            </details>
            <Field label="Client ID">
              <input className="input mono" value={clientId} placeholder="123456789012345678" spellCheck={false} onChange={(e) => setClientId(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <Field label="Client secret" hint={status?.configured && !secret ? "Saved. Paste a new one to replace it." : undefined}>
              <Secret value={secret} placeholder={status?.configured ? "••••••••" : "Paste the client secret"} onChange={setSecret} />
            </Field>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="primary" disabled={!!busy || !clientId || (!secret && !status?.configured)} onClick={() => void signIn()}>
                {busy === "signin" ? <><Spinner /> Waiting for Discord…</> : "Sign in"}
              </Button>
              {changed && <Button disabled={!!busy || !clientId} onClick={() => void save()}>Save</Button>}
            </div>
            {busy === "signin" && <p className="faint" style={{ margin: 0, fontSize: 12 }}>Switch to Discord and click <b>Authorize</b>.</p>}
          </>
        )}
        {error && <div className="callout warn"><Info size={14} /><div style={{ whiteSpace: "pre-wrap" }}>{error}</div></div>}
      </div></div>
    </section>
  );
}
