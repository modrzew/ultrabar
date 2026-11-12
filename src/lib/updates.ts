// Self-updates from the GitHub releases (see .github/workflows/apps.yml). The updater
// downloads the new build itself, so it isn't marked as coming from the internet:
// macOS opens it without another trip to System Settings and Windows without SmartScreen.
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { isTauri } from "./api";

/** Where the app downloads new versions from. */
const UPDATE_REPO = "modrzew/ultrabar";

/** The app keeps running in the background for the bar, so it keeps looking for releases. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** The version of the latest release when it's newer than this app, else null. */
export function useUpdateCheck(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const run = async () => {
      try {
        const update = await check();
        // Only the version is needed here; the install checks again.
        await update?.close();
        if (!cancelled) setVersion(update?.version ?? null);
      } catch (err) {
        // GitHub may be unreachable, or the latest release lacks the update manifest yet;
        // the button stays as it was.
        console.warn("Update check failed", err);
      }
    };
    void run();
    const timer = setInterval(() => void run(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return version;
}

export function currentVersion(): Promise<string> {
  return getVersion();
}

export interface ReleaseInfo {
  version: string;
  publishedAt: number;
  notes: string;
}

interface GitHubRelease {
  tag_name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
}

/** The releases newer than `current`, newest first. */
export async function fetchReleaseLog(current: string): Promise<ReleaseInfo[]> {
  const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=100`);
  if (!response.ok) throw new Error(`Couldn't load the release notes (${response.status})`);
  const releases = (await response.json()) as GitHubRelease[];
  return releases
    .filter((r) => !r.draft && !r.prerelease && compareVersions(r.tag_name, current) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
    .map((r) => ({ version: r.tag_name.replace(/^v/, ""), publishedAt: Date.parse(r.published_at), notes: r.body ?? "" }));
}

/** -1, 0 or 1 for a and b, `v`-prefixed or not. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/**
 * Downloads the latest release, installs it over the running app (same path, and on
 * macOS the same signing identity, so the system keeps its permissions) and relaunches
 * into it. On Windows `install` runs the installer and exits; the installer starts the
 * new version. On macOS the updater swaps the app bundle, hence the final `relaunch`.
 */
export async function startUpdate(
  onProgress: (receivedBytes: number, totalBytes: number | null) => void,
  onInstallStarted: () => void,
  beforeInstall: () => Promise<void>,
): Promise<void> {
  const update = await check();
  if (!update) throw new Error("There's no newer version anymore.");
  let receivedBytes = 0;
  let totalBytes: number | null = null;
  try {
    await update.download((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        receivedBytes += event.data.chunkLength;
        onProgress(receivedBytes, totalBytes);
      } else {
        onInstallStarted();
      }
    });
    // Windows quits the app as soon as the installer starts.
    await beforeInstall().catch(() => {});
    await update.install();
  } catch (err) {
    await update.close().catch(() => {});
    throw err;
  }
  await relaunch();
}
