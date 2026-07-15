// Harness: extract the two-stage-updater sections VERBATIM from main.js and
// exercise them against fixture dirs + the REAL signed payload artifacts.
// Validates the shipped algorithm, not a re-implementation.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const mainPath = process.argv[2];
const repoRoot = path.resolve(path.dirname(mainPath), '..');
const mainSrc = fs.readFileSync(mainPath, 'utf8');
const start = mainSrc.indexOf('// ── Two-stage updater: payload boot selection');
const end = mainSrc.indexOf('// Probe a container runtime CLI');
if (start < 0 || end < 0 || end <= start) throw new Error('could not locate payload sections in main.js');
const section = mainSrc.slice(start, end);
const cvStart = mainSrc.indexOf('function compareVersions');
const cvEnd = mainSrc.indexOf('\n}', cvStart) + 2;
const compareVersionsSrc = mainSrc.slice(cvStart, cvEnd);

// Real signed artifacts from phase 1
const realTarball = path.join(repoRoot, 'payload-dist', 'watchtower-payload-1.20.2.tar.gz');
const realManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'payload-dist', 'payload-manifest.json'), 'utf8'));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-payload-test-'));
const resources = path.join(fixture, 'resources');
const dataDir = path.join(fixture, 'data');
const payloads = path.join(dataDir, 'payloads');
fs.mkdirSync(path.join(resources, 'python'), { recursive: true });

function writeFingerprint(sha) {
  fs.writeFileSync(path.join(resources, 'python', 'runtime-fingerprint.json'),
    JSON.stringify({ shellVersion: '1.20.1', pythonVersion: '3.12.13', requirementsSha256: sha }));
}

function mkPayload(version, meta, opts = {}) {
  const dir = path.join(payloads, version);
  fs.mkdirSync(path.join(dir, 'watchtower'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web-dist'), { recursive: true });
  if (!opts.noInit) fs.writeFileSync(path.join(dir, 'watchtower', '__init__.py'), `__version__ = "${version}"\n`);
  if (!opts.noIndex) fs.writeFileSync(path.join(dir, 'web-dist', 'index.html'), '<html></html>');
  if (meta !== null) fs.writeFileSync(path.join(dir, 'payload.json'), JSON.stringify(meta));
  if (opts.quarantined) fs.writeFileSync(path.join(dir, '.quarantined'), '{"reason":"test"}');
  return dir;
}

// downloadFile stub: "url" is a local path in our tests.
const urlMap = {};
function buildContext({ isPackaged = true, builtinVersion = '1.20.1' } = {}) {
  const sandboxProcess = { resourcesPath: resources, env: {} };
  const ctx = {
    require, console, fs, path, os, crypto, execFileSync, Buffer,
    https: {},
    process: sandboxProcess,
    app: { isPackaged, getVersion: () => builtinVersion, quit: () => {} },
    writableDataDir: () => dataDir,
    lastBackendLogPath: null,
    dialog: {}, shell: {},
    Notification: { isSupported: () => false },
    relaunchAppCleanEnv: () => {},
    appendDiagnostic: () => {},
    downloadFile: async (url, dest) => { fs.copyFileSync(urlMap[url] || url, dest); return dest; },
    activePayloadVersion: null,
  };
  vm.createContext(ctx);
  vm.runInContext(compareVersionsSrc + '\n' + section, ctx);
  return ctx;
}

let failures = 0;
function expect(label, actual, want) {
  const a = JSON.stringify(actual), w = JSON.stringify(want);
  if (a === w) { console.log(`  PASS ${label}`); }
  else { console.log(`  FAIL ${label}: got ${a}, want ${w}`); failures++; }
}

(async () => {
  // ═══ Phase 2: selection ═══
  writeFingerprint('AAA');
  mkPayload('1.21.0', { version: '1.21.0', minShellVersion: '1.20.0', requirementsSha256: 'AAA' });
  mkPayload('1.24.0', { version: '1.24.0', minShellVersion: '1.20.0', requirementsSha256: 'AAA' });
  mkPayload('1.22.0', { version: '1.22.0', minShellVersion: '1.20.0', requirementsSha256: 'BBB' });
  mkPayload('1.23.0', { version: '1.23.0', minShellVersion: '9.0.0', requirementsSha256: 'AAA' });
  mkPayload('1.19.0', { version: '1.19.0', minShellVersion: '1.0.0', requirementsSha256: 'AAA' });
  mkPayload('1.21.5', { version: '1.21.5', minShellVersion: '1.20.0', requirementsSha256: 'AAA' }, { quarantined: true });
  mkPayload('1.21.7', { version: '1.21.7', minShellVersion: '1.20.0', requirementsSha256: 'AAA' }, { noIndex: true });
  mkPayload('1.21.8', null);

  let ctx = buildContext({ builtinVersion: '1.20.2' });
  expect('selection order + filtering', ctx.selectPayloadCandidates().map(c => c.version), ['1.24.0', '1.21.0']);

  ctx = buildContext({ builtinVersion: '1.20.2' });
  ctx.process.env.WATCHTOWER_DISABLE_PAYLOADS = '1';
  expect('kill switch', ctx.selectPayloadCandidates(), []);

  ctx = buildContext({ isPackaged: false, builtinVersion: '1.20.2' });
  expect('dev clone ignored', ctx.selectPayloadCandidates(), []);

  ctx = buildContext({ builtinVersion: '1.20.2' });
  ctx.recordHealthyPayload('1.24.0');
  expect('forward-only floor', ctx.selectPayloadCandidates().map(c => c.version), ['1.24.0']);
  ctx.recordHealthyPayload('1.21.0');
  expect('floor does not regress',
    JSON.parse(fs.readFileSync(path.join(payloads, 'state.json'))).lastHealthyVersion, '1.24.0');

  // ═══ Phase 3: GC ═══
  // Active = 1.24.0. Keep: active, one older rollback (1.23.0 is next-newest
  // older dir), and pending newer (none newer here). Everything older goes.
  ctx = buildContext({ builtinVersion: '1.20.2' });
  ctx.gcPayloads('1.24.0');
  const left = fs.readdirSync(payloads).filter(n => /^\d/.test(n)).sort();
  expect('gc keeps active + one rollback target', left, ['1.23.0', '1.24.0']);

  // GC never deletes a pending newer download.
  mkPayload('1.25.0', { version: '1.25.0', minShellVersion: '1.20.0', requirementsSha256: 'AAA' });
  ctx.gcPayloads('1.24.0');
  expect('gc keeps pending newer payload',
    fs.readdirSync(payloads).filter(n => /^\d/.test(n)).sort(), ['1.23.0', '1.24.0', '1.25.0']);

  // ═══ Phase 3: install + verify with the REAL signed payload ═══
  fs.rmSync(payloads, { recursive: true, force: true });
  writeFingerprint(realManifest.requirementsSha256);

  // Happy path: sha256 + Ed25519 verify against the pinned key in main.js.
  ctx = buildContext({ builtinVersion: '1.20.1' });
  await ctx.installPayload(realTarball, realManifest);
  expect('installPayload stages verified payload',
    fs.existsSync(path.join(payloads, '1.20.2', 'payload.json')), true);
  expect('installPayload cleans tmp dir',
    fs.readdirSync(payloads).filter(n => n.startsWith('.tmp')), []);

  // Tampered tarball → sha256 rejects.
  const tampered = path.join(fixture, 'tampered.tar.gz');
  fs.copyFileSync(realTarball, tampered);
  fs.appendFileSync(tampered, 'X');
  fs.rmSync(path.join(payloads, '1.20.2'), { recursive: true, force: true });
  let threw = '';
  try { await ctx.installPayload(tampered, realManifest); } catch (e) { threw = e.message; }
  expect('tampered tarball rejected by sha256', /sha256 mismatch/.test(threw), true);

  // Correct sha but wrong signature → Ed25519 rejects.
  const tamperedSha = crypto.createHash('sha256').update(fs.readFileSync(tampered)).digest('hex');
  threw = '';
  try { await ctx.installPayload(tampered, { ...realManifest, sha256: tamperedSha }); } catch (e) { threw = e.message; }
  expect('bad signature rejected by pinned key', /signature does not verify/.test(threw), true);
  expect('failed install leaves nothing staged', fs.existsSync(path.join(payloads, '1.20.2')), false);

  // ═══ Phase 3: tryPayloadUpdate decision matrix (stubbed GitHub API) ═══
  // The real manifest demands minShellVersion 1.21.0 — the shell-too-old
  // gate must route a 1.20.1 shell to the installer path.
  const manifestFile = path.join(fixture, 'payload-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(realManifest));
  urlMap['https://x/manifest'] = manifestFile;
  urlMap['https://x/tarball'] = realTarball;
  const releaseStrict = {
    tag_name: 'v1.20.2',
    assets: [
      { name: 'payload-manifest.json', browser_download_url: 'https://x/manifest' },
      { name: 'watchtower-payload-1.20.2.tar.gz', browser_download_url: 'https://x/tarball' },
    ],
  };
  ctx = buildContext({ builtinVersion: '1.20.1' });
  ctx.githubLatestReleaseJson = async () => releaseStrict;
  let rStrict = await ctx.tryPayloadUpdate();
  expect('shell older than minShellVersion → incompatible', rStrict.status, 'incompatible');

  // Same release with a satisfiable minShellVersion exercises the full
  // download→verify→stage path (signature covers the tarball, not the
  // manifest's minShell field, so this edit is legitimate for testing).
  fs.writeFileSync(manifestFile, JSON.stringify({ ...realManifest, minShellVersion: '1.20.0' }));
  urlMap['https://x/manifest'] = manifestFile;
  urlMap['https://x/tarball'] = realTarball;
  const release = {
    tag_name: 'v1.20.2',
    assets: [
      { name: 'payload-manifest.json', browser_download_url: 'https://x/manifest' },
      { name: 'watchtower-payload-1.20.2.tar.gz', browser_download_url: 'https://x/tarball' },
    ],
  };

  ctx = buildContext({ builtinVersion: '1.20.1' });
  ctx.githubLatestReleaseJson = async () => release;
  let r = await ctx.tryPayloadUpdate();
  expect('tryPayloadUpdate downloads + installs', r.status, 'installed');
  r = await ctx.tryPayloadUpdate();
  expect('second check → already-installed', r.status, 'already-installed');

  fs.writeFileSync(path.join(payloads, '1.20.2', '.quarantined'), '{"reason":"test"}');
  r = await ctx.tryPayloadUpdate();
  expect('quarantined release → incompatible (installer path)', r.status, 'incompatible');
  fs.rmSync(path.join(payloads, '1.20.2'), { recursive: true, force: true });

  writeFingerprint('DIFFERENT');
  ctx = buildContext({ builtinVersion: '1.20.1' });
  ctx.githubLatestReleaseJson = async () => release;
  r = await ctx.tryPayloadUpdate();
  expect('dep-set change → incompatible (installer path)', r.status, 'incompatible');

  writeFingerprint(realManifest.requirementsSha256);
  ctx = buildContext({ builtinVersion: '1.20.2' });
  ctx.githubLatestReleaseJson = async () => release;
  r = await ctx.tryPayloadUpdate();
  expect('same version → up-to-date', r.status, 'up-to-date');

  ctx = buildContext({ builtinVersion: '1.20.1' });
  ctx.githubLatestReleaseJson = async () => ({ tag_name: 'v1.20.2', assets: [] });
  r = await ctx.tryPayloadUpdate();
  expect('release without payload assets → unavailable', r.status, 'unavailable');

  ctx = buildContext({ builtinVersion: '1.20.1' });
  ctx.githubLatestReleaseJson = async () => { throw new Error('offline'); };
  r = await ctx.tryPayloadUpdate();
  expect('network failure → failed (no installer fallback)', r.status, 'failed');

  fs.rmSync(fixture, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} FAILURE(S)`); process.exit(1); }
  console.log('\nALL PASS');
})().catch((e) => { console.error(e); process.exit(1); });
