import { useEffect, useState } from 'react';
import BrandLogo from './BrandLogo';

// Detect Electron environment
const electronAPI = typeof window !== 'undefined' ? (window as any).electronAPI : null;

function WinControls({ isMaximized }: { isMaximized: boolean }) {
  return (
    <div
      className="flex items-center h-full"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Minimize */}
      <button
        title="Minimize"
        onClick={() => electronAPI?.minimize()}
        className="flex items-center justify-center w-11 h-full text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition-colors"
        style={{ fontSize: 14 }}
      >
        <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
          <rect width="10" height="1" />
        </svg>
      </button>
      {/* Maximize / Restore */}
      <button
        title={isMaximized ? 'Restore' : 'Maximize'}
        onClick={() => electronAPI?.maximize()}
        className="flex items-center justify-center w-11 h-full text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition-colors"
      >
        {isMaximized ? (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="3" y="1" width="7" height="7" />
            <path d="M1 3v7h7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="0.6" y="0.6" width="8.8" height="8.8" />
          </svg>
        )}
      </button>
      {/* Close */}
      <button
        title="Close"
        onClick={() => electronAPI?.close()}
        className="flex items-center justify-center w-11 h-full text-slate-600 hover:bg-red-600 hover:text-white transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
          <line x1="1" y1="1" x2="9" y2="9" />
          <line x1="9" y1="1" x2="1" y2="9" />
        </svg>
      </button>
    </div>
  );
}

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const isMac = electronAPI?.platform === 'darwin';

  useEffect(() => {
    if (!electronAPI) return;
    electronAPI.isMaximized().then(setIsMaximized);
    const cleanup = electronAPI.onMaximizeChange(setIsMaximized);
    return cleanup;
  }, []);

  if (!electronAPI) return null;

  return (
    <div
      className="flex items-center shrink-0 select-none border-b border-slate-200"
      style={{
        height: 36,
        background: '#fbf6ea',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* macOS: leave space for traffic lights on the left */}
      {isMac && <div style={{ width: 76 }} />}

      {/* Logo + title — always center-ish */}
      <div className="flex items-center gap-2 px-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <BrandLogo size="sm" />
        <span className="text-xs font-semibold text-slate-700" style={{ fontFamily: 'Space Mono, monospace', letterSpacing: '0.03em' }}>
          WatchTower
        </span>
      </div>

      {/* Spacer fills the drag region */}
      <div className="flex-1" />

      {/* Windows / Linux window controls on the right */}
      {!isMac && <WinControls isMaximized={isMaximized} />}
    </div>
  );
}
