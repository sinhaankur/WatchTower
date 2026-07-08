import { useState } from 'react';
import { useManagedSshKey } from '@/hooks/queries';

/**
 * Guided SSH setup for adding a remote server without manual key management.
 *
 * Collapsed by default; on expand it fetches WatchTower's managed deploy public
 * key (created on first use, private key stays on the host) and shows:
 *   1. a copy-paste one-liner to authorize the key on the remote, and
 *   2. a "Use this key" button that pre-fills the add-server form's key path.
 *
 * onUseKey(path) lets the parent set ssh_key_path so the user doesn't type it.
 */
function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch { /* ignore */ }
      }}
      className="px-2 py-0.5 rounded border border-border bg-card text-foreground text-[11px] hover:bg-muted transition-colors shrink-0"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export default function GuidedSshSetup({ onUseKey }: { onUseKey: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useManagedSshKey(open);

  return (
    <div className="rounded-lg border border-border-soft bg-surface-soft">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-xs font-semibold text-foreground">
          Guided SSH setup
          <span className="text-muted-foreground font-normal"> — no manual keys</span>
        </span>
        <span className="text-muted-foreground text-xs">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          {isLoading && <p className="text-[11px] text-muted-foreground">Preparing key…</p>}
          {error && (
            <p className="text-[11px] text-red-600">
              Could not prepare an SSH key (is ssh-keygen available on the host?).
            </p>
          )}
          {data && (
            <>
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-[11px] font-medium text-foreground">
                    1. Authorize this key on the remote machine
                  </p>
                  <CopyBtn text={data.authorize_command} label="Copy command" />
                </div>
                <pre className="text-[10px] text-muted-foreground bg-card border border-border rounded p-2 whitespace-pre-wrap break-all">
                  {data.authorize_command}
                </pre>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Run it once on the server (over your existing access), or paste the key into{' '}
                  <span className="font-mono">~/.ssh/authorized_keys</span>.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-[11px] font-medium text-foreground">2. Use it for this server</p>
                  <CopyBtn text={data.public_key} label="Copy public key" />
                </div>
                <button
                  type="button"
                  onClick={() => onUseKey(data.private_key_path)}
                  className="px-3 py-1.5 rounded-md bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold shadow-retro"
                >
                  Use this key
                </button>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Fills the SSH key path below with WatchTower's managed key. Then add the server.
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
