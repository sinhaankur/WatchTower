# WatchTower — UX Framework Audit

Measured against Ankur's **Universal Experience Framework**
(sinhaankur.com/framework): the 7 principles + the cognitive laws. Grounded in
the actual code + the screens reviewed 2026-10-08.

> **Logo sets the standards.** The Wt logo — a cream/**amber** rounded square, a
> dark border, a hard **2px offset shadow**, and a **red "Wt"** — is the source
> of truth for the palette and character. WatchTower is NOT generic-minimal; it
> has its own bolder identity. Amber = accent, red = a brand colour (not only
> "danger"), the offset-shadow is a signature. **The logo itself stays intact.**

---

## The violations (prioritised by impact)

### 🔴 P1 — "One primary action per screen" (the biggest problem)
The framework: *every screen gets exactly one visually dominant action; everything
else recedes.* WatchTower violates this hard:

| Screen | Primary (amber) buttons | Should be |
|---|---|---|
| ManagedDatabases | **12** | 1 |
| ProjectDetail | **9** | 1 |
| Dashboard | **8** (4 strong) | 1 |
| HostConnect | 5 | 1 |
| Servers / Applications | 4 | 1 |

**Effect:** nothing guides the eye (Von Restorff is lost — when everything is
amber, nothing stands out). This is the #1 reason it "feels bad."
**Fix:** one amber primary per screen; demote the rest to `secondary`/`ghost`/
`outline` variants of the Button primitive.

### 🔴 P1 — "One system, not six"
- **80 inline hand-drawn `<svg>`s** with inconsistent viewBoxes (24×24, 16×16,
  100×100, 10×10…) **while `lucide-react` is installed** → the "unprofessional
  icons." Fix: replace inline SVGs with lucide (one consistent, crisp set).
- **5 corner-radius values** in play (rounded-sm/md/lg/xl/full: 323/226/144/138/6).
  Fix: standardise to 2 (md for controls, lg for cards) + full for pills/avatars.
- **49 ad-hoc button class strings** bypass the (good) `Button` primitive. Fix:
  route them through `<Button variant=…>`.

### 🟠 P2 — "Signal over surface area" + hierarchy (density)
The framework: *spacing is the primary grouping tool; the scarce valuable outcome
gets the boldest treatment.* The screens are **dense and flat** — similar text
sizes, tight gaps, cards of equal weight. (Dashboard spacing already loosened as a
start.) Fix: a real type/space rhythm — bigger section gaps, one bold headline per
section, secondary text genuinely recessed.

### 🟠 P2 — "Prevent, then forgive" / all states
Good: error strings are mostly plain ("Could not connect to the server").
Gaps: audit empty + loading + success states per screen (framework requires all
four, not just happy path).

### 🟢 P3 — Accessibility (AA)
- Contrast is now token-driven in both themes (fixed the amber-on-amber button).
  Re-verify text ≥ 4.5:1, large/UI ≥ 3:1 per the framework.
- Hit targets: framework wants **≥40px**; several `py-1`/`py-1.5` buttons are
  under. Bump control height to `h-9`/`h-10`.
- `prefers-reduced-motion`: confirm animations cross-fade.

---

## What's already fixed (this pass)
- One tokenised colour system, **both light + dark**, amber accent (logo-derived).
- Typography de-densified: ~400 cramped `text-[10/11px]` → a clean `text-xs/sm` scale.
- Broken amber buttons (amber-on-amber) + light-only warnings → correct tokens.
- Dashboard spacing loosened (first pass).

## The plan (framework-ordered)
1. **Icons → lucide** app-wide (kills the "unprofessional" look; one system).
2. **One primary action** per screen (demote competing amber buttons).
3. **Hierarchy + spacing** rhythm, screen by screen (Dashboard = the template).
4. **Radius/shadow** standardised to the logo's character (keep the signature).
5. **States + a11y** pass (empty/loading/error/success, ≥40px, AA, reduced-motion).

Same framework then applies to sinhaankur.com + other projects.
