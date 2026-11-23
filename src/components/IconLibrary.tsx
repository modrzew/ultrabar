// The vendor's cloud icon library (about 39,800 icons, no login). A dialog
// that hands back the picked icon as a PNG data URL, so it can be drawn into
// card art. Not tied to cards: gesture prompts and VivoCube buttons use it too.
import { useEffect, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Library, Search } from "lucide-react";
import { api, errorMessage, type IconTag, type IconTags, type LibraryIcon } from "../lib/api";
import { imageUrlPng } from "../lib/icons";
import { Button, Empty, Modal, Spinner } from "./ui";

export interface PickedIcon {
  id: number;
  name: string;
  /** PNG data URL, at most 256 px. */
  png: string;
}

const PAGE_SIZE = 50;

let tagsCache: Promise<IconTags> | null = null;
function loadTags() {
  tagsCache ??= api.iconLibraryTags().catch((e) => {
    tagsCache = null;
    throw e;
  });
  return tagsCache;
}

/** One row of filter pills; "All" clears it. Rows combine. */
function Pills({ label, tags, value, onChange }: { label: string; tags: IconTag[]; value: number | null; onChange: (v: number | null) => void }) {
  if (!tags.length) return null;
  return (
    <div className="pill-row">
      <span>{label}</span>
      <div className="pills" role="group" aria-label={label}>
        <button type="button" aria-pressed={value === null} onClick={() => onChange(null)}>All</button>
        {tags.map((t) => (
          <button key={t.id} type="button" aria-pressed={value === t.id} onClick={() => onChange(t.id)}>{t.tag}</button>
        ))}
      </div>
    </div>
  );
}

export function IconLibraryPicker({ onPick, onClose, title = "Icon library" }: {
  onPick: (icon: PickedIcon) => void;
  onClose: () => void;
  title?: string;
}) {
  const [tags, setTags] = useState<IconTags | null>(null);
  const [text, setText] = useState("");
  const [keyword, setKeyword] = useState("");
  const [groupId, setGroupId] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [styleId, setStyleId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ total: number; icons: LibraryIcon[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    loadTags().then(setTags, () => setTags({ group: [], category: [], iconStyle: [] }));
  }, []);

  // Search once typing pauses; a new search or filter starts at page 1.
  useEffect(() => {
    const t = setTimeout(() => {
      setKeyword(text.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.iconLibraryPage({ page, keyword, groupId, categoryId, iconStyleId: styleId }).then(
      (r) => {
        if (cancelled) return;
        setResult(r);
        setLoading(false);
      },
      (e) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [page, keyword, groupId, categoryId, styleId, attempt]);

  const filter = (setter: (v: number | null) => void) => (v: number | null) => {
    setter(v);
    setPage(1);
  };

  const pick = async (icon: LibraryIcon) => {
    setPicking(icon.id);
    try {
      const png = await imageUrlPng(await api.iconLibraryImage(icon.path), 256);
      onPick({ id: icon.id, name: icon.name, png });
      onClose();
    } catch (e) {
      setError(`Couldn't load “${icon.name}”: ${errorMessage(e)}`);
    } finally {
      setPicking(null);
    }
  };

  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;

  return (
    <Modal
      title={title}
      icon={<Library size={16} className="faint" />}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="faint grow" style={{ fontSize: 12 }}>
            {result ? `${result.total.toLocaleString()} icon${result.total === 1 ? "" : "s"}` : ""}
          </span>
          <Button size="sm" variant="ghost" icon disabled={page <= 1 || loading} onClick={() => setPage(page - 1)} aria-label="Previous page"><ChevronLeft size={14} /></Button>
          <span className="faint mono" style={{ fontSize: 12 }}>{page} / {pages}</span>
          <Button size="sm" variant="ghost" icon disabled={page >= pages || loading} onClick={() => setPage(page + 1)} aria-label="Next page"><ChevronRight size={14} /></Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <div className="input-affix">
          <Search size={13} style={{ position: "absolute", left: 9, color: "var(--text-3)" }} />
          <input className="input" style={{ paddingLeft: 28 }} placeholder="Search icons" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoFocus aria-label="Search icons" />
          {loading && <span className="suffix"><Spinner /></span>}
        </div>
        {tags && (
          <>
            <Pills label="Group" tags={tags.group} value={groupId} onChange={filter(setGroupId)} />
            <Pills label="Category" tags={tags.category} value={categoryId} onChange={filter(setCategoryId)} />
            <Pills label="Style" tags={tags.iconStyle} value={styleId} onChange={filter(setStyleId)} />
          </>
        )}
        {error ? (
          <Empty icon={<AlertTriangle size={22} />} title="Couldn't load icons" action={<Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>{error}</Empty>
        ) : result && !result.icons.length && !loading ? (
          <Empty icon={<Search size={22} />} title="No icons found">Try another word or fewer filters.</Empty>
        ) : (
          <div className="icon-lib-grid" aria-busy={loading}>
            {result?.icons.map((icon) => (
              <button key={icon.id} type="button" title={icon.name} disabled={picking !== null} onClick={() => void pick(icon)}>
                {picking === icon.id ? <Spinner /> : <img src={icon.path} alt="" loading="lazy" draggable={false} />}
                <span className="truncate">{icon.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
