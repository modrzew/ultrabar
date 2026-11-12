// Icons for icon-only cards (computer actions, multi-actions). The bar trims
// transparent edges and scales the image to `iconScale`% of the card, so we
// render glyphs tightly on a transparent 192 px canvas.
import { renderToStaticMarkup } from "react-dom/server";
import * as L from "lucide-react";

export const GLYPHS: Record<string, L.LucideIcon> = {
  keyboard: L.Keyboard, "app-window": L.AppWindow, globe: L.Globe, folder: L.Folder, terminal: L.TerminalSquare,
  type: L.Type, layers: L.Layers, zap: L.Zap, play: L.Play, pause: L.Pause, music: L.Music, headphones: L.Headphones,
  mic: L.Mic, "mic-off": L.MicOff, video: L.Video, camera: L.Camera, monitor: L.Monitor, laptop: L.Laptop,
  "gamepad-2": L.Gamepad2, code: L.Code, "git-branch": L.GitBranch, rocket: L.Rocket, mail: L.Mail,
  "message-square": L.MessageSquare, calendar: L.Calendar, clock: L.Clock, coffee: L.Coffee, moon: L.Moon,
  sun: L.Sun, lock: L.Lock, power: L.Power, home: L.Home, lightbulb: L.Lightbulb, fan: L.Fan,
  "volume-2": L.Volume2, "volume-x": L.VolumeX, bell: L.Bell, star: L.Star, heart: L.Heart, bookmark: L.Bookmark,
  search: L.Search, download: L.Download, "refresh-cw": L.RefreshCw, scissors: L.Scissors, clipboard: L.Clipboard,
  "wand-2": L.Wand2, sparkles: L.Sparkles, "pen-tool": L.PenTool, "file-text": L.FileText, image: L.Image,
  "shopping-cart": L.ShoppingCart, wifi: L.Wifi, "skip-forward": L.SkipForward, "skip-back": L.SkipBack,
  "screen-share": L.ScreenShare, "eye-off": L.EyeOff, target: L.Target, flame: L.Flame, "book-open": L.BookOpen,
  "layout-grid": L.LayoutGrid,
};

export const GLYPH_COLORS = ["#ffffff", "#c7cbff", "#7c86ff", "#5ad1a0", "#ffcc66", "#ff8a7a", "#f5a3d8", "#8fd3ff"];
export const CARD_COLORS = ["#24252b", "#0f1013", "#2d3170", "#1f4d3a", "#5a3a12", "#5c1f2a", "#3b2463", "#164e63"];

const SIZE = 192;

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

export async function glyphPng(glyph: string, color: string): Promise<string> {
  const Icon = GLYPHS[glyph] ?? L.Square;
  const svg = renderToStaticMarkup(<Icon size={SIZE} color={color} strokeWidth={1.75} absoluteStrokeWidth={false} />);
  const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  c.getContext("2d")!.drawImage(img, 0, 0, SIZE, SIZE);
  return c.toDataURL("image/png");
}

/** Read an image file and fit it into a 256 px square PNG. */
export async function imageFilePng(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const max = 256;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Any image URL (e.g. a data URL from a shortcut pack) as a PNG that fits
 * in `max` px; the bar's icon server only takes PNGs. */
export async function imageUrlPng(src: string, max = 160): Promise<string> {
  const img = await loadImage(src);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

/** Full card face for computer-action and multi-action cards (520×480, the
 * card's proportions): the card color with the symbol trimmed and centered at
 * `scalePct` of the height. Firmware 1.0.9 ignores card colors, so the color
 * has to be part of the image; the bar scales it to fill the card. */
export async function cardArtPng(bg: string, iconPng: string | null, scalePct: number): Promise<string> {
  const W = 520, H = 480;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  if (iconPng) {
    const img = await loadImage(iconPng);
    const box = opaqueBounds(img);
    const target = (Math.max(10, Math.min(100, scalePct)) / 100) * H;
    const k = target / Math.max(box.w, box.h);
    const dw = box.w * k, dh = box.h * k;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, box.x, box.y, box.w, box.h, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  return c.toDataURL("image/png");
}

function opaqueBounds(img: HTMLImageElement) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w, h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
