// USB HID keyboard usage IDs. The bar types hotkeys itself as a USB keyboard
// (it writes these codes to /dev/hidg0), so they must be HID codes, not OS
// key codes.

export const MODIFIERS: Record<number, { mac: string; other: string; order: number }> = {
  224: { mac: "⌃", other: "Ctrl", order: 1 },
  228: { mac: "⌃", other: "Ctrl", order: 1 },
  226: { mac: "⌥", other: "Alt", order: 2 },
  230: { mac: "⌥", other: "Alt", order: 2 },
  225: { mac: "⇧", other: "Shift", order: 3 },
  229: { mac: "⇧", other: "Shift", order: 3 },
  227: { mac: "⌘", other: "Win", order: 4 },
  231: { mac: "⌘", other: "Win", order: 4 },
};

const CODE_TO_HID: Record<string, number> = {
  Enter: 40, NumpadEnter: 88, Escape: 41, Backspace: 42, Tab: 43, Space: 44,
  Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48, Backslash: 49,
  Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56,
  CapsLock: 57, PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73,
  Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83,
  NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86, NumpadAdd: 87,
  NumpadDecimal: 99, ContextMenu: 101,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
  ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
};

for (let i = 0; i < 26; i++) CODE_TO_HID[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
for (let i = 1; i <= 9; i++) CODE_TO_HID[`Digit${i}`] = 29 + i;
CODE_TO_HID.Digit0 = 39;
for (let i = 1; i <= 12; i++) CODE_TO_HID[`F${i}`] = 57 + i;
for (let i = 13; i <= 24; i++) CODE_TO_HID[`F${i}`] = 91 + i;
for (let i = 1; i <= 9; i++) CODE_TO_HID[`Numpad${i}`] = 88 + i;
CODE_TO_HID.Numpad0 = 98;

const HID_LABEL: Record<number, string> = {
  40: "Return", 88: "Enter", 41: "Esc", 42: "⌫", 43: "Tab", 44: "Space", 45: "-", 46: "=",
  47: "[", 48: "]", 49: "\\", 51: ";", 52: "'", 53: "`", 54: ",", 55: ".", 56: "/",
  57: "Caps Lock", 70: "Print Screen", 71: "Scroll Lock", 72: "Pause", 73: "Insert",
  74: "Home", 75: "Page Up", 76: "⌦", 77: "End", 78: "Page Down",
  79: "→", 80: "←", 81: "↓", 82: "↑", 83: "Num Lock", 84: "÷", 85: "×", 86: "−", 87: "+", 99: ".",
  101: "Menu",
};
for (let i = 0; i < 26; i++) HID_LABEL[4 + i] = String.fromCharCode(65 + i);
for (let i = 1; i <= 9; i++) HID_LABEL[29 + i] = String(i);
HID_LABEL[39] = "0";
for (let i = 1; i <= 12; i++) HID_LABEL[57 + i] = `F${i}`;
for (let i = 13; i <= 24; i++) HID_LABEL[91 + i] = `F${i}`;
for (let i = 0; i <= 9; i++) HID_LABEL[i === 0 ? 98 : 88 + i] = `Num ${i}`;

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

export function hidFromCode(code: string): number | undefined {
  return CODE_TO_HID[code];
}

export function isModifier(hid: number) {
  return hid >= 224 && hid <= 231;
}

export function keyLabel(hid: number): string {
  const m = MODIFIERS[hid];
  if (m) return isMac ? m.mac : m.other;
  return HID_LABEL[hid] ?? `#${hid}`;
}

/** Modifiers first (in platform order), then other keys. */
export function sortKeys(keys: number[]): number[] {
  const mods = keys.filter(isModifier).sort((a, b) => MODIFIERS[a].order - MODIFIERS[b].order);
  return [...mods, ...keys.filter((k) => !isModifier(k))];
}

export function hotkeyLabel(keys: number[]): string {
  const parts = sortKeys(keys).map(keyLabel);
  return isMac ? parts.join("") : parts.join("+");
}
