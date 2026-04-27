// ─── Note card accent palette ─────────────────────────────────────────────────
export const NOTE_COLORS: Record<string, string> = {
  red      : '#FF524D',
  orange   : '#FF8637',
  yellow   : '#FFDE5A',
  green    : '#31B54C',
  blue     : '#43B4FB',
  lavender : '#DB95FD',
};

// ─── UI semantic colors ───────────────────────────────────────────────────────
export const UI_COLORS = {
  text       : '#1a1a2e',   // primary text rendered on colored card backgrounds
  white      : '#ffffff',   // text/elements on dark or colored backgrounds
  danger     : '#e05252',   // destructive actions and overflow danger items
  remindWarn : '#d4900a',   // upcoming reminder (within 24 h)
  remindOver : '#c0392b',   // overdue reminder
  activityBg : '#c15f3c',   // activity feed accent / avatar background
  muted      : '#94a3b8',   // neutral/inactive state (archived, gh-closed text)
  amber      : '#FFB400',   // warning highlights — conflict banner, diff rows
  shared     : '#7b61ff',   // shared note indicator
  star       : '#f59e0b',   // starred / star-filled indicator
  neutral    : '#808080',   // mid-grey for borders, dividers, and hover states
} as const;

// ─── GitHub status colors ─────────────────────────────────────────────────────
export const GH_COLORS = {
  open  : '#06d6a0',
  closed: '#888888',
  merged: '#8250df',
} as const;

// ─── Conflict panel colors ────────────────────────────────────────────────────
export const CONFLICT_COLORS = {
  ours    : '#3b82f6',   // HEAD / our version — blue
  theirs  : '#16a34a',   // incoming version — green
  resolved: '#a3e635',   // diff highlights and new-tag indicator — lime
} as const;

// ─── Activity feed owner-avatar palette ──────────────────────────────────────
// Subset of NOTE_COLORS (white excluded — too light for avatars), used for
// deterministic owner color hashing.
export const ACTIVITY_PALETTE: readonly string[] = [
  NOTE_COLORS.red,
  NOTE_COLORS.orange,
  NOTE_COLORS.green,
  NOTE_COLORS.blue,
  NOTE_COLORS.lavender,
  NOTE_COLORS.yellow,
];

// ─── HTML export palette ─────────────────────────────────────────────────────
export const EXPORT_COLORS = {
  pageBg          : '#F8F9FA',
  border          : '#e2e8f0',
  mutedText       : '#64748b',
  codeBg          : '#f1f5f9',
  blockquoteBorder: '#cbd5e1',
} as const;

// ─── Platform / VS Code fallback colors ──────────────────────────────────────
export const PLATFORM_COLORS = {
  vsFocusBorder: '#0078d4',
  vsDarkBg     : '#252526',
  vsEditorDark : '#1e1e1e',
} as const;

// ─── Utility ─────────────────────────────────────────────────────────────────
/** Converts a 6-digit hex color to its "r,g,b" string for use in rgba(). */
export function hexToRgb(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
