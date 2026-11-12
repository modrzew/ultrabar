// World clock: the bar stores a fixed offset string like "GMT+5:30" (it
// doesn't know about daylight saving), so we compute it from the zone now.

export function zoneCity(zone: string): string {
  const last = zone.split("/").pop() ?? zone;
  return last.replace(/_/g, " ");
}

export function zoneRegion(zone: string): string {
  const parts = zone.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join(" / ").replace(/_/g, " ") : "";
}

/** "GMT+5:30", "GMT-3:00", "GMT+0:00": the exact format the bar parses. */
export function zoneOffset(zone: string, at = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return "GMT+0:00";
    return `GMT${m[1]}${Number(m[2])}:${m[3] ?? "00"}`;
  } catch {
    return "GMT+0:00";
  }
}

export function timeIn(zone: string, at = new Date()): { h: number; m: number; s: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return { h: get("hour"), m: get("minute"), s: get("second") };
  } catch {
    return { h: at.getHours(), m: at.getMinutes(), s: at.getSeconds() };
  }
}

const FALLBACK = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver", "America/Chicago",
  "America/New_York", "America/Toronto", "America/Mexico_City", "America/Sao_Paulo", "America/Buenos_Aires",
  "Atlantic/Reykjavik", "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin",
  "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Stockholm", "Europe/Warsaw", "Europe/Athens",
  "Europe/Helsinki", "Europe/Istanbul", "Europe/Moscow", "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos",
  "Africa/Nairobi", "Asia/Dubai", "Asia/Tehran", "Asia/Karachi", "Asia/Kolkata", "Asia/Kathmandu", "Asia/Dhaka",
  "Asia/Bangkok", "Asia/Jakarta", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Shenzhen",
  "Asia/Taipei", "Asia/Seoul", "Asia/Tokyo", "Australia/Perth", "Australia/Adelaide", "Australia/Sydney",
  "Pacific/Auckland",
];

let cached: string[] | null = null;
export function allZones(): string[] {
  if (cached) return cached;
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    cached = list && list.length ? list.filter((z) => z.includes("/") && !z.startsWith("Etc/")) : FALLBACK;
  } catch {
    cached = FALLBACK;
  }
  return cached;
}
