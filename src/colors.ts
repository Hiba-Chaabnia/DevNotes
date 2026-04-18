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
  activityBg : '#7B61FF',   // activity feed accent / avatar background
  muted      : '#94a3b8',   // neutral/inactive state (archived, gh-closed)
  amber      : '#FFB400',   // warning highlights — conflict diff rows
} as const;

// ─── GitHub status colors ─────────────────────────────────────────────────────
export const GH_COLORS = {
  open  : '#06d6a0',
  closed: '#888888',
  merged: '#8250df',
} as const;

// ─── RGB component strings for rgba() usage in CSS ───────────────────────────
// Each entry is the "r,g,b" portion of rgba(r,g,b,a) for the matching color.
export const RGB = {
  text  : '26,26,46',     // UI_COLORS.text
  red   : '255,82,77',    // NOTE_COLORS.red
  blue  : '67,180,251',   // NOTE_COLORS.blue
  amber : '255,180,0',    // UI_COLORS.amber
  danger: '224,82,82',    // UI_COLORS.danger
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
} as const;
