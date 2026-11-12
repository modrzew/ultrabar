import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragMoveEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowUpFromLine, Star } from "lucide-react";
import { useApp } from "../lib/store";
import type { Profile, Widget } from "../lib/model";
import { CardFace, cardIssue, cardStyle } from "../components/WidgetCard";
import { Library, type LibItem } from "../components/Library";
import { Inspector } from "../components/Inspector";
import { Button, InlineInput, Switch } from "../components/ui";

const SCREEN_W = 1424;

export function ProfileEditor({ profileId }: { profileId: string }) {
  const profile = useApp((s) => s.doc.profiles.find((p) => p.id === profileId));
  const selected = useApp((s) => s.selected);
  const online = useApp((s) => s.status.state === "online");
  const deployedHere = useApp((s) => !!s.doc.deployedAt);
  const s = useApp.getState();

  const [dragItem, setDragItem] = useState<{ kind: "card"; widget: Widget } | { kind: "lib"; item: LibItem } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const scale = useScreenScale(stripRef);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const insertionIndex = useCallback((x: number, y: number): number | null => {
    const strip = stripRef.current;
    if (!strip) return null;
    const box = strip.getBoundingClientRect();
    if (x < box.left - 40 || x > box.right + 40 || y < box.top - 60 || y > box.bottom + 60) return null;
    const cards = [...strip.querySelectorAll<HTMLElement>("[data-card]")];
    let i = 0;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (x > r.left + r.width / 2) i++;
    }
    return i;
  }, []);

  if (!profile) return null;

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as { kind: "card" | "lib"; widget?: Widget; item?: LibItem } | undefined;
    if (data?.kind === "lib" && data.item) setDragItem({ kind: "lib", item: data.item });
    else if (data?.kind === "card" && data.widget) setDragItem({ kind: "card", widget: data.widget });
  };

  const pointer = (e: DragMoveEvent | DragEndEvent) => {
    const start = e.activatorEvent as PointerEvent;
    return { x: (start.clientX ?? 0) + e.delta.x, y: (start.clientY ?? 0) + e.delta.y };
  };

  const onDragMove = (e: DragMoveEvent) => {
    if (dragItem?.kind !== "lib") return;
    const p = pointer(e);
    setDropIndex(insertionIndex(p.x, p.y));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const item = dragItem;
    setDragItem(null);
    setDropIndex(null);
    if (!item) return;
    if (item.kind === "lib") {
      const p = pointer(e);
      const idx = insertionIndex(p.x, p.y);
      if (idx !== null) item.item.add(profile.id, idx);
      return;
    }
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = profile.widgets.findIndex((w) => w.uid === active.id);
    const to = profile.widgets.findIndex((w) => w.uid === over.id);
    if (from >= 0 && to >= 0) s.moveWidget(profile.id, from, to);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={() => { setDragItem(null); setDropIndex(null); }}>
      <div className="editor" onMouseDown={(e) => { if (e.target === e.currentTarget) s.select(null); }}>
        <div className="editor-head">
          <InlineInput className="name-input" value={profile.name} onCommit={(v) => s.update((d) => { d.profiles.find((p) => p.id === profile.id)!.name = v; })} />
        </div>
        <div className="editor-sub">
          <span>{profile.widgets.length} {profile.widgets.length === 1 ? "card" : "cards"}</span>
          {profile.isDefault ? (
            <span className="chip accent"><Star size={10} fill="currentColor" /> Default profile</span>
          ) : (
            <button className="link" style={{ fontSize: 12 }} onClick={() => s.update((d) => d.profiles.forEach((p) => (p.isDefault = p.id === profile.id)))}>
              Make default
            </button>
          )}
          <span className="row" style={{ gap: 6 }}>
            <Switch checked={profile.showName} onChange={(v) => s.update((d) => { d.profiles.find((p) => p.id === profile.id)!.showName = v; })} label="Show name on bar" />
            Show name on bar
          </span>
          <div className="grow" />
          <Button size="sm" variant="ghost" disabled={!online || !deployedHere} onClick={() => void s.showProfileOnBar(profile.id)}
            title={!online ? "Connect to your bar first" : !deployedHere ? "Deploy first so the bar has this profile" : "Switch the bar to this profile"}>
            <ArrowUpFromLine size={13} /> Show on bar
          </Button>
        </div>
        <div className="stage" onMouseDown={(e) => { if (e.target === e.currentTarget) s.select(null); }}>
          <BarPreview profile={profile} stripRef={stripRef} scale={scale} selected={selected} dropIndex={dragItem?.kind === "lib" ? dropIndex : null} libDragging={dragItem?.kind === "lib"} />
          <Hint profile={profile} />
        </div>
      </div>
      <aside className="panel">
        {selected && profile.widgets.some((w) => w.uid === selected) ? <Inspector uid={selected} /> : <Library profileId={profile.id} />}
      </aside>
      <DragOverlay dropAnimation={null}>
        {dragItem?.kind === "card" && (
          <div style={{ "--s": scale } as CSSProperties}>
            <div className="card overlay" style={cardStyle(dragItem.widget)}><CardFace w={dragItem.widget} /></div>
          </div>
        )}
        {dragItem?.kind === "lib" && (
          <div className="lib-drag"><span className="glyph">{dragItem.item.icon}</span>{dragItem.item.label}</div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function useScreenScale(stripRef: React.RefObject<HTMLDivElement | null>) {
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = stripRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / SCREEN_W));
    ro.observe(el);
    setScale(el.clientWidth / SCREEN_W);
    return () => ro.disconnect();
  }, [stripRef]);
  return scale;
}

function BarPreview({ profile, stripRef, scale, selected, dropIndex, libDragging }: {
  profile: Profile;
  stripRef: React.RefObject<HTMLDivElement | null>;
  scale: number;
  selected: string | null;
  dropIndex: number | null;
  libDragging: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: "strip" });
  const ids = useMemo(() => profile.widgets.map((w) => w.uid), [profile.widgets]);

  // Keep the selected card in view.
  useEffect(() => {
    if (!selected) return;
    stripRef.current?.querySelector(`[data-card="${selected}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected, stripRef]);

  return (
    <div className="device" style={{ "--s": scale, maxWidth: 1180 } as CSSProperties}>
      <div className="screen" ref={setNodeRef}>
        {profile.widgets.length === 0 ? (
          <div ref={stripRef} className={`strip-empty${libDragging && dropIndex !== null ? " over" : ""}`}>
            <div>Drag cards here from the library,<br />or click one to add it.</div>
          </div>
        ) : (
          <div className="strip" ref={stripRef}>
            <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
              {profile.widgets.map((w, i) => (
                <FragmentWithCaret key={w.uid} caret={dropIndex === i}>
                  <SortableCard w={w} selected={selected === w.uid} />
                </FragmentWithCaret>
              ))}
              {dropIndex === profile.widgets.length && <div className="drop-caret" />}
            </SortableContext>
          </div>
        )}
        <div className="screen-glare" />
      </div>
    </div>
  );
}

function FragmentWithCaret({ caret, children }: { caret: boolean; children: React.ReactNode }) {
  return (
    <>
      {caret && <div className="drop-caret" />}
      {children}
    </>
  );
}

function SortableCard({ w, selected }: { w: Widget; selected: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.uid, data: { kind: "card", widget: w } });
  const issue = cardIssue(w);
  const style: CSSProperties = { ...cardStyle(w), transform: CSS.Translate.toString(transform), transition };
  return (
    <div
      ref={setNodeRef} data-card={w.uid} style={style}
      className={`card${selected ? " selected" : ""}${isDragging ? " dragging" : ""}`}
      title={w.name}
      {...attributes} {...listeners}
      onClick={(e) => { e.stopPropagation(); useApp.getState().select(w.uid); }}
    >
      <CardFace w={w} />
      {issue && <span className="warn-badge" title={issue}>!</span>}
    </div>
  );
}

function Hint({ profile }: { profile: Profile }) {
  const selected = useApp((s) => s.selected);
  const units = profile.widgets.reduce((n, w) => n + (w.type === "TIME" ? 2 : 1), 0);
  return (
    <div className="row faint" style={{ fontSize: 12, justifyContent: "space-between", maxWidth: 1180, gap: 16 }}>
      <span className="truncate">{selected ? "Drag to reorder · ⌫ to remove" : "Click a card to edit · drag to reorder"}</span>
      {units > 5 && <span className="truncate" title="The bar's screen fits about five cards; swipe on the bar to scroll.">Scrolls on the bar</span>}
    </div>
  );
}
