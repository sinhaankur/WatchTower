# WatchTower — 60-second demo video

**One job for this video:** make a viewer feel the thing no competitor does —
*a deploy breaks and WatchTower fixes it by itself.* Everything else is setup
for that beat. Cut anything that doesn't serve it.

- **Length:** 60s hard cap (people drop off after that on X/HN/Reddit).
- **Format:** screen recording, 1280×800, no talking head. Captions burned in
  (most people watch muted). One calm background track, low.
- **Voiceover:** optional. If used, keep it to the lines in **bold** below.
- **Record at 2× scale** so text is crisp when compressed by the platform.

---

## The shot list

### 0:00–0:06 — The hook (cold open on the failure)
- Open on the **Dashboard** with one project already deployed and green.
- Caption: **"Your self-hosted apps, on a computer you already own."**
- Beat. Then a deploy card flips to **red / Failed**.
- Caption: **"A deploy just broke. Watch what happens."**

> Why cold-open on failure: the payoff is self-healing, so start the clock on
> the problem immediately. Don't spend the first 20s explaining what the app is.

### 0:06–0:14 — The setup (show it's real, fast)
- Quick cut: the **Applications** page — one row, primary **Deploy** button,
  the "⋯" overflow. Half a second, just to prove it's a real product.
- Cut to the failed deployment's detail — the red status + a one-line reason
  ("Port 8000 already in use" or "registry pull timeout" — pick a clean one).
- Caption: **"No dashboards to babysit. No 2am pager."**

### 0:14–0:34 — THE MONEY SHOT (self-heal, uncut)
- Back to the **Dashboard**. The **"What WatchTower fixed"** feed
  (`SelfHealingCard`) animates in a new row:
  - `Port conflict → reassigned port → redeploying…`
  - status pill goes **pending → auto-applied**.
- Then the deploy card flips **red → amber (retrying) → green**.
- Hold on green for a full beat. This is the whole video.
- Caption sequence (one at a time, synced to the state changes):
  - **"It diagnosed the failure,"**
  - **"applied the fix,"**
  - **"and redeployed —"**
  - **"while you were doing literally anything else."**

> This 20s is the ad. If you only nail one segment, nail this one. Record it
> several times and keep the take where the color transition reads clearly.

### 0:34–0:46 — Why it's yours, safely
- Cut to **Remote Access**: the WatchTower → Tailscale → Your devices diagram.
- Caption: **"Reach it from your phone over Tailscale. No open ports."**
- Quick cut to **Settings → AI & Autonomy**: the autonomy toggle.
- Caption: **"You decide how much it's allowed to fix on its own."**

> This answers the two objections a self-hoster has watching the money shot:
> "is it exposed to the internet?" (no) and "will it YOLO changes?" (only if
> you flip the switch — default off).

### 0:46–0:56 — The comparison (the claim, on screen)
- Cut to the comparison table (from the landing page): the **"Fixes its own
  failures"** row where WatchTower is the only ✅.
- Caption: **"Coolify, Dokploy, CasaOS deploy. WatchTower deploys — and heals."**

### 0:56–1:00 — CTA
- WatchTower logo (the Wt mark) on a clean card.
- Caption / end frame: **"WatchTower — self-healing self-hosting."**
- Sub-line: the repo URL + "Free and open source."

---

## Capture checklist (so the recording goes in one sitting)

1. Seed a project that deploys cleanly, then force a **known, auto-fixable**
   failure (port conflict is the most legible on camera). The self-heal loop
   classifies it, writes a `HealingAction`, and retries — that's the on-screen
   story. Turn the **autonomy switch ON** first (Settings → AI & Autonomy) or
   the fix sits in the intervention queue instead of auto-applying.
2. Pre-warm every page you'll cut to (Applications, Remote Access, Settings) so
   there's no loading spinner mid-take.
3. Hide anything with a real hostname / email — use a demo org ("Your Org",
   "you@local").
4. Record the money shot (0:14–0:34) **as one continuous take** if you can, so
   the red→amber→green transition is obviously real and not edited together.

## Distribution (pair the video with these)

- **Show HN:** "WatchTower – self-hosted deploys that fix their own failures."
  Lead comment: the port-conflict → auto-fix story, 3 sentences, link the video.
- **r/selfhosted:** same clip, title framed as "I got tired of babysitting
  failed deploys, so I made it heal itself."
- Get on the **"Coolify alternatives 2026"** and **"self-hosted PaaS"** lists —
  the self-heal row is the hook that gets you added.
