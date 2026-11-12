import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "default";
  size?: "sm" | "md" | "lg";
  icon?: boolean;
};

export function Button({ variant = "default", size = "md", icon, className = "", ...rest }: BtnProps) {
  const cls = ["btn", variant !== "default" && variant, size !== "md" && size, icon && "icon", className].filter(Boolean).join(" ");
  return <button type="button" className={cls} {...rest} />;
}

export function Field({ label, hint, error, aside, children }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <label className="field" onClick={(e) => e.target instanceof HTMLButtonElement && e.preventDefault()}>
      {label && (
        <span className="label">
          <span>{label}</span>
          {aside}
        </span>
      )}
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />
  );
}

export function ToggleRow({ title, sub, checked, onChange }: { title: ReactNode; sub?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toggle-row">
      <div className="text">
        <span>{title}</span>
        {sub && <span className="sub">{sub}</span>}
      </div>
      <Switch checked={checked} onChange={onChange} label={typeof title === "string" ? title : undefined} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, full }: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  full?: boolean;
}) {
  return (
    <div className={`segmented${full ? " full" : ""}`} role="group">
      {options.map((o) => (
        <button key={o.value} type="button" title={o.title} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range" className="slider" min={min} max={max} step={step} value={value}
      style={{ "--fill": `${fill}%` } as React.CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function Modal({ title, onClose, children, footer, wide, icon }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  icon?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          {icon}
          <h2>{title}</h2>
          <Button variant="ghost" icon size="sm" onClick={onClose} aria-label="Close">
            <X size={15} />
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

/** Small dropdown anchored to the element that opened it. */
export function Menu({ anchor, items, onClose, align = "start" }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void; align?: "start" | "end" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 180;
    const h = ref.current?.offsetHeight ?? 100;
    let left = align === "end" ? r.right - w : r.left;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = r.top - h - 4;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ top, left });
  }, [anchor, align]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="menu" role="menu" style={pos ? pos : { visibility: "hidden" }}>
      {items.map((it, i) =>
        it.separator ? (
          <hr key={i} />
        ) : (
          <button
            key={i} role="menuitem" type="button" className={it.danger ? "danger" : ""} disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            {it.icon}
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return {
    anchor,
    open: (el: HTMLElement) => setAnchor((a) => (a === el ? null : el)),
    close: () => setAnchor(null),
  };
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="art">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Text input that commits on blur/Enter and reverts on Escape. */
export function InlineInput({ value, onCommit, className, placeholder, autoFocus, onDone }: {
  value: string;
  onCommit: (v: string) => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
    else setDraft(value);
    onDone?.();
  };
  return (
    <input
      className={className} value={draft} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false}
      onFocus={(e) => autoFocus && e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          onDone?.();
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
        e.stopPropagation();
      }}
      style={className?.includes("name-input") ? { width: `${Math.max(draft.length, 4) + 1}ch` } : undefined}
    />
  );
}
