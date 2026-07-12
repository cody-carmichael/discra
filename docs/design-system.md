# Discra Design System — "Dark Fantasy" Tokens & Patterns

**Date:** 2026-07-05 · **Phase 5.1 deliverable.** One theme source of truth for web + mobile.

- **Web tokens:** [`backend/frontend/assets/tokens.css`](../backend/frontend/assets/tokens.css) — imported by
  **both** stylesheets (`styles.css` for admin/public pages, `driver-mobile.css` for the driver PWA).
- **Mobile tokens:** [`mobile/theme.ts`](../mobile/theme.ts) — the parallel object for React Native.
  **The two files must change together in the same PR.**

The mood: a calm, torch-lit control tower. Deep violet-black bases, warm gold as the only
loud color, engraved serif display type, flat radii, warm-tinted glows — game-like flourish
kept tasteful (one celebration moment, ember accents), never neon, never neutral grey.

## 1. Tokens

### Color

| Token (CSS / theme.ts) | Value | Use |
|---|---|---|
| `--bg-deepest` / `bgDeepest` | `#070510` | Full-screen overlays, deepest wells |
| `--bg-base` / `bgBase` | `#0B0910` | Page background |
| `--bg-surface` / `bgSurface` | `#130F1A` | Panels, cards |
| `--bg-elevated` / `bgElevated` | `#1C1628` | Raised surfaces, modals |
| `--bg-input` / `bgInput` | `#0F0C16` | Form fields |
| `--border-default` / `borderDefault` | `#3A2F50` | Standard hairlines |
| `--border-accent` / `borderAccent` | `#6B4F2A` | Emphasized panel edges |
| `--border-glow` / `borderGlow` | `#C8973A` | Focus/active edges |
| `--gold-primary` / `goldPrimary` | `#C8973A` | THE accent: primary actions, brand |
| `--gold-bright` / `goldBright` | `#F0C060` | Hover/active gold, highlights |
| `--gold-dim` / `goldDim` | `#7A5C22` | Gold gradients' dark stop |
| `--text-primary` / `textPrimary` | `#EDE0C4` | Body text (parchment) |
| `--text-heading` / `textHeading` | `#F5D98B` | Headings, brand text |
| `--text-muted` / `textMuted` | `#968AA8` | Secondary text, labels |
| `--text-danger` / `danger` | `#D94D4D` | Errors, Failed status |
| `--danger-dim` / `dangerDim` | `#7A2222` | Danger gradients' dark stop |
| `--text-success` / `success` | `#4A9E5C` | Success, Delivered, online |
| `--purple-accent` / `purpleAccent` | `#7B4FA6` | Secondary accent (sparingly) |
| `--purple-light` / `purpleLight` | `#B18ED0` | Light purple text accents |
| `--blue-deep` / `blueDeep` | `#1E3A5C` | Rare cool accent |

Mobile-only extensions (`theme.ts` `colors.*`): `bgSheet #1A1526`, `bgElevatedAlt #241A33`,
`bgPanelAlt #1F1A2E`, `goldTintBg #2A1E10`, `onGold #1A1424`, `placeholder #4A3F60`,
`purpleBright #9D6FC8`, `successDim #1A5C3A`, `dangerMuted #9B3A3A`, `emberOrange #E05A3B`.
Fold one into `tokens.css` the day the web needs it — don't mint a near-duplicate.

### Typography

| Token | Stack | Use |
|---|---|---|
| `--font-ornate` | Cinzel Decorative → Cinzel → Georgia | Brand marks, hero wordmark only |
| `--font-display` | Cinzel → Trajan Pro → Georgia | Headings, buttons, labels (uppercase + letter-spacing) |
| `--font-body` | Crimson Pro → Iowan Old Style → Georgia | Body copy |
| `--font-mono` | Fira Code → IBM Plex Mono → Consolas | IDs, tokens, debug |

Mobile currently ships system fonts; Cinzel/Crimson adoption lands with Phase 5.4.

### Spacing, radius, shadows, motion

- **Spacing:** `--space-1..7` = 4 / 8 / 12 / 16 / 24 / 32 / 48 px (`theme.spacing.xs..xxxl`).
  Use steps, not ad-hoc pixel values.
- **Radius:** web is flat — `--radius-sm 2px`, `--radius-md 4px`, nothing rounder.
  *Documented deviation:* native mobile touch surfaces may use `theme.radius.lg/xl/pill`
  (8/12/999) for sheets and pills.
- **Shadows:** always warm-tinted — `--shadow-panel`, `--shadow-glow`, `--shadow-strong`.
  Never a neutral-grey drop shadow.
- **Motion:** `--motion-fast/base/slow` = 120/200/400 ms with `--ease-out`. **Every**
  animation sits behind the existing `prefers-reduced-motion: reduce` blocks (both
  stylesheets already have them — keep it that way).

## 2. Component patterns (already in the codebase — reuse, don't reinvent)

| Pattern | Classes / source | Notes |
|---|---|---|
| Buttons (admin/public) | `.btn` + `.btn-primary` (gold gradient), `.btn-accent`, `.btn-ghost`, `.btn-link` | Display font, uppercase, letter-spaced |
| Buttons (driver PWA) | `.drv-btn` + `-accent/-green/-red/-ghost`, sizes `-sm/-xs` | Disabled = `.4` opacity, `pointer-events:none` |
| Panels | `.panel`, `.panel-ornate` (engraved top rule), `.hero-card`, `.data-surface` | Ornate = landing/marketing only |
| Status badges | `.status-pill`, `.table-status status-*`, `.drv-status-pill on/off`, `.dispatch-status-badge` | Tinted bg at ~18% alpha + matching border/text |
| Forms | `.field` (label span + input), `.form-grid`, `.login-fields` | Inputs on `--bg-input`, focus = `--border-glow` |
| Messages | `.message`, `.drv-msg` + `.success/.error` | Inline, small, colored text — not toasts |
| Celebration | driver POD "level-up" flourish (`driver.js` + `driver-mobile.css` masks), mobile `DeliveryCelebration` | THE one game-like moment; keep fast + reduced-motion-safe |
| Atmosphere | `.landing-*` (vignette, fog, embers) | Landing page only — never inside work surfaces |

## 3. Do / Don't

**Do**
- Reference tokens for every color/font/radius/shadow — `var(--…)` on web, `theme.*` on mobile.
- Keep gold scarce: one primary action per view; secondary actions are ghost/muted.
- Uppercase + letter-spacing for display-font labels; sentence case for body copy.
- Add new shades to `tokens.css` **and** `theme.ts` together, with a semantic name.
- Gate every animation behind reduced-motion.

**Don't**
- Hardcode hex in component rules or RN styles (the lint-by-grep check below).
- Introduce neutral greys, pure white text, blue links, or default-browser focus rings.
- Round corners past 4px on web, or stack multiple glow shadows.
- Put landing atmosphere (fog/embers) inside the admin/driver work surfaces.
- Use ornate font for anything longer than a brand mark.

**Check before merging a styling PR:**
`grep -nE "#[0-9A-Fa-f]{3,8}" <changed css/tsx>` — every hit should be in `tokens.css`,
`theme.ts`, or a functional mask/alpha, not a component rule.

## 4. Reference screen (proof) & rollout

- **Driver PWA is the 5.1 reference screen**: `driver-mobile.css` now imports `tokens.css`
  and its entire `--drv-*` layer is *aliases* onto the shared tokens (zero raw palette hex
  left outside functional masks). Verified pixel-identical before/after in the preview.
- `styles.css` imports the same tokens; its ~25 body-level hex stragglers are cleaned
  per-screen during **5.2 (admin console)** and **5.3 (driver PWA polish)** — not big-banged.
- Mobile screens migrate onto `theme.ts` in **5.4**; accessibility/contrast pass is **5.5**.
- **Cache note:** both service workers precache the stylesheets — any tokens/CSS change
  must bump `CACHE_NAME` + the `?v=` params in `driver-sw.js` / `admin-sw.js` and the HTML
  links, or PWA clients keep the stale theme.
