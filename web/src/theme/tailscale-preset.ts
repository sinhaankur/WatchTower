/**
 * Tailscale-quality theme preset for WatchTower  (DRAFT — opt-in, non-destructive)
 * ---------------------------------------------------------------------------
 * WatchTower's current look is neo-brutalist (hard 2px offset shadows, heavy
 * #1f2937 borders, red accent). Tailscale's is the opposite: restraint —
 * near-zero shadows, hairline borders, a single soft accent, warm canvas,
 * LIGHT-weight headlines. This preset remaps the SAME CSS variables the app
 * already consumes (--background, --foreground, --muted-foreground, --radius,
 * --shadow, …) so components inherit the new aesthetic WITHOUT edits.
 *
 * HOW TO USE (when the repo tree is clean):
 *   1. Import the token blocks below into globals.css (:root and .dark).
 *   2. Optionally merge `tailscaleThemeExtend` into tailwind.config.ts theme.extend.
 *   3. Flip headline weights to 300–400 (see fontWeight notes).
 *
 * Values calibrated from researched Tailscale tokens:
 *   fudge.design/share/tailscale.com-design + tailscale.com/blog/heart-of-dark-mode
 *
 * Note: variables are HSL triplets (no hsl() wrapper) to match the app's
 * existing `hsl(var(--x))` usage in tailwind.config.
 */

/* ---- LIGHT theme CSS variables (paste into globals.css :root) ---- */
export const lightVars = `
  /* Canvas: warm off-white, not stark white — "lets content breathe" */
  --background: 20 14% 99%;          /* #FEFDFC warm canvas */
  --foreground: 0 0% 10%;            /* #1A1A1A ink */
  --card: 0 0% 100%;                 /* #FFFFFF */
  --card-foreground: 0 0% 10%;
  --popover: 0 0% 100%;
  --popover-foreground: 0 0% 10%;

  /* One accent, used as rare punctuation — Tailscale signal green */
  --primary: 152 60% 53%;            /* #3ECF8E */
  --primary-foreground: 0 0% 100%;
  --accent: 152 60% 53%;
  --accent-foreground: 0 0% 10%;

  /* Muted / secondary surfaces */
  --secondary: 0 0% 96%;             /* #F5F5F5 surface */
  --secondary-foreground: 0 0% 10%;
  --muted: 0 0% 96%;
  --muted-foreground: 0 0% 29%;      /* #4A4A4A muted-ink */
  --surface-soft: 0 0% 98%;

  /* Destructive stays red but desaturated toward Tailscale's signal red */
  --destructive: 6 62% 54%;          /* #d04841 */
  --destructive-foreground: 0 0% 100%;

  /* Hairline borders — NOT the heavy #1f2937 */
  --border: 0 0% 90%;                /* #E5E5E5 */
  --border-soft: 0 0% 94%;
  --input: 0 0% 90%;
  --ring: 152 60% 53%;               /* focus ring = accent */
  --sidebar: 20 14% 99%;
  --sidebar-border: 0 0% 92%;

  /* Elevation via near-zero shadow — Tailscale uses ~2% black @ 4px */
  --shadow: 0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.02);
  --shadow-hover: 0 2px 8px 0 rgb(0 0 0 / 0.06);

  /* Soft, generous radius (0.5–1rem; 16px dominant on cards/nav) */
  --radius: 0.75rem;
`;

/* ---- DARK theme (paste into globals.css .dark) ----
 * Per Tailscale's dark-mode writeup: extend grayscale, bump shadow opacity
 * to ~20% (vs ~10% light), add borders to elevated surfaces, more-opaque
 * overlays. Elevation needs MORE help in dark.
 */
export const darkVars = `
  --background: 160 20% 7%;          /* #0D1F17 dark-surface, slight green cast */
  --foreground: 0 0% 95%;
  --card: 160 15% 10%;
  --card-foreground: 0 0% 95%;
  --popover: 160 15% 10%;
  --popover-foreground: 0 0% 95%;

  --primary: 152 48% 42%;            /* #2A9D6A dark-action — higher sat, darker */
  --primary-foreground: 0 0% 100%;
  --accent: 152 48% 42%;
  --accent-foreground: 0 0% 95%;

  --secondary: 160 12% 14%;
  --secondary-foreground: 0 0% 95%;
  --muted: 160 12% 14%;
  --muted-foreground: 0 0% 64%;
  --surface-soft: 160 12% 12%;

  --destructive: 6 55% 50%;
  --destructive-foreground: 0 0% 100%;

  /* Borders do real work in dark — delineate elevated surfaces */
  --border: 160 10% 18%;
  --border-soft: 160 10% 15%;
  --input: 160 10% 18%;
  --ring: 152 48% 42%;
  --sidebar: 160 20% 6%;
  --sidebar-border: 160 10% 16%;

  /* ~20% shadow opacity + borders carry elevation in dark */
  --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.22), 0 1px 2px 0 rgb(0 0 0 / 0.18);
  --shadow-hover: 0 4px 12px 0 rgb(0 0 0 / 0.30);
`;

/* ---- Tailwind theme.extend additions (merge into tailwind.config.ts) ---- */
export const tailscaleThemeExtend = {
  fontFamily: {
    // Inter variable for everything; MDIO-style geometric mono for small
    // technical labels (CNR, IDs, status codes) with wide tracking.
    sans: ['Inter', 'system-ui', 'sans-serif'],
    mono: ['"MD IO"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
  },
  fontWeight: {
    // Signature: headlines WHISPER at 300–400, not 700. Authority via restraint.
    display: '300',
    heading: '400',
    label: '500',
  },
  letterSpacing: {
    label: '0.01em',   // wide tracking for small technical labels
    tight: '-0.02em',  // hero display
  },
  boxShadow: {
    // Keep the retro utilities available, but default elevation is soft.
    retro: 'var(--shadow)',
    'retro-hover': 'var(--shadow-hover)',
    soft: 'var(--shadow)',
    'soft-hover': 'var(--shadow-hover)',
  },
} as const;
