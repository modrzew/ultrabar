// One gesture of a module key (Dot Key keys, the Knob's press; later Sense
// Cube taps and VivoCube buttons): an on/off switch, the prompt the bar shows
// when it runs, and the actions.
import { useRef, useState, type CSSProperties } from "react";
import { ImagePlus, Library, X } from "lucide-react";
import type { Action, Gesture, GesturePrompt } from "../lib/model";
import { PROMPT_MAX, gestureName } from "../lib/deploy";
import { PROMPT_IMAGE, promptImageFile, promptImageIcon } from "../lib/icons";
import { useApp } from "../lib/store";
import { ActionList } from "./Actions";
import { IconLibraryPicker } from "./IconLibrary";
import { Button, Field, ToggleRow } from "./ui";

/** A gesture with nothing set up yet. */
const EMPTY: Gesture = { actions: [] };

export function GestureEditor({ gesture, onChange, when }: {
  gesture?: Gesture;
  onChange: (g: Gesture) => void;
  /** Finishes "Runs top to bottom when you …", e.g. "click the top key". */
  when: string;
}) {
  const g = gesture ?? EMPTY;
  const on = g.enabled !== false;
  const prompt: GesturePrompt = g.prompt ?? { show: true };
  const setPrompt = (p: Partial<GesturePrompt>) => onChange({ ...g, prompt: { ...prompt, ...p } });

  return (
    <div className="stack" style={{ gap: 14 }}>
      <ToggleRow
        title="On" sub={on ? undefined : `Does nothing when you ${when}. The actions are kept.`}
        checked={on}
        // Stored only when off, so gestures that were never switched off
        // stay as earlier versions saved them.
        onChange={(v) => {
          const next = { ...g };
          if (v) delete next.enabled;
          else next.enabled = false;
          onChange(next);
        }}
      />
      <div className={`stack gesture-body${on ? "" : " off"}`} style={{ gap: 14 }}>
        <div className="stack" style={{ gap: 10 }}>
          <ToggleRow title="Show a prompt on the bar" sub="Its text and picture appear briefly when the gesture runs."
            checked={prompt.show} onChange={(show) => setPrompt({ show })} />
          {prompt.show && <PromptFields g={g} prompt={prompt} setPrompt={setPrompt} />}
        </div>
        <Field label="Actions" hint={`Run top to bottom when you ${when}.`}>
          <ActionList actions={g.actions} onChange={(actions: Action[]) => onChange({ ...g, actions })} />
        </Field>
      </div>
    </div>
  );
}

function PromptFields({ g, prompt, setPrompt }: { g: Gesture; prompt: GesturePrompt; setPrompt: (p: Partial<GesturePrompt>) => void }) {
  const [browsing, setBrowsing] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const toast = useApp((s) => s.toast);
  const fallback = gestureName({ ...g, prompt: undefined });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPrompt({ image: await promptImageFile(f) });
    } catch {
      toast({ kind: "error", title: "Couldn't read that image" });
    }
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <Field label="Text" hint={prompt.text?.trim() ? undefined : fallback ? "Empty: the first action's name." : "Empty: no text."}>
        <input className="input" value={prompt.text ?? ""} maxLength={PROMPT_MAX} placeholder={fallback || "Prompt text"} spellCheck={false}
          onChange={(e) => setPrompt({ text: e.target.value || undefined })} />
      </Field>
      <Field label="Picture">
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="prompt-preview" style={{ "--ratio": `${PROMPT_IMAGE.w} / ${PROMPT_IMAGE.h}` } as CSSProperties}>
            {prompt.image ? <img src={prompt.image} alt="" /> : <span className="faint">None</span>}
          </div>
          <div className="stack grow" style={{ gap: 6 }}>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
            <Button size="sm" onClick={() => file.current?.click()}><ImagePlus size={12} /> Choose an image…</Button>
            <Button size="sm" onClick={() => setBrowsing(true)}><Library size={12} /> Icon library…</Button>
            {prompt.image && <Button size="sm" variant="ghost" onClick={() => setPrompt({ image: undefined })}><X size={12} /> Remove</Button>}
          </div>
        </div>
      </Field>
      {browsing && (
        <IconLibraryPicker
          title="Prompt picture"
          onClose={() => setBrowsing(false)}
          onPick={({ png }) => void promptImageIcon(png).then((image) => setPrompt({ image }))}
        />
      )}
    </div>
  );
}
