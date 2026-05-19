import { useEffect, useState } from 'react';
import apiClient from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

type RamStats = {
  total_mb: number;
  used_mb: number;
  available_mb: number;
  free_mb: number;
  buffers_mb: number;
  cached_mb: number;
  percent_used: number;
};

type SwapStats = {
  total_mb: number;
  used_mb: number;
  free_mb: number;
  percent_used: number;
};

type ProcessStats = {
  rss_mb: number;
  label: string;
};

type SystemMetrics = {
  ram: RamStats;
  swap: SwapStats;
  process: ProcessStats;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function barColor(pct: number): string {
  if (pct < 60) return 'bg-emerald-500';
  if (pct < 80) return 'bg-amber-400';
  return 'bg-red-500';
}

function barBg(pct: number): string {
  if (pct < 60) return 'bg-emerald-100';
  if (pct < 80) return 'bg-amber-100';
  return 'bg-red-100';
}

function statusLabel(pct: number): { text: string; color: string } {
  if (pct < 60) return { text: 'Healthy', color: 'text-emerald-600' };
  if (pct < 80) return { text: 'Moderate', color: 'text-amber-600' };
  return { text: 'High', color: 'text-red-600' };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function UsageBar({ pct, label }: { pct: number; label: string }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span className="font-medium">{clamped.toFixed(1)}%</span>
      </div>
      <div className={`h-3 rounded-full overflow-hidden ${barBg(clamped)}`}>
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColor(clamped)}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function SegmentedBar({ ram }: { ram: RamStats }) {
  const t = ram.total_mb || 1;
  const usedPct   = (ram.used_mb - ram.buffers_mb - ram.cached_mb) / t * 100;
  const cachePct  = ram.cached_mb / t * 100;
  const bufPct    = ram.buffers_mb / t * 100;
  const freePct   = ram.free_mb / t * 100;

  return (
    <div className="space-y-2">
      {/* stacked bar */}
      <div className="flex h-5 rounded-full overflow-hidden gap-0.5">
        <div
          title={`Used: ${fmtMb(ram.used_mb - ram.buffers_mb - ram.cached_mb)}`}
          className="bg-blue-500 transition-all duration-700"
          style={{ width: `${Math.max(0, usedPct)}%` }}
        />
        <div
          title={`Cache: ${fmtMb(ram.cached_mb)}`}
          className="bg-indigo-300 transition-all duration-700"
          style={{ width: `${Math.max(0, cachePct)}%` }}
        />
        <div
          title={`Buffers: ${fmtMb(ram.buffers_mb)}`}
          className="bg-sky-300 transition-all duration-700"
          style={{ width: `${Math.max(0, bufPct)}%` }}
        />
        <div
          title={`Free: ${fmtMb(ram.free_mb)}`}
          className="bg-slate-200 transition-all duration-700 flex-1"
          style={{ width: `${Math.max(0, freePct)}%` }}
        />
      </div>

      {/* legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-blue-500 inline-block" />
          Used · {fmtMb(Math.max(0, ram.used_mb - ram.buffers_mb - ram.cached_mb))}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-indigo-300 inline-block" />
          Cache · {fmtMb(ram.cached_mb)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-sky-300 inline-block" />
          Buffers · {fmtMb(ram.buffers_mb)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-slate-200 inline-block border border-slate-300" />
          Free · {fmtMb(ram.free_mb)}
        </span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SystemResourceMonitor() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchMetrics = async () => {
    try {
      const res = await apiClient.get<SystemMetrics>('/runtime/metrics/system');
      setMetrics(res.data);
      setLastUpdated(new Date());
      setError(null);
    } catch {
      setError('Could not load system metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchMetrics();
    const id = setInterval(() => void fetchMetrics(), 10_000);
    return () => clearInterval(id);
  }, []);

  const ram = metrics?.ram;
  const swap = metrics?.swap;
  const proc = metrics?.process;
  const status = ram ? statusLabel(ram.percent_used) : null;

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">System Memory</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            How your PC&apos;s RAM is being used right now
          </p>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <span className={`text-xs font-medium ${status.color}`}>
              {status.text}
            </span>
          )}
          <button
            onClick={() => void fetchMetrics()}
            className="text-xs text-slate-500 hover:text-slate-800 transition-colors"
            title="Refresh"
          >
            ↻ {lastUpdated ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Refresh'}
          </button>
        </div>
      </div>

      {loading && !metrics && (
        <div className="h-20 flex items-center justify-center text-sm text-slate-400">
          Loading…
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-600">
          {error} — metrics require Linux /proc access
        </div>
      )}

      {ram && (
        <>
          {/* Total / overview row */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Total RAM',  value: fmtMb(ram.total_mb),     sub: 'installed',         color: 'text-slate-700' },
              { label: 'In Use',     value: fmtMb(ram.used_mb),      sub: `${ram.percent_used}% used`, color: ram.percent_used > 80 ? 'text-red-600' : ram.percent_used > 60 ? 'text-amber-600' : 'text-emerald-600' },
              { label: 'Available',  value: fmtMb(ram.available_mb), sub: 'for new apps',      color: 'text-slate-700' },
            ].map(({ label, value, sub, color }) => (
              <div key={label} className="rounded-lg bg-muted/40 p-3 text-center">
                <p className={`text-base font-bold ${color}`}>{value}</p>
                <p className="text-xs font-medium text-slate-700 mt-0.5">{label}</p>
                <p className="text-[10px] text-slate-500">{sub}</p>
              </div>
            ))}
          </div>

          {/* Segmented visual bar */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-700">RAM breakdown</p>
            <SegmentedBar ram={ram} />
          </div>

          {/* Overall used bar */}
          <UsageBar pct={ram.percent_used} label="Overall RAM usage" />

          {/* What uses the memory — explanations */}
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-semibold text-slate-700 mb-2">What each section means</p>
            {[
              { dot: 'bg-blue-500',    title: 'Used',    desc: 'Apps and processes actively holding data in memory.' },
              { dot: 'bg-indigo-300',  title: 'Cache',   desc: 'Recently used files kept in RAM to speed up future reads. OS frees this instantly when an app needs more memory.' },
              { dot: 'bg-sky-300',     title: 'Buffers', desc: 'Temporary storage for I/O operations (disk writes, network). Freed automatically.' },
              { dot: 'bg-slate-200',   title: 'Free',    desc: 'Completely idle RAM — not used by anything yet.' },
            ].map(({ dot, title, desc }) => (
              <div key={title} className="flex gap-2.5 items-start">
                <span className={`w-2.5 h-2.5 rounded-sm ${dot} border border-black/10 shrink-0 mt-0.5`} />
                <div>
                  <span className="text-xs font-medium text-slate-800">{title}: </span>
                  <span className="text-xs text-slate-500">{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* WatchTower process memory */}
      {proc && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-100 border border-blue-200 flex items-center justify-center text-base shrink-0">
            🗼
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-blue-800">{proc.label}</p>
            <p className="text-xs text-blue-600">This app is using {fmtMb(proc.rss_mb)} of RAM</p>
          </div>
          {ram && (
            <span className="text-xs font-medium text-blue-700 shrink-0">
              {((proc.rss_mb / ram.total_mb) * 100).toFixed(1)}% of total
            </span>
          )}
        </div>
      )}

      {/* Swap */}
      {swap && swap.total_mb > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-slate-700">
              Swap · {fmtMb(swap.used_mb)} / {fmtMb(swap.total_mb)}
            </p>
            <span className="text-[10px] text-slate-500">
              Disk space used as overflow RAM
            </span>
          </div>
          <UsageBar pct={swap.percent_used} label="Swap usage" />
          {swap.percent_used > 30 && (
            <p className="text-xs text-amber-700 bg-amber-50 rounded p-2 border border-amber-200">
              High swap usage slows down your system. Consider closing unused apps or adding more RAM.
            </p>
          )}
        </div>
      )}

      <p className="text-[10px] text-slate-400 text-right">Auto-refreshes every 10 s</p>
    </div>
  );
}
