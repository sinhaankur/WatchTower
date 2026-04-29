/**
 * CommandPalette — Cmd/Ctrl-K modal for quick navigation.
 *
 * Pattern: items list + fuzzy-by-substring filter + ↑/↓ to move + Enter
 * to execute + Escape to close. Items are nav routes plus the user's
 * project list (cached by React Query) so "jump to project foo" works
 * without a separate page.
 *
 * Why build this instead of pulling in cmdk/kbar:
 *   - Cost: another runtime dep + bundle size for what is ~150 lines.
 *   - Control: this matches our existing Tailwind palette and Toaster
 *     UX exactly. A library would import its own tokens.
 *   - Simplicity: the whole point of the polish PR is that the app
 *     feels designed-from-scratch, not assembled.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '@/hooks/queries';

type Item = {
  id: string;
  label: string;
  group: 'Navigate' | 'Projects';
  hint?: string;
  to: string;
};

const NAV_ITEMS: Item[] = [
  { id: 'nav:dashboard',     label: 'Dashboard',         group: 'Navigate', to: '/' },
  { id: 'nav:applications',  label: 'Applications',      group: 'Navigate', to: '/applications' },
  { id: 'nav:servers',       label: 'Servers',           group: 'Navigate', to: '/servers' },
  { id: 'nav:services',      label: 'Services',          group: 'Navigate', to: '/services' },
  { id: 'nav:integrations',  label: 'Integrations',      group: 'Navigate', to: '/integrations' },
  { id: 'nav:team',          label: 'Team',              group: 'Navigate', to: '/team' },
  { id: 'nav:audit',         label: 'Audit Log',         group: 'Navigate', to: '/audit' },
  { id: 'nav:settings',      label: 'Settings',          group: 'Navigate', to: '/settings' },
  { id: 'nav:setup',         label: 'New Project',       group: 'Navigate', hint: 'wizard', to: '/setup' },
];

// Reusable open/close hook so other components can trigger the palette
// (e.g., a future "press ⌘K" hint button somewhere).
const OPEN_EVENT = 'watchtower:open-command-palette';
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: projects = [] } = useProjects();

  // Build the master list each render. Cheap — ~10 nav + tens of projects.
  const items = useMemo<Item[]>(() => {
    const projItems: Item[] = (projects ?? []).map((p) => ({
      id: `proj:${p.id}`,
      label: p.name,
      group: 'Projects',
      hint: p.repo_branch ? `branch: ${p.repo_branch}` : undefined,
      to: `/projects/${p.id}`,
    }));
    return [...NAV_ITEMS, ...projItems];
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      it.label.toLowerCase().includes(q) ||
      it.hint?.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Group for render — preserve original ordering within each group.
  const grouped = useMemo(() => {
    const out: Record<string, Item[]> = { Navigate: [], Projects: [] };
    for (const it of filtered) out[it.group].push(it);
    return out;
  }, [filtered]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl-K toggle
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery('');
        setActiveIdx(0);
      }
    };
    const onOpenEvent = () => {
      setOpen(true);
      setQuery('');
      setActiveIdx(0);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_EVENT, onOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Reset active index when filter changes so the highlighted row
  // doesn't point past the end of the filtered list.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  if (!open) return null;

  const select = (it: Item) => {
    setOpen(false);
    navigate(it.to);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[activeIdx];
      if (it) select(it);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] bg-slate-900/40 backdrop-blur-sm"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-xl mx-4 rounded-xl bg-white border border-slate-200 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 py-3 border-b border-slate-100">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-400 mr-3">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Jump to a page or project…"
            className="flex-1 text-sm text-slate-900 placeholder:text-slate-400 outline-none bg-transparent"
          />
          <kbd className="text-[10px] font-mono text-slate-400 border border-slate-200 px-1.5 py-0.5 rounded">Esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-slate-500">
              No matches for "{query}"
            </div>
          )}
          {Object.entries(grouped).map(([group, groupItems]) => {
            if (groupItems.length === 0) return null;
            return (
              <div key={group} className="py-1">
                <div className="px-4 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                  {group}
                </div>
                {groupItems.map((it) => {
                  const idx = filtered.indexOf(it);
                  const active = idx === activeIdx;
                  return (
                    <button
                      key={it.id}
                      onClick={() => select(it)}
                      onMouseEnter={() => setActiveIdx(idx)}
                      className={`w-full flex items-center justify-between px-4 py-2 text-sm text-left transition-colors ${
                        active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="truncate">{it.label}</span>
                      {it.hint && (
                        <span className={`text-[11px] ml-3 truncate ${active ? 'text-slate-300' : 'text-slate-400'}`}>
                          {it.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between px-4 py-2 border-t border-slate-100 text-[10px] text-slate-500">
          <div className="flex items-center gap-3">
            <span><kbd className="font-mono border border-slate-200 px-1 rounded">↑↓</kbd> navigate</span>
            <span><kbd className="font-mono border border-slate-200 px-1 rounded">↵</kbd> jump</span>
            <span><kbd className="font-mono border border-slate-200 px-1 rounded">Esc</kbd> close</span>
          </div>
          <span>{filtered.length} result{filtered.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
