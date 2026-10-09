import { Link } from 'react-router-dom';
import { Github, Wifi, WifiOff, Check } from 'lucide-react';
import { useMe, useRemoteAccessProviders } from '@/hooks/queries';

/**
 * ConnectionStatus — one place that shows BOTH connections a user cares about:
 *   • GitHub  (identity — sign in to deploy from repos, invite a team)
 *   • Tailscale (network — reach your servers privately from anywhere)
 *
 * Lives in the sidebar so "is everything connected?" is answerable at a glance,
 * instead of the two states being scattered across different pages. Each row is
 * a status dot + label + a one-tap action to fix it when it's not connected.
 * Pure theme tokens → correct in light and dark.
 */
export function ConnectionStatus({ compact = false }: { compact?: boolean }) {
  const { data: me } = useMe();
  const { data: providers } = useRemoteAccessProviders();

  const githubOn = !!me?.is_github_authenticated;
  const tailscale = providers?.find((p) => p.id === 'tailscale');
  // "connected" = installed + the daemon is ready (on the tailnet).
  const tailscaleOn = !!(tailscale?.installed && tailscale?.ready);
  const tailscaleInstalled = !!tailscale?.installed;

  return (
    <div className={`space-y-1 ${compact ? '' : 'px-1 py-1.5'}`}>
      {!compact && (
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground px-2 mb-1">
          Connections
        </p>
      )}

      {/* GitHub — identity */}
      <Row
        icon={<Github size={14} />}
        label="GitHub"
        connected={githubOn}
        connectedText="Signed in"
        action={githubOn ? undefined : { to: '/login', label: 'Sign in' }}
      />

      {/* Tailscale — private network */}
      <Row
        icon={tailscaleOn ? <Wifi size={14} /> : <WifiOff size={14} />}
        label="Tailscale"
        connected={tailscaleOn}
        connectedText="Connected"
        pendingText={tailscaleInstalled ? 'Not connected' : 'Not installed'}
        action={
          tailscaleOn
            ? undefined
            : { to: '/remote-access', label: tailscaleInstalled ? 'Connect' : 'Set up' }
        }
      />
    </div>
  );
}

function Row({
  icon,
  label,
  connected,
  connectedText,
  pendingText = 'Not connected',
  action,
}: {
  icon: React.ReactNode;
  label: string;
  connected: boolean;
  connectedText: string;
  pendingText?: string;
  action?: { to: string; label: string };
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/60 transition-colors">
      <span className={`shrink-0 ${connected ? 'text-emerald-500 dark:text-emerald-400' : 'text-muted-foreground'}`}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground leading-none">{label}</p>
        <p className={`text-[10.5px] mt-0.5 flex items-center gap-1 ${connected ? 'text-emerald-500 dark:text-emerald-400' : 'text-muted-foreground'}`}>
          {connected && <Check size={10} strokeWidth={3} />}
          {connected ? connectedText : pendingText}
        </p>
      </div>
      {action && (
        <Link
          to={action.to}
          className="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded border border-border text-foreground hover:border-accent/50 hover:bg-card transition-colors"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
