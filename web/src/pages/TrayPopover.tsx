/**
 * TrayPopover — the page loaded into the Electron tray popover window.
 *
 * This is the WatchTower analogue of Tailscale's menu-bar dropdown: a frameless,
 * transparent, borderless window hanging off the system-tray icon. It renders
 * the full MenubarWidget (live toggle, identity, this-device, dependency rows,
 * CPU/RAM footprint) — the rich, interactive menu, not a native text menu.
 *
 * Rendered WITHOUT the app chrome (no sidebar, no RequireAuth redirect): in the
 * desktop build the token is injected before React boots, so the widget's data
 * hooks authenticate normally. The body is transparent (set via a body class)
 * so the widget's own rounded card + shadow are the only visible surface,
 * matching a native popover.
 */

import { useEffect } from 'react';
import MenubarWidget from '@/components/MenubarWidget';

export default function TrayPopover() {
  // The popover window is sized to the widget. Make the document background
  // transparent so only the card shows (native-popover look), and restore on
  // unmount so navigating back to the SPA in the same renderer isn't affected.
  useEffect(() => {
    const prevHtml = document.documentElement.style.background;
    const prevBody = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.classList.add('tray-popover-body');
    return () => {
      document.documentElement.style.background = prevHtml;
      document.body.style.background = prevBody;
      document.body.classList.remove('tray-popover-body');
    };
  }, []);

  // Electron closes/hides the window on blur; onClose is a no-op safety net
  // (the IPC-driven hide is the real dismiss path).
  const requestClose = () => {
    const api = (window as unknown as { electronAPI?: { closeTrayPopover?: () => void } }).electronAPI;
    api?.closeTrayPopover?.();
  };

  return (
    <div className="min-h-screen w-full flex items-start justify-center p-2 bg-transparent">
      <MenubarWidget onClose={requestClose} />
    </div>
  );
}
