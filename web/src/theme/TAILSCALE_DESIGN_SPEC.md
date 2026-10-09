# WatchTower → Tailscale-quality UI/UX  (DRAFT design spec)

> Goal: bring WatchTower's UI to the quality bar of Tailscale's admin console.
> Status: **draft / opt-in**. Nothing here edits existing components. The token
> remap flows through the CSS variables the app already consumes.
> Companion file: `tailscale-preset.ts` (droppable tokens).

## The core shift

WatchTower today is **neo-brutalist**: hard `2px 2px 0` offset shadows (`shadow-retro`),
heavy `#1f2937` borders, red `#b91c1c` accent, stark white. Tailscale is the
**opposite — restraint**. This is a *philosophical* change, not a reskin:

| Axis | WatchTower now | Tailscale target |
|------|----------------|------------------|
| Shadows | Hard offset `2px 2px 0` | Barely-there (~2% light / ~20% dark); elevation via color+spacing |
| Borders | Heavy `#1f2937` | Hairline `#E5E5E5` |
| Accent | Red `#b91c1c`, prominent | Green `#3ECF8E`, **rare punctuation** |
| Canvas | Stark white | Warm off-white, generous whitespace |
| Headlines | Bold | **Light 300–400** ("whisper, not shout") |
| Radius | — | Soft 0.5–1rem (16px dominant) |

## Why it's low-risk to adopt

WatchTower's architecture is *already* Tailscale-shaped:
- Semantic HSL CSS variables (`--background`, `--muted-foreground`, …) — same pattern Tailscale uses.
- Radix primitives + `tailwindcss-animate`.

So the preset **remaps the variables**; components inherit the new look unchanged.

## Application order (when the repo tree is clean)

1. **Tokens** — paste `lightVars` / `darkVars` into `globals.css` `:root` / `.dark`.
   Lowest-risk, highest-impact: the whole app recolors at once.
2. **Shadows** — audit uses of `shadow-retro`. The preset softens it globally; keep
   the hard offset only where it's an intentional brand moment (e.g. the logo card).
3. **Typography** — set display/heading weights to 300–400. Load Inter variable +
   an MDIO-like mono for small technical labels (device IDs, status codes) with
   `tracking-label`.
4. **Accent discipline** — reduce red to *destructive-only*; promote green to the
   single action accent. One accent, used sparingly.
5. **Dark mode** — verify elevation: borders on elevated surfaces, ~20% shadow,
   head-script to prevent flash-of-white (Tailscale's fix).

## UX patterns to adopt (beyond color)

**Empty states** (WatchTower has machines / projects / deploy / audit lists).
Every empty state answers three questions:
- *What* is this screen for?  *Why* is it empty now?  *What's my one next step?*

Rules:
- Exactly **one** primary action. Never a dead end. Offer templates / sample data.
- First-run empty state is the **highest-leverage screen** (activation vs churn).
- **Distinguish empty vs loading vs error.** Do NOT flash "No projects yet" for
  ~200ms before live data arrives — users misclick "Create" before the list fills.
  WatchTower's lists update live (deploy status, machine status) so this matters.

**Status / machines table** (Tailscale's signature screen):
- Dense but calm: hairline row dividers, generous row height, status as a small
  colored dot + muted label, not loud badges.
- Monospace for addresses/IDs with wide tracking.
- Right-aligned actions revealed on row hover, not always-on buttons.

## Don't-break list
- Keep the `shadow-retro` *utility* defined (back-compat); just change the default.
- Keep HSL-triplet variable format (`hsl(var(--x))` consumers depend on it).
- Radix animation keyframes stay as-is.

## Sources
- fudge.design/share/tailscale.com-design (tokens)
- tailscale.com/blog/heart-of-dark-mode (dark-mode architecture, semantic tokens)
