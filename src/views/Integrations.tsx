import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CloudSun, Eye, EyeOff, Home } from "lucide-react";
import { useApp } from "../lib/store";
import { isTauri } from "../lib/api";
import { Field, Segmented } from "../components/ui";

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

export function IntegrationsView() {
  const integ = useApp((s) => s.doc.integrations);
  const s = useApp.getState();
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1>Integrations</h1>
            <p>Services the bar talks to directly. Settings here are sent to the bar with Deploy.</p>
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

        <section>
          <h3 className="section-title"><Home size={14} /> Home Assistant</h3>
          <div className="group"><div className="group-pad">
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
              Connect the bar to Home Assistant to put lights, switches and scenes on it. The bar checks these details when you deploy.
            </p>
            <Field label="Server address">
              <input className="input mono" placeholder="http://homeassistant.local:8123" value={integ.homeAssistant.url} spellCheck={false}
                onChange={(e) => s.update((d) => { d.integrations.homeAssistant.url = e.target.value; }, "ha-url")} />
            </Field>
            <Field label="Long-lived access token" hint="Create one in Home Assistant under your profile › Security.">
              <Secret value={integ.homeAssistant.token} placeholder="eyJhbGciOi…"
                onChange={(v) => s.update((d) => { d.integrations.homeAssistant.token = v; }, "ha-token")} />
            </Field>
          </div></div>
        </section>
      </div>
    </div>
  );
}
