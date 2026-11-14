/**
 * TopBarStatus — the always-visible status chip that opens MenubarWidget.
 *
 * This is the analogue of Tailscale's menubar icon: a small, quiet affordance
 * that shows connected/offline at a glance and reveals the full status menu on
 * click. Anchored top-right of the app's content area.
 *
 * The popover is rendered through a portal to document.body and positioned from
 * the chip's bounding rect — Layout nests the content in several `overflow-hidden`
 * containers, which would otherwise clip a downward-opening menu.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Wifi, WifiOff, ChevronDown } from 'lucide-react';
import { useRemoteAccessState } from '@/hooks/queries';
import MenubarWidget from './MenubarWidget';

const MENU_WIDTH = 320; // w-80

export function TopBarStatus({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const { ready, installed, sharing } = useRemoteAccessState();

  const connected = sharing;
  const label = sharing ? 'Connected' : installed && ready ? 'Ready' : 'Offline';

  // Position the portal under the chip, right-aligned, clamped to the viewport.
  useLayoutEffect(() => {
    if (!open || !chipRef.current) return;
    const place = () => {
      const r = chipRef.current!.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      setCoords({ top: r.bottom + 8, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={chipRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="WatchTower status"
        className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors"
        style={{ borderColor: 'hsl(var(--border))' }}
      >
        <span className={connected ? 'text-emerald-500 dark:text-emerald-400' : 'text-muted-foreground'}>
          {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
        </span>
        <span className="hidden sm:inline">{label}</span>
        <ChevronDown
          size={12}
          className={`text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            className="fixed z-[60] fade-in-up"
            style={{ top: coords.top, left: coords.left, width: MENU_WIDTH }}
          >
            <MenubarWidget onClose={() => setOpen(false)} />
          </div>,
          document.body,
        )}
    </div>
  );
}
