import { useEffect, useState } from "react";
import { CircleArrowDown } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../lib/store";
import { currentVersion, fetchReleaseLog, startUpdate, type ReleaseInfo } from "../lib/updates";
import { Button, Modal, Spinner } from "./ui";

type Phase =
  | { name: "ready" }
  | { name: "downloading"; receivedBytes: number; totalBytes: number | null }
  | { name: "installing" };

/** What's new since the running version, and the download → install → relaunch flow. */
export function UpdateDialog({ version, onClose }: { version: string; onClose: () => void }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [releases, setReleases] = useState<ReleaseInfo[] | null>(null);
  const [notesError, setNotesError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "ready" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const running = await currentVersion();
        if (cancelled) return;
        setCurrent(running);
        const log = await fetchReleaseLog(running);
        if (!cancelled) setReleases(log);
      } catch {
        // The notes are a nicety; the update itself doesn't need them.
        if (!cancelled) setNotesError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const busy = phase.name !== "ready";

  const install = async () => {
    if (busy) return;
    setError(null);
    setPhase({ name: "downloading", receivedBytes: 0, totalBytes: null });
    try {
      // The app is closing when this resolves.
      await startUpdate(
        (receivedBytes, totalBytes) => setPhase({ name: "downloading", receivedBytes, totalBytes }),
        () => setPhase({ name: "installing" }),
        // Edits are saved shortly after they're made; make sure the last one is on disk.
        () => api.saveDoc(useApp.getState().doc),
      );
    } catch (e) {
      setError(errorMessage(e));
      setPhase({ name: "ready" });
    }
  };

  const progress =
    phase.name === "downloading" && phase.totalBytes ? Math.min(100, Math.round((phase.receivedBytes / phase.totalBytes) * 100)) : null;
  const label =
    phase.name === "downloading" ? (progress !== null ? `Downloading… ${progress}%` : "Downloading…")
    : phase.name === "installing" ? "Installing…"
    : "Update and restart";

  return (
    <Modal
      title={`Update to ${version}`}
      icon={<CircleArrowDown size={17} style={{ color: "var(--accent-text)" }} />}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <span className="faint grow" style={{ fontSize: 12 }}>ultrabar restarts into the new version.</span>
          <Button onClick={onClose} disabled={busy}>Later</Button>
          <Button variant="primary" onClick={() => void install()} disabled={busy}>
            {busy && <Spinner />}
            {label}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Version {version} is available.{current && <> You have {current}.</>}
        </p>
        {releases && releases.length > 0 && (
          <div className="release-log">
            {releases.map((r) => (
              <section key={r.version}>
                <h4>
                  {r.version}
                  <span className="faint">{new Date(r.publishedAt).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}</span>
                </h4>
                <ReleaseNotes text={r.notes} />
              </section>
            ))}
          </div>
        )}
        {!releases && !notesError && <p className="faint" style={{ margin: 0 }}>Loading what's new…</p>}
        {notesError && <p className="faint" style={{ margin: 0 }}>Couldn't load the release notes.</p>}
        {phase.name === "downloading" && (
          <div className="progress" role="progressbar" aria-valuenow={progress ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <div className={progress === null ? "indeterminate" : undefined} style={progress === null ? undefined : { width: `${progress}%` }} />
          </div>
        )}
        {error && <p className="update-error">{error}</p>}
      </div>
    </Modal>
  );
}

/** Release notes are a bullet per commit; anything else shows as plain lines. */
function ReleaseNotes({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return <p className="faint">No release notes.</p>;
  return (
    <ul>
      {lines.map((l, i) => (
        <li key={i}>{l.replace(/^[-*]\s+/, "")}</li>
      ))}
    </ul>
  );
}
