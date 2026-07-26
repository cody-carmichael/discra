// theme.ts — Discra dark-fantasy design tokens for the Expo app.
//
// PARALLEL of backend/frontend/assets/tokens.css — the single source of truth
// for the web apps. If a value changes there, change it here in the same PR
// (see docs/design-system.md for the token table and usage rules).
//
// Adoption: new/edited styles must reference `theme.*` instead of raw hex.
// Existing screens are migrated screen-by-screen in Phase 5.4 — do not add
// NEW hardcoded hex values anywhere in mobile/.

export const theme = {
  colors: {
    // Backgrounds (shared with tokens.css)
    bgDeepest: "#070510",
    bgBase: "#0B0910",
    bgSurface: "#130F1A",
    bgElevated: "#1C1628",
    bgInput: "#0F0C16",

    // Borders
    borderDefault: "#3A2F50",
    borderAccent: "#6B4F2A",
    borderGlow: "#C8973A",

    // Gold
    goldPrimary: "#C8973A",
    goldBright: "#F0C060",
    goldDim: "#7A5C22",

    // Text
    textPrimary: "#EDE0C4",
    textHeading: "#F5D98B",
    textMuted: "#968AA8",
    danger: "#D94D4D",
    success: "#4A9E5C",

    // Status depth
    dangerDim: "#7A2222",

    // Order-status progression (parity with tokens.css --status-*)
    statusCreated: "#968AA8",
    statusAssigned: "#C8973A",
    statusPickedUp: "#E0A43B",
    statusEnRoute: "#4A9E5C",
    statusDelivered: "#4A9E5C",
    statusFailed: "#D94D4D",

    // Secondary accents
    purpleAccent: "#7B4FA6",
    purpleLight: "#B18ED0",
    blueDeep: "#1E3A5C",

    // ── Mobile-scoped extensions (used by RN screens today; not in the web
    //    palette — fold into tokens.css if the web ever needs them) ──
    bgSheet: "#1A1526",          // bottom-sheet / card surface
    bgElevatedAlt: "#241A33",    // raised chips / modals
    bgPanelAlt: "#1F1A2E",       // secondary panel surface
    goldTintBg: "#2A1E10",       // gold-tinted dark fill (active states)
    onGold: "#1A1424",           // text/icon on gold buttons
    placeholder: "#4A3F60",      // input placeholderTextColor
    purpleBright: "#9D6FC8",     // brighter purple accent (map/route)
    successDim: "#1A5C3A",
    dangerMuted: "#9B3A3A",
    emberOrange: "#E05A3B",      // warning/ember accent
  },

  // Spacing scale — use steps, not ad-hoc numbers (mirrors --space-1..7).
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
    xxxl: 48,
  },

  // Radius — web stays flat (2–4px); native touch surfaces earn softer
  // corners (documented deviation, see design-system.md).
  radius: {
    sm: 2,
    md: 4,
    lg: 8,
    xl: 12,
    pill: 999,
  },

  // Motion durations in ms (mirrors --motion-*). Gate anything animated
  // behind reduced-motion checks where the platform exposes them.
  motion: {
    fast: 120,
    base: 200,
    slow: 400,
  },
} as const;

export type Theme = typeof theme;
