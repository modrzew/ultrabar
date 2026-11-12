import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import type { GroupButton } from "../lib/model";
import { PC_ACTIONS, pcSummary } from "../lib/widgets";
import { Button } from "./ui";

/** Buttons of a shortcut group, in the order the bar lays them out. */
export function GroupButtons({ buttons, onChange }: { buttons: GroupButton[]; onChange: (b: GroupButton[]) => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = buttons.findIndex((b) => b.uid === e.active.id);
    const to = buttons.findIndex((b) => b.uid === e.over!.id);
    onChange(arrayMove(buttons, from, to));
  };
  if (!buttons.length) return <div className="lib-note">No buttons left. Add the pack again to get them back.</div>;
  return (
    <div className="action-list">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext items={buttons.map((b) => b.uid)} strategy={verticalListSortingStrategy}>
          {buttons.map((b) => (
            <Row key={b.uid} b={b} onRemove={() => onChange(buttons.filter((x) => x.uid !== b.uid))} />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

function Row({ b, onRemove }: { b: GroupButton; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: b.uid });
  const Icon = PC_ACTIONS[b.pc.action].icon;
  return (
    <div
      ref={setNodeRef} className="action-row"
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 2 : undefined, position: "relative" }}
    >
      <span className="handle" {...attributes} {...listeners}><GripVertical size={14} /></span>
      <span className="ico btn-ico">{b.icon ? <img src={b.icon} alt="" draggable={false} /> : <Icon size={14} />}</span>
      <span className="txt">
        <b className="truncate">{b.name}{b.span === 2 ? <span className="faint"> · tall</span> : null}</b>
        <span>{PC_ACTIONS[b.pc.action].verb} {pcSummary(b.pc)}</span>
      </span>
      <Button variant="ghost" icon size="sm" aria-label={`Remove ${b.name}`} onClick={onRemove}><X size={13} /></Button>
    </div>
  );
}
