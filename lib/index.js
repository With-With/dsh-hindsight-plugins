/**
 * dsh-hindsight-plugins - host half.
 *
 * Hindsight memory manager for DeepSeek Harness. Two responsibilities:
 *
 * 1. ENSURE THE OFFICIAL ADAPTER EXISTS. On startup (when `autoInstall` is
 *    enabled) it checks whether the official DSH adapter
 *    (@vectorize-io/hindsight-coding-agents, installed via
 *    `npx @vectorize-io/hindsight-coding-agents install dsh`) is present and
 *    mounted; when it is missing, it runs that exact installer
 *    non-interactively (--server self-hosted --api-url resolved from the
 *    existing config, this plugin's sidecar, or `defaultApiUrl`). The same
 *    action is available on demand through POST /install (the UI's
 *    「一键安装官方适配器」 button).
 *
 * 2. CONFIGURE IT. The plugin never touches the adapter's runtime; it only
 *    reads and writes the shared config file `~/.hindsight/coding-agent.json`
 *    on the adapter's behalf, plus its own sidecar
 *    `~/.hindsight/dsh-route.json` (which two addresses exist and which
 *    route is active).
 *
 * HTTP surface (registered on the web server, same-origin as the GUI):
 *   GET  /plugins/dsh-hindsight-plugins/config
 *        -> { sidecar, effective, adapter, install, autoInstall, paths }
 *   POST /plugins/dsh-hindsight-plugins/config
 *        body { intranetUrl, extranetUrl, route, scope } -> save route
 *   POST /plugins/dsh-hindsight-plugins/test     body { url } -> probe
 *   POST /plugins/dsh-hindsight-plugins/install  -> ensure adapter (manual)
 *
 * Routes accept loopback host headers only - the same reachability posture
 * as the GUI itself - and the test endpoint only probes http(s) URLs.
 *
 * @module dsh-hindsight-plugins
 */
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Web-server service key candidates, newest first (same as dsh-agent-teams). */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];

const HINDSIGHT_DIR = process.env.HINDSIGHT_CONFIG_DIR || join(homedir(), '.hindsight');
/** The official adapter's shared config file (single source of truth). */
const CODING_AGENT_JSON = process.env.HINDSIGHT_CONFIG || join(HINDSIGHT_DIR, 'coding-agent.json');
/** This plugin's sidecar: which two addresses exist and which route is active. */
const ROUTE_JSON = join(HINDSIGHT_DIR, 'dsh-route.json');
/** Installed adapter runtime version, shown in the UI. */
const RUNTIME_PACKAGE_JSON = join(HINDSIGHT_DIR, 'coding-agents', 'package.json');
/** The official adapter's dsh entry point - present once `install dsh` ran. */
const RUNTIME_DSH_JS = join(HINDSIGHT_DIR, 'coding-agents', 'dist', 'dsh.js');
/** dsh home: user patch layers scanned for a mounted adapter row. */
const DSH_HOME = join(homedir(), '.dsh');
/** The home-level user patch the official installer rewrites. */
const HOME_PATCH = join(DSH_HOME, 'cordis.patch.yml');

/** The official installer this plugin auto-runs when the adapter is absent. */
const INSTALLER_PACKAGE = '@vectorize-io/hindsight-coding-agents';

export const name = 'hindsight-plugins';
export const inject = [];

/**
 * Plugin row config (normalized by hand - this package deliberately has NO
 * runtime dependencies beyond Node builtins, so it installs under every
 * layout: junction, plain copy, pnpm, or the plugin marketplace clone):
 *   autoInstall   boolean, default true - check & auto-install the adapter
 *   defaultApiUrl string,  default ''   - fallback URL for the auto-install
 */

// ---------------------------------------------------------------- helpers

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${Date.now()}-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

async function fileReadable(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/** Official adapter loader-entry id, identical in every patch layer. */
const ADAPTER_ENTRY_ID = 'hindsight';
/** The official package's own bundle patch (mounted via dsh.profile.bundles). */
const RUNTIME_BUNDLE_PATCH = join(HINDSIGHT_DIR, 'coding-agents', 'cordis.patch.yml');
/**
 * Canonical single registration: the adapter mounted as a profile bundle,
 * imported by package name (the package ships a "./dsh" subpath export).
 */
const CANONICAL_BUNDLE_PATCH = [
  '# Official hindsight adapter, mounted as a profile bundle.',
  '# Keep exactly ONE registration of id "hindsight" across all patch layers -',
  '# duplicates break `dsh web` startup (duplicate loader entry id).',
  '- insert:',
  '    - id: hindsight',
  '      name: "@vectorize-io/hindsight-coding-agents/dsh"',
  '',
].join('\n');

/**
 * Count `- id: hindsight` entries in one patch document. Line-based on
 * purpose: this package has a strict zero-dependency constraint (junction
 * installs cannot resolve npm modules), and dsh patch rows are exactly
 * `- insert:` -> `    - id: <name>` lists, so a row-level scan is reliable
 * without a full YAML parser.
 */
function countAdapterEntries(text) {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+id:\s*['"]?([^'"\s#]+)/);
    if (m && m[1] === ADAPTER_ENTRY_ID) count += 1;
  }
  return count;
}

/** Whether any profile registers the adapter package as a bundle. */
async function bundleRegistered() {
  try {
    for (const entry of await readdir(join(DSH_HOME, 'profiles'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = await readJson(join(DSH_HOME, 'profiles', entry.name, 'package.json'), null);
      const bundles = pkg?.dsh?.profile?.bundles;
      if (Array.isArray(bundles) && bundles.includes('@vectorize-io/hindsight-coding-agents')) return true;
    }
  } catch {
    // no profiles dir
  }
  return false;
}

/**
 * Precise adapter registration audit across every patch layer:
 * home patch, each profile patch, and the package's own bundle patch
 * (counted only when a profile actually lists it as a bundle).
 *   entryCount === 0 -> missing (auto-install may act)
 *   entryCount === 1 -> healthy
 *   entryCount >= 2  -> duplicated (breaks dsh web boot; needs convergence)
 */
async function adapterStatus() {
  const runtimePresent = await fileReadable(RUNTIME_DSH_JS);
  const files = [HOME_PATCH];
  try {
    for (const entry of await readdir(join(DSH_HOME, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(join(DSH_HOME, 'profiles', entry.name, 'cordis.patch.yml'));
    }
  } catch {
    // no profiles dir - home patch above is still checked
  }
  if (runtimePresent && await bundleRegistered()) files.push(RUNTIME_BUNDLE_PATCH);
  let entryCount = 0;
  const layers = [];
  for (const file of files) {
    try {
      const count = countAdapterEntries(await readFile(file, 'utf8'));
      entryCount += count;
      if (count > 0) layers.push({ file, count });
    } catch {
      // absent patch layer - skip
    }
  }
  return {
    runtimePresent,
    entryCount,
    layers,
    mounted: entryCount === 1,
    duplicated: entryCount > 1,
  };
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

async function probe(url) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
      return { ok: true, ms: Date.now() - started, status: response.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const reason = error?.cause?.code || error?.cause?.message || error?.message || String(error);
    return { ok: false, ms: Date.now() - started, error: String(reason) };
  }
}

/**
 * Hindsight server version (GET <apiUrl>/version, the same endpoint the
 * official client itself uses for feature negotiation). Cached 5 minutes;
 * never blocks a request - callers read the cached value only.
 */
let serverVersionCache = { value: null, at: 0, inflight: null };

async function fetchServerVersion(apiUrl) {
  const url = normalizeUrl(apiUrl);
  if (!isValidHttpUrl(url)) return null;
  if (serverVersionCache.value !== null && Date.now() - serverVersionCache.at < 5 * 60 * 1000) {
    return serverVersionCache.value;
  }
  if (serverVersionCache.inflight) return serverVersionCache.inflight;
  serverVersionCache.inflight = (async () => {
    let value = serverVersionCache.value;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${url.replace(/\/+$/, '')}/version`, { signal: controller.signal });
        if (response.ok) {
          const json = await response.json();
          if (typeof json?.api_version === 'string') value = json.api_version;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // unreachable - keep the previous value (may be null -> UI shows 未知)
    }
    serverVersionCache = { value, at: Date.now(), inflight: null };
    return value;
  })();
  return serverVersionCache.inflight;
}

function readJsonBody(req, capBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > capBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
        resolve(text.length === 0 ? {} : JSON.parse(text));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Loopback-only Host header: the same reachability posture as the GUI fence. */
function loopbackHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return (
    host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
    || host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host.startsWith('[::1]:')
  );
}

// ---------------------------------------------------------------- plugin

export function apply(ctx, config) {
  const autoInstall = config?.autoInstall !== false;
  const defaultApiUrl = normalizeUrl(config?.defaultApiUrl);

  let registered = false;
  let disposed = false;
  ctx.effect(() => () => { disposed = true; }, 'hindsight-plugins: dispose guard');

  // ------------------------------------------------ adapter auto-install

  /** Install progress surfaced through GET /config and POST /install. */
  let installState = { phase: 'idle' };

  const noteInstall = (line) => {
    installState.log.push(String(line));
    if (installState.log.length > 200) installState.log.shift();
    ctx.logger.info('hindsight-plugins: adapter install: %s', String(line));
  };

  /** Where the auto-installed adapter should point. */
  async function resolveTargetUrl() {
    const cfg = await readJson(CODING_AGENT_JSON, null);
    if (isValidHttpUrl(cfg?.apiUrl)) return cfg.apiUrl;
    const sidecar = await readJson(ROUTE_JSON, null);
    if (isValidHttpUrl(sidecar?.intranetUrl)) return sidecar.intranetUrl;
    if (isValidHttpUrl(defaultApiUrl)) return defaultApiUrl;
    return null;
  }

  /**
   * The official installer cannot cope with its own uninstaller's empty
   * placeholder: a bare "[]" document makes it emit "[]\n\n<block>", which
   * is invalid YAML and breaks the next `dsh web` boot. Strip the
   * placeholder (only when the file holds nothing else) before spawning.
   */
  async function sanitizeHomePatch() {
    try {
      const raw = await readFile(HOME_PATCH, 'utf8');
      const withoutComments = raw.replace(/#[^\n]*/g, '');
      if (withoutComments.replace(/\s+/g, '') === '[]') {
        await writeFile(HOME_PATCH, '', 'utf8');
        ctx.logger.warn('hindsight-plugins: stripped bare "[]" placeholder from %s (the official installer would emit invalid YAML)', HOME_PATCH);
      }
    } catch { /* absent file is fine */ }
  }

  /** Repair the invalid "[] + block" prefix the official installer can emit. */
  async function repairHomePatchIfBroken() {
    try {
      const raw = await readFile(HOME_PATCH, 'utf8');
      const repaired = raw.replace(/^\s*\[\][ \t]*\r?\n(?=[\s\S]*\S)/, '');
      if (repaired !== raw) {
        await writeFile(HOME_PATCH, repaired, 'utf8');
        ctx.logger.warn('hindsight-plugins: repaired invalid "[]" document prefix in %s', HOME_PATCH);
      }
    } catch { /* absent is fine */ }
  }

  /**
   * Converge duplicated adapter registrations to exactly ONE. Strategy:
   * the profile-bundle registration is authoritative (dsh's own reconcile
   * keeps re-adding it anyway, so fighting it is futile); the official
   * installer's home-patch marker block is the duplicate source and gets
   * stripped. Never invoked automatically - only from an explicit user
   * action (the「一键收敛」button or a completed manual install), because
   * autonomous rewriting by multiple parties is what caused the mess.
   */
  async function normalizeRegistrations(trigger) {
    const notes = [];
    const asBundle = await bundleRegistered();
    if (asBundle && await fileReadable(RUNTIME_DSH_JS)) {
      // 1) make the bundle patch the canonical single row
      const current = await readFile(RUNTIME_BUNDLE_PATCH, 'utf8').catch(() => '');
      if (countAdapterEntries(current) !== 1) {
        try {
          await writeFile(`${RUNTIME_BUNDLE_PATCH}.hindsight-settings-backup`, current, 'utf8');
        } catch { /* best-effort backup */ }
        await writeFile(RUNTIME_BUNDLE_PATCH, CANONICAL_BUNDLE_PATCH, 'utf8');
        notes.push('bundle 补丁已重写为规范单行注册');
      }
      // 2) strip the official installer's marker block from the home patch
      const raw = await readFile(HOME_PATCH, 'utf8').catch(() => '');
      const stripped = raw.replace(/\n?# HINDSIGHT_CODING_AGENTS_DSH_START[\s\S]*?# HINDSIGHT_CODING_AGENTS_DSH_END\n?/g, '\n');
      if (stripped !== raw) {
        try {
          await writeFile(`${HOME_PATCH}.hindsight-settings-backup`, raw, 'utf8');
        } catch { /* best-effort backup */ }
        const remainder = stripped.replace(/^\s*\n+/, '').replace(/\n+$/, '\n');
        // "[]" is the canonical empty-patch document; the pre-install
        // sanitizer strips it again before any official installer run.
        await writeFile(HOME_PATCH, /^[#\s]*$/.test(remainder) ? '[]\n' : remainder, 'utf8');
        notes.push('home 补丁中的官方标记块已移除');
      }
    } else {
      // no bundle registration - the home row is the single source; nothing safe to strip
      notes.push('未发现 bundle 注册，保留 home 行不动（避免误删唯一注册）');
    }
    ctx.logger.info('hindsight-plugins: registrations normalized [%s]: %s', trigger, notes.join('; '));
    const adapter = await adapterStatus();
    installState = {
      phase: adapter.duplicated ? 'duplicate' : 'idle',
      note: notes.length
        ? `已收敛（${notes.join('；')}）。当前注册数：${adapter.entryCount}`
        : `无需处理，当前注册数：${adapter.entryCount}`,
      adapter,
    };
    return installState;
  }

  /**
   * Ensure the official adapter is installed. Non-interactive: the server
   * choice is always self-hosted with the resolved URL, because a spawned
   * installer cannot answer a terminal prompt. Idempotent: an installed
   * adapter short-circuits with `phase: 'idle'`. Duplicates are REPORTED,
   * never auto-cleaned (the「一键收敛」button triggers that explicitly).
   */
  async function ensureAdapter(trigger) {
    if (installState.phase === 'running') return installState;
    const status = await adapterStatus();
    if (status.runtimePresent && status.entryCount >= 1) {
      if (status.duplicated) {
        installState = {
          phase: 'duplicate',
          note: `检测到官方适配器重复注册（${status.entryCount} 处）- 会导致 dsh web 启动时报 duplicate loader entry id。请点「一键收敛」保留单一注册。`,
          layers: status.layers,
        };
      } else {
        installState = { phase: 'idle', note: '官方适配器已安装并挂载' };
      }
      return installState;
    }
    const url = await resolveTargetUrl();
    if (!url) {
      installState = {
        phase: 'needs-url',
        note: '未找到服务器地址：请先在「管理」中填写内网地址（或配置 defaultApiUrl），再安装官方适配器',
      };
      return installState;
    }
    installState = { phase: 'running', startedAt: new Date().toISOString(), log: [] };
    noteInstall(`[${trigger}] official adapter missing -> npx ${INSTALLER_PACKAGE} install dsh --server self-hosted --api-url ${url}`);
    await sanitizeHomePatch();
    await new Promise((resolve) => {
      const args = [
        '-y', `${INSTALLER_PACKAGE}@latest`, 'install', 'dsh',
        '--server', 'self-hosted', '--api-url', JSON.stringify(url),
      ];
      const child = spawn('npx', args, {
        shell: true,          // required for npx.cmd on Windows
        windowsHide: true,
        env: process.env,
      });
      const timeout = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        noteInstall('timeout: installer exceeded 5 minutes, killed');
      }, 5 * 60 * 1000);
      child.stdout?.on('data', (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) noteInstall(line); });
      child.stderr?.on('data', (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) noteInstall(line); });
      child.on('error', (error) => {
        clearTimeout(timeout);
        noteInstall(`spawn failed: ${String(error?.message ?? error)}`);
        installState.phase = 'failed';
        installState.finishedAt = new Date().toISOString();
        resolve();
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        noteInstall(`installer exited with code ${code}`);
        installState.phase = code === 0 ? 'done' : 'failed';
        installState.finishedAt = new Date().toISOString();
        resolve();
      });
    });
    if (disposed) return installState;
    // The installer may have emitted its invalid "[] + block" prefix -
    // repair before the file breaks the next dsh web boot.
    await repairHomePatchIfBroken();
    if (installState.phase === 'done') {
      // The installer added its own home-patch row; converge back to the
      // single bundle registration so the next boot hits no duplicate id.
      // Legitimate here: the user explicitly asked for this install.
      await normalizeRegistrations('post-install');
      return installState;
    }
    installState.adapter = await adapterStatus();
    return installState;
  }

  // Startup check: give the host a few seconds to settle first.
  if (autoInstall) {
    const timer = setTimeout(() => {
      ensureAdapter('auto').catch((error) => {
        ctx.logger.warn('hindsight-plugins: auto install failed: %s', String(error));
      });
    }, 3000);
    ctx.effect(() => () => clearTimeout(timer), 'hindsight-plugins: auto-install timer');
  }

  /** The URL the DSH adapter actually uses (harness override wins). */
  async function resolveEffectiveUrl() {
    const cfg = await readJson(CODING_AGENT_JSON, null);
    if (isValidHttpUrl(cfg?.harnesses?.dsh?.apiUrl)) return cfg.harnesses.dsh.apiUrl;
    if (isValidHttpUrl(cfg?.apiUrl)) return cfg.apiUrl;
    return null;
  }

  // Warm the server-version cache shortly after startup.
  const warmTimer = setTimeout(() => {
    resolveEffectiveUrl()
      .then((url) => { if (url) fetchServerVersion(url).catch(() => {}); })
      .catch(() => {});
  }, 3000);
  ctx.effect(() => () => clearTimeout(warmTimer), 'hindsight-plugins: version warm-up');

  // Default-off migration (v0.4.1 policy): session write-back starts
  // DISABLED - users opt INTO auto sync with the switch. If the official
  // key is absent (official default = true), write an explicit false once
  // so the effective state matches this plugin's policy. Backup first.
  const retainDefaultTimer = setTimeout(() => {
    (async () => {
      const cfg = await readJson(CODING_AGENT_JSON, null);
      if (cfg && cfg.harnesses?.dsh?.retainSessions === undefined) {
        const next = structuredClone(cfg);
        next.harnesses = { ...(next.harnesses ?? {}) };
        next.harnesses.dsh = { ...(next.harnesses.dsh ?? {}) };
        next.harnesses.dsh.retainSessions = false;
        try {
          await writeFile(`${CODING_AGENT_JSON}.hindsight-settings-backup`,
            JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        } catch { /* best-effort backup */ }
        await writeJsonAtomic(CODING_AGENT_JSON, next);
        ctx.logger.info('hindsight-plugins: session write-back defaulted to OFF (retainSessions=false)');
      }
    })().catch((error) => {
      ctx.logger.warn('hindsight-plugins: retain default migration failed: %s', String(error));
    });
  }, 2500);
  ctx.effect(() => () => clearTimeout(retainDefaultTimer), 'hindsight-plugins: retain default timer');

  // ------------------------------------------------ state + routes

  async function loadState() {
    const [sidecar, cfg, runtime, adapter] = await Promise.all([
      readJson(ROUTE_JSON, null),
      readJson(CODING_AGENT_JSON, null),
      readJson(RUNTIME_PACKAGE_JSON, null),
      adapterStatus(),
    ]);
    const apiUrl = typeof cfg?.apiUrl === 'string' ? cfg.apiUrl : '';
    const dshApiUrl =
      typeof cfg?.harnesses?.dsh?.apiUrl === 'string' ? cfg.harnesses.dsh.apiUrl : '';
    const runtimeVersion = typeof runtime?.version === 'string' ? runtime.version : null;
    // Plugin policy (v0.4.1): session write-back defaults to OFF - only an
    // explicit `retainSessions: true` (written by the switch) means ON.
    // The startup migration persists an explicit false when the key is
    // absent, so this normalization is mostly a safety net.
    const retainSessions = cfg?.harnesses?.dsh?.retainSessions === true;
    const derived = sidecar ?? {
      intranetUrl: apiUrl,
      extranetUrl: '',
      route: 'intranet',
      scope: 'dsh',   // write scope defaults to DSH-only; "global" is explicit
    };
    return {
      sidecar: derived,
      effective: {
        apiUrl,
        dshApiUrl: dshApiUrl || null,
        serverMode: typeof cfg?.serverMode === 'string' ? cfg.serverMode : null,
      },
      adapter: { ...adapter, runtimeVersion },
      serverVersion: serverVersionCache.value,
      retainSessions,
      install: installState,
      autoInstall,
      runtimeVersion,
      paths: { config: CODING_AGENT_JSON, route: ROUTE_JSON },
    };
  }

  const configRoute = async (req, res) => {
    if (!loopbackHost(req)) return send(res, 403, { error: 'forbidden host' });
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        return send(res, 200, await loadState());
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const intranetUrl = normalizeUrl(body.intranetUrl);
        const extranetUrl = normalizeUrl(body.extranetUrl);
        const route = body.route === 'extranet' ? 'extranet' : 'intranet';
        const scope = body.scope === 'global' ? 'global' : 'dsh';
        if (!isValidHttpUrl(intranetUrl)) {
          return send(res, 400, { error: '内网地址必须是合法的 http(s) URL' });
        }
        if (route === 'extranet' && !isValidHttpUrl(extranetUrl)) {
          return send(res, 400, { error: '当前路由为外网，但外网地址缺失或不合法' });
        }
        if (extranetUrl && !isValidHttpUrl(extranetUrl)) {
          return send(res, 400, { error: '外网地址必须是合法的 http(s) URL' });
        }
        const chosen = route === 'extranet' ? extranetUrl : intranetUrl;

        // 1) sidecar keeps both candidates and the active route.
        const sidecar = { intranetUrl, extranetUrl, route, scope, savedAt: new Date().toISOString() };
        await writeJsonAtomic(ROUTE_JSON, sidecar);

        // 2) patch the official config file, preserving every other field.
        const existing = (await readJson(CODING_AGENT_JSON, null)) ?? {};
        const previous = JSON.stringify(existing, null, 2) + '\n';
        const nextConfig = structuredClone(existing);
        if (scope === 'dsh') {
          nextConfig.harnesses = { ...(nextConfig.harnesses ?? {}) };
          nextConfig.harnesses.dsh = { ...(nextConfig.harnesses.dsh ?? {}), apiUrl: chosen };
        } else {
          nextConfig.apiUrl = chosen;
          if (nextConfig.harnesses?.dsh?.apiUrl !== undefined) {
            nextConfig.harnesses = { ...nextConfig.harnesses };
            nextConfig.harnesses.dsh = { ...nextConfig.harnesses.dsh };
            delete nextConfig.harnesses.dsh.apiUrl;
            if (Object.keys(nextConfig.harnesses.dsh).length === 0) delete nextConfig.harnesses.dsh;
            if (Object.keys(nextConfig.harnesses).length === 0) delete nextConfig.harnesses;
          }
        }
        const next = JSON.stringify(nextConfig, null, 2) + '\n';
        if (next !== previous) {
          try {
            await writeFile(`${CODING_AGENT_JSON}.hindsight-settings-backup`, previous, 'utf8');
          } catch (error) {
            ctx.logger.warn('hindsight-plugins: backup write failed: %s', String(error));
          }
          await writeJsonAtomic(CODING_AGENT_JSON, nextConfig);
          ctx.logger.info('hindsight-plugins: route saved (%s -> %s, scope=%s)', route, chosen, scope);
        }
        // The (possibly new) server may differ - refresh its version cache.
        serverVersionCache = { value: null, at: 0, inflight: null };
        fetchServerVersion(chosen).catch(() => {});
        return send(res, 200, {
          ...(await loadState()),
          notice: '已保存。配置在会话启动时读取，对新会话生效。',
        });
      }
      return send(res, 405, { error: 'method not allowed' });
    } catch (error) {
      ctx.logger.warn('hindsight-plugins: config route failed: %s', String(error));
      return send(res, 500, { error: String(error?.message ?? error) });
    }
  };

  const testRoute = async (req, res) => {
    if (!loopbackHost(req)) return send(res, 403, { error: 'forbidden host' });
    try {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const body = await readJsonBody(req);
      const url = normalizeUrl(body.url);
      if (!isValidHttpUrl(url)) return send(res, 400, { error: 'invalid url' });
      return send(res, 200, await probe(url));
    } catch (error) {
      return send(res, 500, { error: String(error?.message ?? error) });
    }
  };

  const installRoute = async (req, res) => {
    if (!loopbackHost(req)) return send(res, 403, { error: 'forbidden host' });
    try {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const state = await ensureAdapter('manual');
      return send(res, 200, { install: state, ...(await loadState()) });
    } catch (error) {
      return send(res, 500, { error: String(error?.message ?? error) });
    }
  };

  /**
   * Session write-back switch: maps 1:1 onto the official adapter field
   * harnesses.dsh.retainSessions. Plugin policy (v0.4.1): DEFAULT OFF -
   * both states are written explicitly (true / false) so the file always
   * mirrors the switch, and only an explicit true enables auto sync.
   * Read by the adapter at session start, so it applies to NEW sessions.
   */
  const retainRoute = async (req, res) => {
    if (!loopbackHost(req)) return send(res, 403, { error: 'forbidden host' });
    try {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const body = await readJsonBody(req);
      const enabled = body.enabled !== false;
      const existing = (await readJson(CODING_AGENT_JSON, null)) ?? {};
      const previous = JSON.stringify(existing, null, 2) + '\n';
      const nextConfig = structuredClone(existing);
      nextConfig.harnesses = { ...(nextConfig.harnesses ?? {}) };
      nextConfig.harnesses.dsh = { ...(nextConfig.harnesses.dsh ?? {}) };
      nextConfig.harnesses.dsh.retainSessions = enabled;
      const next = JSON.stringify(nextConfig, null, 2) + '\n';
      if (next !== previous) {
        try {
          await writeFile(`${CODING_AGENT_JSON}.hindsight-settings-backup`, previous, 'utf8');
        } catch (error) {
          ctx.logger.warn('hindsight-plugins: backup write failed: %s', String(error));
        }
        await writeJsonAtomic(CODING_AGENT_JSON, nextConfig);
        ctx.logger.info('hindsight-plugins: session write-back %s', enabled ? 'enabled' : 'disabled');
      }
      // No notice by design (v0.4.2): the switch state itself is the
      // feedback; verbose toasts were removed at the user's request.
      return send(res, 200, await loadState());
    } catch (error) {
      ctx.logger.warn('hindsight-plugins: retain route failed: %s', String(error));
      return send(res, 500, { error: String(error?.message ?? error) });
    }
  };

  /**
   * One-click convergence for duplicated adapter registrations: rewrites
   * the bundle patch to the canonical single row (when bundle-registered)
   * and strips the official installer's home-patch marker block. Backs up
   * every file it touches. Triggered ONLY from the UI button - never
   * automatically, by design.
   */
  const dedupeRoute = async (req, res) => {
    if (!loopbackHost(req)) return send(res, 403, { error: 'forbidden host' });
    try {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      await normalizeRegistrations('manual');
      return send(res, 200, { install: installState, ...(await loadState()) });
    } catch (error) {
      ctx.logger.warn('hindsight-plugins: dedupe route failed: %s', String(error));
      return send(res, 500, { error: String(error?.message ?? error) });
    }
  };

  const registerWebSurface = () => {
    if (registered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (webServer === undefined) return;
    registered = true;
    for (const [path, handler] of [
      ['/plugins/dsh-hindsight-plugins/config', configRoute],
      ['/plugins/dsh-hindsight-plugins/test', testRoute],
      ['/plugins/dsh-hindsight-plugins/install', installRoute],
      ['/plugins/dsh-hindsight-plugins/retain', retainRoute],
      ['/plugins/dsh-hindsight-plugins/dedupe', dedupeRoute],
    ]) {
      ctx.effect(() => webServer.register({ kind: 'exact', path, handler }),
        `hindsight-plugins: ${path} route`);
    }
    ctx.logger.info('hindsight-plugins: routes mounted at /plugins/dsh-hindsight-plugins/*');
  };

  registerWebSurface();
  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName)) registerWebSurface();
  });
}
