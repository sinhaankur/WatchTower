import { useEffect, useState } from 'react';
import {
  useAgentConfig,
  useUpdateAgentConfig,
  useTestAgentConnection,
  useHealingConfig,
  useUpdateHealingConfig,
  useHealingActions,
  useResolveHealingAction,
  type HealingAction,
} from '@/hooks/queries';
import { toast } from '@/lib/toast';

// Quick-connect presets for the OpenAI-compatible servers people actually
// run locally. Selecting one only pre-fills the URL — nothing is saved
// until the user clicks Save, so exploring presets is free.
const PRESETS = [
  // llama.cpp first: the lightest path (single binary, no GUI, runs tiny
  // 0.5–2B models on Pi-class hardware) — see docs/TINY_LLM_GUIDE.md.
  { id: 'llamacpp', label: 'llama.cpp', url: 'http://localhost:8080/v1', hint: 'llama-server default port — lightest option, runs tiny models on any device' },
  { id: 'lmstudio', label: 'LM Studio', url: 'http://localhost:1234/v1', hint: 'Default LM Studio local server port' },
  { id: 'ollama', label: 'Ollama', url: 'http://localhost:11434/v1', hint: 'Default Ollama port' },
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', hint: 'Requires an API key' },
  { id: 'custom', label: 'Custom', url: '', hint: 'Any OpenAI-compatible endpoint (vLLM, llamafile, OpenRouter, LiteLLM…)' },
] as const;

function extractDetail(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? fallback;
}

const KIND_LABELS: Record<string, string> = {
  port_in_use: 'Port conflict',
  registry_transient: 'Registry flake',
  missing_env_var: 'Missing env var',
  package_not_found: 'Missing package',
  build_oom: 'Build out of memory',
  runtime_oom: 'Runtime out of memory',
  permission_denied: 'Permission denied',
  disk_full: 'Disk full',
  git_auth_failed: 'Git auth failed',
  network_failure: 'Network failure',
  build_timeout: 'Build timeout',
  tls_failure: 'TLS failure',
  unknown: 'Unknown failure',
};

function InterventionRow({ action }: { action: HealingAction }) {
  const resolve = useResolveHealingAction();
  const [busyVerb, setBusyVerb] = useState<'approve' | 'dismiss' | null>(null);

  const act = async (verb: 'approve' | 'dismiss') => {
    setBusyVerb(verb);
    try {
      await resolve.mutateAsync({ id: action.id, verb });
      toast.success(
        verb === 'approve'
          ? action.auto_applicable ? 'Fix applied — retry deployment queued' : 'Retry deployment queued'
          : 'Dismissed',
      );
    } catch (err) {
      toast.error(extractDetail(err, `Could not ${verb} this fix`));
    } finally {
      setBusyVerb(null);
    }
  };

  return (
    <li className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide font-semibold text-amber-800 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5">
          {KIND_LABELS[action.failure_kind] ?? action.failure_kind}
        </span>
        {action.project_name && (
          <span className="text-xs font-medium text-slate-800">{action.project_name}</span>
        )}
        {action.created_at && (
          <span className="text-[10px] text-slate-400 ml-auto">
            {new Date(action.created_at).toLocaleString()}
          </span>
        )}
      </div>
      {action.cause && <p className="text-xs text-slate-700">{action.cause}</p>}
      {action.fix_description && (
        <p className="text-[11px] text-slate-500">
          <span className="font-semibold text-slate-600">Suggested fix: </span>
          {action.fix_description}
        </p>
      )}
      {action.llm_analysis && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-purple-700 hover:text-purple-900 font-medium">
            AI analysis
          </summary>
          <p className="mt-1 whitespace-pre-wrap text-slate-700 bg-purple-50 border border-purple-100 rounded p-2">
            {action.llm_analysis}
          </p>
        </details>
      )}
      {action.error && (
        <p className="text-[11px] text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1">{action.error}</p>
      )}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => void act('approve')}
          disabled={busyVerb !== null}
          className="text-xs px-3 py-1 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50"
        >
          {busyVerb === 'approve'
            ? 'Working…'
            : action.auto_applicable ? 'Apply fix & retry' : 'I fixed it — retry'}
        </button>
        <button
          onClick={() => void act('dismiss')}
          disabled={busyVerb !== null}
          className="text-xs px-3 py-1 rounded-lg border border-slate-300 text-slate-600 hover:text-slate-900 hover:border-slate-400 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}

export default function AIAutonomyCard() {
  const { data: config, isLoading: configLoading } = useAgentConfig();
  const { data: healing } = useHealingConfig();
  const { data: pendingActions } = useHealingActions('pending');
  const updateConfig = useUpdateAgentConfig();
  const updateHealing = useUpdateHealingConfig();
  const testConnection = useTestAgentConnection();

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [tinyEnabled, setTinyEnabled] = useState(false);
  const [tinyModel, setTinyModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  // Seed the form from the saved config once it arrives — but never
  // clobber in-progress edits.
  useEffect(() => {
    if (config && !dirty) {
      setBaseUrl(config.base_url ?? '');
      setModel(config.model ?? '');
      setTinyEnabled(Boolean(config.has_dedicated_analysis_model));
      setTinyModel(config.has_dedicated_analysis_model ? config.analysis_model : '');
    }
  }, [config, dirty]);

  const activePreset = PRESETS.find((p) => p.id !== 'custom' && p.url === baseUrl)?.id ?? 'custom';

  const handleTest = async () => {
    setTestResult(null);
    setModels([]);
    try {
      const result = await testConnection.mutateAsync({
        base_url: baseUrl || undefined,
        api_key: apiKey || undefined,
      });
      if (result.ok) {
        setModels(result.models);
        // Auto-pick the first model so "Test → Save" is a two-click flow
        // when the current model isn't served by this endpoint.
        if (result.models.length > 0 && !result.models.includes(model)) {
          setModel(result.models[0]);
          setDirty(true);
        }
        setTestResult({
          ok: true,
          msg: result.models.length > 0
            ? `Connected — ${result.models.length} model${result.models.length === 1 ? '' : 's'} available`
            : 'Connected, but the server reported no models. Load one in your LLM app first.',
        });
      } else {
        setTestResult({ ok: false, msg: result.error ?? 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ ok: false, msg: extractDetail(err, 'Connection test failed') });
    }
  };

  const handleSave = async () => {
    if (tinyEnabled && !tinyModel.trim()) {
      toast.error('Pick a tiny model for self-heal analysis, or uncheck the option.');
      return;
    }
    try {
      await updateConfig.mutateAsync({
        base_url: baseUrl,
        // Only send the key when the user typed one — an empty field
        // means "keep what's stored", not "delete the key".
        ...(apiKey ? { api_key: apiKey } : {}),
        model,
        // Toggle off (or blank) clears the dedicated tiny model so
        // self-heal falls back to the main model.
        analysis_model: tinyEnabled ? tinyModel : '',
      });
      setDirty(false);
      setApiKey('');
      toast.success('LLM connection saved');
    } catch (err) {
      toast.error(extractDetail(err, 'Could not save LLM settings'));
    }
  };

  const autonomous = healing?.autonomous_enabled ?? false;
  const pending = pendingActions ?? [];

  return (
    <div className="rounded-xl border border-slate-800 bg-card p-5 shadow-[2px_2px_0_0_#1f2937]">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg border border-slate-800 bg-purple-600 flex items-center justify-center shadow-[1px_1px_0_0_#1f2937]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a4 4 0 0 1 4 4c0 1.1-.45 2.1-1.17 2.83L12 12l-2.83-3.17A4 4 0 0 1 12 2z" />
            <circle cx="12" cy="17" r="5" />
            <path d="M12 14.5v2.5l1.5 1.5" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">AI & Autonomy</h2>
          <p className="text-xs text-slate-500">
            Connect a local or cloud LLM, and choose how much WatchTower fixes on its own.
          </p>
        </div>
        {pending.length > 0 && (
          <span className="text-[10px] font-semibold text-amber-900 bg-amber-200 border border-amber-300 rounded-full px-2 py-0.5">
            {pending.length} need{pending.length === 1 ? 's' : ''} attention
          </span>
        )}
      </div>

      {/* ── LLM connection ── */}
      <div className="space-y-3">
        <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">LLM connection</p>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              title={p.hint}
              onClick={() => {
                if (p.url) setBaseUrl(p.url);
                setDirty(true);
                setTestResult(null);
                setModels([]);
              }}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                activePreset === p.id
                  ? 'border-slate-800 bg-slate-900 text-white'
                  : 'border-slate-300 text-slate-600 hover:border-slate-500 hover:text-slate-900'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] text-slate-600">Server URL</span>
            <input
              type="text"
              value={baseUrl}
              placeholder="http://localhost:1234/v1"
              onChange={(e) => { setBaseUrl(e.target.value); setDirty(true); setTestResult(null); }}
              className="mt-1 w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:border-slate-700"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-600">
              API key {config?.has_api_key ? '(saved — leave blank to keep)' : '(optional for local servers)'}
            </span>
            <input
              type="password"
              value={apiKey}
              placeholder={config?.has_api_key ? '••••••••' : 'not needed for LM Studio / Ollama'}
              onChange={(e) => { setApiKey(e.target.value); setDirty(true); setTestResult(null); }}
              className="mt-1 w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:border-slate-700"
            />
          </label>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 items-end">
          <label className="block">
            <span className="text-[11px] text-slate-600">Model</span>
            {models.length > 0 ? (
              <select
                value={model}
                onChange={(e) => { setModel(e.target.value); setDirty(true); }}
                className="mt-1 w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 bg-white focus:outline-none focus:border-slate-700"
              >
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                type="text"
                value={model}
                placeholder="qwen2.5-coder-7b"
                onChange={(e) => { setModel(e.target.value); setDirty(true); }}
                className="mt-1 w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:border-slate-700"
              />
            )}
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void handleTest()}
              disabled={testConnection.isPending || (!baseUrl && !config?.configured)}
              className="text-xs px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:border-slate-500 hover:text-slate-900 disabled:opacity-50"
            >
              {testConnection.isPending ? 'Testing…' : 'Test connection'}
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={updateConfig.isPending || !dirty}
              className="text-xs px-4 py-2 rounded-lg border border-slate-800 bg-amber-400 hover:bg-amber-500 text-slate-900 font-semibold shadow-[1px_1px_0_0_#1f2937] disabled:opacity-50"
            >
              {updateConfig.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {testResult && (
          <p className={`text-xs rounded px-3 py-2 border ${
            testResult.ok
              ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
              : 'text-red-700 bg-red-50 border-red-200'
          }`}>
            {testResult.msg}
          </p>
        )}

        {!configLoading && !config?.configured && !testResult && (
          <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded px-3 py-2">
            No LLM connected yet. Any OpenAI-compatible server works — on small devices,
            llama.cpp with a tiny model is plenty (e.g.{' '}
            <code className="font-mono bg-slate-100 px-1 rounded">llama-server -hf Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M --port 8080</code>),
            or use LM Studio / Ollama if you already run them. Pick a preset above, then Test → Save.
            WatchTower uses the model to analyze deployment failures the pattern library can't classify.
          </p>
        )}
        {config?.source === 'env' && (
          <p className="text-[11px] text-slate-400">
            Currently configured via environment variables — saving here overrides them.
          </p>
        )}

        {/* Tiny-model switch: autonomous self-heal only needs a 0.5–2B
            model (single completion, no tools), so it can run on a
            lighter model than chat — or be the ONLY model on small
            devices. */}
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={tinyEnabled}
              onChange={(e) => { setTinyEnabled(e.target.checked); setDirty(true); }}
              className="mt-0.5 accent-amber-500"
            />
            <span className="text-xs text-slate-700">
              <span className="font-semibold">Use a tiny model for autonomous self-heal</span>
              <span className="block text-[11px] text-slate-500 mt-0.5">
                Background failure analysis only needs a small model (0.5–2B) — keep it fast and light
                while chat uses {model || 'the main model'}. See the{' '}
                <a href="https://github.com/sinhaankur/WatchTower/blob/main/docs/TINY_LLM_GUIDE.md"
                   target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-700">
                  Tiny LLM guide
                </a>.
              </span>
            </span>
          </label>
          {tinyEnabled && (
            models.length > 0 ? (
              <select
                value={tinyModel}
                onChange={(e) => { setTinyModel(e.target.value); setDirty(true); }}
                className="w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 bg-white focus:outline-none focus:border-slate-700"
              >
                <option value="">— pick a model —</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input
                type="text"
                value={tinyModel}
                placeholder="smollm2-360m-instruct"
                onChange={(e) => { setTinyModel(e.target.value); setDirty(true); }}
                className="w-full text-xs font-mono rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:border-slate-700"
              />
            )
          )}
        </div>
      </div>

      {/* ── Autonomy switch ── */}
      <div className="mt-5 pt-4 border-t border-slate-200">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide">Autonomous self-heal</p>
            <p className="text-xs text-slate-500 mt-1 max-w-md">
              {autonomous
                ? 'On — WatchTower fixes safe failures by itself (port conflicts, registry flakes) and retries the deployment. Anything needing judgment still waits for you below. After 3 auto-fixes in 10 minutes it stops and asks a human.'
                : 'Off — WatchTower diagnoses every failed deployment but never acts alone. Each suggested fix waits for your approval below.'}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={autonomous}
            disabled={updateHealing.isPending}
            onClick={() => {
              updateHealing.mutate(!autonomous, {
                onSuccess: (r) => toast.success(r.autonomous_enabled ? 'Autonomous self-heal enabled' : 'Autonomous self-heal disabled — fixes now wait for approval'),
                onError: (err) => toast.error(extractDetail(err, 'Could not update autonomy setting')),
              });
            }}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-slate-800 transition-colors disabled:opacity-50 ${
              autonomous ? 'bg-emerald-500' : 'bg-slate-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white border border-slate-800 transition-transform ${
                autonomous ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* ── Intervention queue ── */}
      <div className="mt-5 pt-4 border-t border-slate-200">
        <p className="text-xs font-semibold text-slate-800 uppercase tracking-wide mb-2">
          Needs your attention
        </p>
        {pending.length === 0 ? (
          <p className="text-xs text-slate-500">
            Nothing waiting. Failed deployments show up here with a diagnosis
            {healing?.llm_configured ? ' (and an AI analysis when patterns don’t match)' : ''} and one-click actions.
          </p>
        ) : (
          <ul className="space-y-2">
            {pending.map((a) => <InterventionRow key={a.id} action={a} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
