/**
 * Theme control — light / dark, persisted, applied as a `.dark` class on <html>
 * (Tailwind class dark-mode). Dark is WatchTower's default identity; the user can
 * switch to light and it's remembered. No flash: applyStoredTheme runs on boot.
 */

export type Theme = 'light' | 'dark';

const KEY = 'watchtower.theme';

/** The user's saved choice, or the default (dark). */
export function getTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* private mode */
  }
  return 'dark'; // WatchTower defaults to dark
}

/** Put the theme on <html> so every token flips at once. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** Boot: apply whatever was saved (or the default). */
export function applyStoredTheme() {
  applyTheme(getTheme());
}

/** Set + persist + apply. Returns the new theme. */
export function setTheme(theme: Theme): Theme {
  try { localStorage.setItem(KEY, theme); } catch { /* private mode */ }
  applyTheme(theme);
  return theme;
}

/** Flip light↔dark, persist, apply. Returns the new theme. */
export function toggleTheme(): Theme {
  return setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}
