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

/** Substrings that mark an adapter row inside a dsh user patch layer. */
const ADAPTER_ROW_MARKERS = ['hindsight-coding-agents', 'dist/dsh.js', 'HINDSIGHT_CODING_AGENTS'];

/**
 * Whether the official adapter is usable: its runtime staged AND a plugin
 * row still present in a dsh user patch layer (home level or any profile).
 */
async function adapterStatus() {
  const runtimePresent = await fileReadable(RUNTIME_DSH_JS);
  const patches = [join(DSH_HOME, 'cordis.patch.yml')];
  try {
    for (const entry of await readdir(join(DSH_HOME, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) patches.push(join(DSH_HOME, 'profiles', entry.name, 'cordis.patch.yml'));
    }
  } catch {
    // no profiles dir - home patch above is still checked
  }
  let mounted = false;
  for (const patch of patches) {
    try {
      const text = await readFile(patch, 'utf8');
      if (ADAPTER_ROW_MARKERS.some((marker) => text.includes(marker))) {
        mounted = true;
        break;
      }
    } catch {
      // absent patch layer - skip
    }
  }
  return { runtimePresent, mounted };
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
   * Ensure the official adapter is installed. Non-interactive: the server
   * choice is always self-hosted with the resolved URL, because a spawned
   * installer cannot answer a terminal prompt. Idempotent: an installed
   * adapter short-circuits with `phase: 'idle'`.
   */
  async function ensureAdapter(trigger) {
    if (installState.phase === 'running') return installState;
    const status = await adapterStatus();
    if (status.runtimePresent && status.mounted) {
      installState = { phase: 'idle', note: '官方适配器已安装并挂载' };
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
    // The installer wrote its own patch row; re-read the fresh status.
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
    // Official adapter field: harnesses.dsh.retainSessions (absent = true).
    const retainSessions = cfg?.harnesses?.dsh?.retainSessions !== false;
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
   * harnesses.dsh.retainSessions. Enabled -> the key is REMOVED (default
   * true, keeps the file minimal); disabled -> explicit false. Read by the
   * adapter at session start, so the switch applies to NEW sessions.
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
      if (enabled) {
        delete nextConfig.harnesses.dsh.retainSessions;
        if (Object.keys(nextConfig.harnesses.dsh).length === 0) delete nextConfig.harnesses.dsh;
        if (Object.keys(nextConfig.harnesses).length === 0) delete nextConfig.harnesses;
      } else {
        nextConfig.harnesses.dsh.retainSessions = false;
      }
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
      return send(res, 200, {
        ...(await loadState()),
        notice: enabled
          ? '已开启主动同步：新会话的对话将自动记录到 Hindsight。'
          : '已切换为不主动同步：不再自动写入会话记录；对话中明确要求记住的内容仍会正常入库（对新会话生效）。',
      });
    } catch (error) {
      ctx.logger.warn('hindsight-plugins: retain route failed: %s', String(error));
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
