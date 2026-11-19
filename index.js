/**
 * dsh-hindsight-keys — host half.
 *
 * Owns the multi-LLM key pool of the local Hindsight daemon:
 *   - reads/writes C:\Users\<u>\.hindsight\hindsight-keys.json (pool of record)
 *   - regenerates the managed block inside profiles\<profile>.env
 *   - restarts the hindsight daemon after a change
 *   - probes every key through the local 8787 bridge and reports health
 *   - serves a self-contained control panel at /api/hindsight-keys/panel
 *
 * Every key in the pool is an OpenCode Go key used with deepseek-v4.1-flash
 * through http://127.0.0.1:8787/v1 (the local bridge injects the session id).
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'hindsight-keys'
export const inject = []

const HERE = dirname(fileURLToPath(import.meta.url))

// Optional per-install overrides (written by install.ps1 with -HindsightProfile,
// -Model, -BaseUrl, …). Everything falls back to the local defaults, so a plain
// copy of this directory works on any machine.
function readPluginConfig() {
  try {
    return JSON.parse(readFileSync(join(HERE, 'plugin-config.json'), 'utf8')) || {}
  } catch {
    return {}
  }
}

const CONFIG = readPluginConfig()

const HF_HOME = process.env.HINDSIGHT_HOME || CONFIG.hindsightHome || join(homedir(), '.hindsight')
const STATE_PATH = join(HF_HOME, 'hindsight-keys.json')
const PANEL_PATH = join(HERE, 'panel.html')

const DEFAULT_PROFILE = process.env.HINDSIGHT_PROFILE || CONFIG.profile || 'coding-agent'
const DEFAULT_MODEL = CONFIG.model || 'deepseek-v4.1-flash'
const DEFAULT_BASE_URL = CONFIG.baseUrl || 'http://127.0.0.1:8787/v1'
const DEFAULT_LOG = join(HF_HOME, 'opencode-bridge.log')
const DAEMON_HEALTH = CONFIG.daemonHealth || 'http://127.0.0.1:9077/health'
const BRIDGE_HEALTH = CONFIG.bridgeHealth || 'http://127.0.0.1:8787/health'

// `uvx --python <py> <spec> daemon --profile <profile>`
const EMBED_PYTHON = process.env.HINDSIGHT_EMBED_PYTHON || CONFIG.embedPython || '3.12'
const EMBED_SPEC = process.env.HINDSIGHT_EMBED_SPEC || CONFIG.embedSpec || 'hindsight-embed@1.1.0'

const BLOCK_BEGIN = '# >>> dsh-hindsight-keys: managed block, edit via the plugin >>>'
const BLOCK_END = '# <<< dsh-hindsight-keys: managed block <<<'

const MODES = new Set(['round-robin', 'failover', 'metadata'])

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function log(...args) {
  try {
    console.log('[hindsight-keys]', ...args)
  } catch {
    /* ignore */
  }
}

function fingerprint(apiKey) {
  return createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 8)
}

function mask(apiKey) {
  const k = String(apiKey || '')
  if (k.length <= 16) return k ? k.slice(0, 3) + '***' : ''
  return k.slice(0, 12) + '…' + k.slice(-4)
}

function nowIso() {
  return new Date().toISOString()
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function readJson(file) {
  const t = readText(file)
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows: rename over an existing file can fail if a reader holds it.
    try {
      unlinkSync(file)
    } catch {
      /* ignore */
    }
    renameSync(tmp, file)
  }
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function profileEnvPath(profile) {
  return join(HF_HOME, 'profiles', `${profile || DEFAULT_PROFILE}.env`)
}

function joinUrl(base, tail) {
  return String(base).replace(/\/+$/, '') + '/' + String(tail).replace(/^\/+/, '')
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 4000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* not json */
    }
    return { ok: res.ok, status: res.status, json, text }
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// credentials store (read-only; used to offer refs and label keys)
// ---------------------------------------------------------------------------

function credentialsPaths() {
  const out = []
  const dshHome = process.env.DSH_HOME || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'harness')
  out.push(join(dshHome, '.credentials.yaml'))
  out.push(join(dshHome, 'dsh-config-manager', 'vault', '.credentials.yaml'))
  return out
}

function readCredentialRefs() {
  const refs = {}
  for (const file of credentialsPaths()) {
    const text = readText(file)
    if (!text) continue
    let inRefs = false
    for (const raw of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(raw)) {
        inRefs = true
        continue
      }
      if (inRefs && /^[A-Za-z_]/.test(raw)) {
        inRefs = false
        continue
      }
      if (!inRefs) continue
      const m = /^\s{2}([A-Za-z0-9_.-]+):\s*(.*)$/.exec(raw)
      if (!m) continue
      let value = m[2].trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!value) continue
      if (!(m[1] in refs)) refs[m[1]] = value
    }
  }
  return refs
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

function readEnvPairs(envText) {
  const pairs = {}
  if (!envText) return pairs
  for (const raw of envText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    pairs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return pairs
}

function emptyState(envPath) {
  return {
    version: 1,
    profile: DEFAULT_PROFILE,
    envPath: envPath || profileEnvPath(DEFAULT_PROFILE),
    logPath: DEFAULT_LOG,
    provider: 'openai',
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    strategy: { mode: 'round-robin', cooldownSeconds: 120, weights: [] },
    primary: null,
    keys: [],
    lastApply: null,
    lastProbe: null,
    lastRestart: null,
  }
}

function keyId(apiKey) {
  return 'k-' + fingerprint(apiKey)
}

function labelFromRefs(apiKey, refs) {
  for (const [ref, value] of Object.entries(refs)) {
    if (value === apiKey) {
      const m = /_(\d+)$/.exec(ref)
      return m ? `账号${m[1]}` : ref
    }
  }
  return ''
}

/** Build state from the current env file (first run / recovery). */
function migrateFromEnv(envPath, refs) {
  const st = emptyState(envPath)
  const text = readText(envPath)
  const pairs = readEnvPairs(text)
  if (pairs.HINDSIGHT_API_LLM_PROVIDER) st.provider = pairs.HINDSIGHT_API_LLM_PROVIDER
  if (pairs.HINDSIGHT_API_LLM_MODEL) st.model = pairs.HINDSIGHT_API_LLM_MODEL
  if (pairs.HINDSIGHT_API_LLM_BASE_URL) st.baseUrl = pairs.HINDSIGHT_API_LLM_BASE_URL

  const primaryKey = pairs.HINDSIGHT_API_LLM_API_KEY || ''
  const members = []
  if (primaryKey) members.push(primaryKey)
  for (let n = 1; n < 64; n += 1) {
    const key = pairs[`HINDSIGHT_API_LLM_${n}_API_KEY`] || ''
    const provider = pairs[`HINDSIGHT_API_LLM_${n}_PROVIDER`] || ''
    if (!key && !provider) break
    if (key) members.push(key)
  }

  const seen = new Set()
  st.keys = members
    .filter((k) => {
      const fp = fingerprint(k)
      if (seen.has(fp)) return false
      seen.add(fp)
      return true
    })
    .map((apiKey, i) => {
      const ref = Object.keys(refs).find((r) => refs[r] === apiKey) || null
      return {
        id: keyId(apiKey),
        label: labelFromRefs(apiKey, refs) || `账号${i + 1}`,
        apiKey,
        ref,
        enabled: true,
        note: '',
      }
    })
  st.primary = st.keys.length ? st.keys[0].id : null

  const rawStrategy = pairs.HINDSIGHT_API_LLM_STRATEGY
  if (rawStrategy) {
    try {
      const parsed = JSON.parse(rawStrategy)
      if (parsed && MODES.has(parsed.mode)) {
        st.strategy = {
          mode: parsed.mode,
          cooldownSeconds: Number(parsed.cooldown_seconds ?? parsed.cooldownSeconds ?? 120) || 0,
          weights: Array.isArray(parsed.weights) ? parsed.weights : [],
        }
      }
    } catch {
      /* keep default */
    }
  }
  if (members.length) {
    log('migrated', st.keys.length, 'keys from', envPath)
  }
  return st
}

function loadState() {
  const raw = readJson(STATE_PATH)
  if (raw && Array.isArray(raw.keys) && raw.keys.length) {
    return { ...emptyState(profileEnvPath(raw.profile || DEFAULT_PROFILE)), ...raw }
  }
  const st = migrateFromEnv(profileEnvPath(DEFAULT_PROFILE), readCredentialRefs())
  saveState(st)
  return st
}

function saveState(st) {
  writeAtomic(STATE_PATH, JSON.stringify(st, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// env rendering
// ---------------------------------------------------------------------------

const MANAGED_LINE = /^HINDSIGHT_API_LLM_(PROVIDER|API_KEY|MODEL|BASE_URL|STRATEGY|MEMBERS|STRATEGY_|EXTRA_BODY|TIMEOUT|MAX_RETRIES)/
const MANAGED_MEMBER_LINE = /^HINDSIGHT_API_LLM_\d+_/

function stripManagedBlock(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let inside = false
  for (const line of lines) {
    if (line.trim() === BLOCK_BEGIN) {
      inside = true
      continue
    }
    if (line.trim() === BLOCK_END) {
      inside = false
      continue
    }
    if (inside) continue
    const t = line.trim()
    if (t.startsWith('#')) {
      out.push(line)
      continue
    }
    if (MANAGED_LINE.test(t) || MANAGED_MEMBER_LINE.test(t)) continue
    out.push(line)
  }
  return out.join('\n')
}

function renderManagedBlock(st) {
  const keys = orderedKeys(st)
  const primary = keys.find((k) => k.id === st.primary) || keys[0]
  if (!primary) return ''
  const extras = keys.filter((k) => k.id !== primary.id)
  const lines = []
  lines.push(BLOCK_BEGIN)
  lines.push('# Members are HINDSIGHT_API_LLM_<n>_*; member 0 is the primary above.')
  lines.push('# Rotation: HINDSIGHT_API_LLM_STRATEGY (failover | round-robin).')
  lines.push(`HINDSIGHT_API_LLM_PROVIDER=${st.provider}`)
  lines.push(`HINDSIGHT_API_LLM_API_KEY=${primary.apiKey}`)
  lines.push(`HINDSIGHT_API_LLM_MODEL=${st.model}`)
  lines.push(`HINDSIGHT_API_LLM_BASE_URL=${st.baseUrl}`)
  extras.forEach((k, i) => {
    const n = i + 1
    lines.push(`HINDSIGHT_API_LLM_${n}_PROVIDER=${st.provider}`)
    lines.push(`HINDSIGHT_API_LLM_${n}_API_KEY=${k.apiKey}`)
    lines.push(`HINDSIGHT_API_LLM_${n}_MODEL=${st.model}`)
    lines.push(`HINDSIGHT_API_LLM_${n}_BASE_URL=${st.baseUrl}`)
  })
  const strategy = { mode: st.strategy.mode, cooldown_seconds: Number(st.strategy.cooldownSeconds) || 0 }
  const weights = Array.isArray(st.strategy.weights) ? st.strategy.weights : []
  if (weights.length === keys.length && weights.every((w) => Number.isInteger(w) && w > 0)) {
    strategy.weights = weights.map((w) => Number(w))
  }
  lines.push(`HINDSIGHT_API_LLM_STRATEGY=${JSON.stringify(strategy)}`)
  lines.push(BLOCK_END)
  return lines.join('\n')
}

function orderedKeys(st) {
  return (st.keys || []).filter((k) => k && k.apiKey && k.enabled !== false)
}

function applyEnv(st) {
  const envPath = st.envPath
  const before = readText(envPath)
  if (before === null) throw new Error('无法读取环境文件: ' + envPath)
  const crlf = before.includes('\r\n')
  const base = stripManagedBlock(before).replace(/\r\n/g, '\n').replace(/\n+$/, '\n')
  const block = renderManagedBlock(st)
  if (!block) throw new Error('没有启用的 key，拒绝写出空配置')
  const next = base.replace(/\n+$/, '\n') + '\n' + block + '\n'
  const payload = crlf ? next.replace(/\n/g, '\r\n') : next

  if (payload === before) {
    return { changed: false, envPath }
  }
  // keep the last few backups, never delete older ones silently beyond 10
  const backup = `${envPath}.bak-${timestamp()}`
  writeFileSync(backup, before, 'utf8')
  writeAtomic(envPath, payload)
  pruneBackups(envPath, 10)
  return { changed: true, envPath, backup }
}

function pruneBackups(envPath, keep) {
  try {
    const dir = dirname(envPath)
    const prefix = envPath.slice(dir.length + 1) + '.bak-'
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    files.slice(keep).forEach((it) => {
      try {
        unlinkSync(join(dir, it.f))
      } catch {
        /* ignore */
      }
    })
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// bridge log statistics + health
// ---------------------------------------------------------------------------

function readLogTail(file, bytes) {
  try {
    const size = statSync(file).size
    const start = Math.max(0, size - bytes)
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

const LINE_RE = /->\s+(\d{3})\s+\S+\s+([\d.]+)s\s+key=([A-Za-z0-9-]+)/

function logStats(st) {
  const text = readLogTail(st.logPath || DEFAULT_LOG, 512 * 1024)
  const stats = {}
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line)
    if (!m) continue
    const code = Number(m[1])
    const fp = m[3]
    const s = stats[fp] || (stats[fp] = { ok: 0, fail: 0, lastCode: 0, lastAt: null, lastFailCode: 0, lastFailAt: null })
    if (code >= 200 && code < 300) {
      s.ok += 1
      s.lastCode = code
      s.lastAt = nowIso()
    } else {
      s.fail += 1
      s.lastCode = code
      s.lastFailCode = code
      s.lastFailAt = nowIso()
    }
  }
  return stats
}

async function health() {
  const [daemon, bridge] = await Promise.all([
    fetchJson(DAEMON_HEALTH, { timeoutMs: 2500 }),
    fetchJson(BRIDGE_HEALTH, { timeoutMs: 2500 }),
  ])
  return {
    daemon: { ok: daemon.ok, status: daemon.status, body: daemon.json || daemon.error || null },
    bridge: { ok: bridge.ok, status: bridge.status, body: bridge.json || bridge.error || null },
  }
}

// ---------------------------------------------------------------------------
// probing
// ---------------------------------------------------------------------------

const OPENCODE_HOST = /(^|\.)opencode\.ai$/

/**
 * OpenCode Go rejects requests without x-opencode-session (HTTP 400
 * MissingSessionID). Hindsight injects it itself for opencode.ai hosts, so a
 * probe sent straight to the native provider must carry one too — otherwise
 * every enabled key looks broken in the panel while the daemon works fine.
 * Any stable per-key value satisfies the requirement: the header groups a
 * conversation, it is not an auth credential.
 */
function probeHeaders(st, key) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key.apiKey}` }
  try {
    const host = new URL(st.baseUrl).hostname
    if (OPENCODE_HOST.test(host)) {
      headers['x-opencode-session'] = 'hindsight-keys-probe-' + fingerprint(key.apiKey)
    }
  } catch {
    /* non-URL base (e.g. a bridge alias): leave the headers alone */
  }
  return headers
}

async function probeKey(st, key) {
  const started = Date.now()
  const body = JSON.stringify({
    model: st.model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
  })
  const res = await fetchJson(joinUrl(st.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: probeHeaders(st, key),
    body,
    timeoutMs: 30000,
  })
  const ms = Date.now() - started
  if (res.ok) return { id: key.id, label: key.label, status: 'ok', code: res.status, ms, message: '' }
  const message =
    (res.json && ((res.json.error && res.json.error.message) || res.json.message)) ||
    (res.error || '').slice(0, 200) ||
    (res.text || '').slice(0, 200)
  return { id: key.id, label: key.label, status: 'error', code: res.status, ms, message: String(message) }
}

async function probeAll(st, ids) {
  // Probe every key that still has a secret, enabled or not: checking a key
  // BEFORE switching it on is the whole reason the button exists, and a
  // disabled key used to stay invisible with probe:null (0.2.0).
  const keys = (st.keys || []).filter((k) => k && k.apiKey).filter((k) => !ids || ids.includes(k.id))
  const results = []
  for (const key of keys) {
    // sequential on purpose: keeps the bridge log readable and avoids bursts
    const r = await probeKey(st, key)
    if (key.enabled === false) r.disabled = true
    results.push(r)
  }
  return results
}

// ---------------------------------------------------------------------------
// daemon restart
// ---------------------------------------------------------------------------

let restartChain = Promise.resolve()

function uvxPath() {
  const candidates = [
    process.env.HINDSIGHT_UVX,
    join(homedir(), '.local', 'bin', 'uvx.exe'),
    join(homedir(), '.local', 'bin', 'uvx'),
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return 'uvx'
}

// The daemon child inherits our environment, including the network policy
// proxy. HF_ENDPOINT is a Windows user-level variable pointing at hf-mirror.com
// on this machine, and that host is blocked by the proxy: the embeddings
// initializer raised httpx.ProxyError 403 and the daemon died during startup.
// huggingface.co itself is reachable, so normalize the endpoint for the child.
const HF_ENDPOINT_SAFE = 'https://huggingface.co'
const HF_ENDPOINT_BLOCKED = /(^|\.)hf-mirror\.com$/i

function daemonEnv() {
  const env = { ...process.env }
  const endpoint = env.HF_ENDPOINT || ''
  let host = ''
  try {
    host = new URL(endpoint).host
  } catch {
    host = ''
  }
  if (!endpoint || HF_ENDPOINT_BLOCKED.test(host)) env.HF_ENDPOINT = HF_ENDPOINT_SAFE
  return env
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    let out = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      child = spawn(command, args, {
        windowsHide: true,
        shell: process.platform === 'win32' && command === 'uvx',
        env: daemonEnv(),
      })
    } catch (err) {
      return finish({ ok: false, code: -1, out: String(err), ms: Date.now() - started })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: -2, out: out + '\n(超时)', ms: Date.now() - started })
    }, timeoutMs || 120000)
    child.stdout?.on('data', (d) => {
      out += d.toString()
      if (out.length > 20000) out = out.slice(-20000)
    })
    child.stderr?.on('data', (d) => {
      out += d.toString()
      if (out.length > 20000) out = out.slice(-20000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, code: -1, out: String(err), ms: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, code: code ?? -1, out, ms: Date.now() - started })
    })
  })
}

async function waitHealthy(attempts, delayMs) {
  for (let i = 0; i < attempts; i += 1) {
    const r = await fetchJson(DAEMON_HEALTH, { timeoutMs: 2000 })
    if (r.ok) return true
    await new Promise((res) => setTimeout(res, delayMs))
  }
  return false
}

async function waitUnhealthy(attempts, delayMs) {
  for (let i = 0; i < attempts; i += 1) {
    const r = await fetchJson(DAEMON_HEALTH, { timeoutMs: 2000 })
    if (!r.ok) return true
    await new Promise((res) => setTimeout(res, delayMs))
  }
  return false
}

// Starting the daemon on this machine takes ~2.5 minutes (uvx resolves the
// pinned embed, then the API loads its embeddings + reranker models) while the
// `daemon start` CLI itself does not exit until it is killed. 0.2.0 waited for
// that exit, killed it at 180s and only then probed health, so a restart looked
// stuck for over three minutes and the panel (a 2 minute poll window) reported
// failure while the daemon was already serving.
// Race the health probe against the CLI instead: the daemon is ready the moment
// /health answers, and the supervising CLI is disposable.
const START_TIMEOUT_MS = 300000
const HEALTH_POLL_MS = 1500

function startDaemonAndWait(uvx, base, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    let out = ''
    let settled = false
    let child = null
    let healthTimer = null
    let hardTimer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (healthTimer) clearInterval(healthTimer)
      if (hardTimer) clearTimeout(hardTimer)
      // Killing the CLI leaves the daemon it spawned running (verified on this
      // machine: the old code's kill at the 180s timeout still came up healthy).
      try {
        child && child.kill()
      } catch {
        /* ignore */
      }
      resolve({ ...result, out })
    }
    const collect = (d) => {
      out += d.toString()
      if (out.length > 20000) out = out.slice(-20000)
    }
    try {
      child = spawn(uvx, [...base, 'start'], {
        windowsHide: true,
        shell: process.platform === 'win32' && /uvx/i.test(uvx),
        env: daemonEnv(),
      })
    } catch (err) {
      settled = true
      return resolve({ ok: false, code: -1, out: String(err), ms: 0 })
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => finish({ ok: false, code: -1, ms: Date.now() - started, error: String(err) }))
    child.on('close', async (code) => {
      if (settled) return
      if (code !== 0) return finish({ ok: false, code: code ?? -1, ms: Date.now() - started, exited: true })
      // Exit 0 means the CLI handed off; let health decide.
      const healthy = await waitHealthy(20, 1500)
      if (settled) return
      finish({ ok: healthy, code: 0, ms: Date.now() - started, viaHealth: healthy, exited: true })
    })
    hardTimer = setTimeout(() => finish({ ok: false, code: -2, ms: Date.now() - started, timedOut: true }), timeoutMs)
    healthTimer = setInterval(async () => {
      if (settled) return
      const r = await fetchJson(DAEMON_HEALTH, { timeoutMs: 2000 })
      if (r.ok && !settled) finish({ ok: true, code: 0, ms: Date.now() - started, viaHealth: true })
    }, HEALTH_POLL_MS)
  })
}

function restartDaemon(st) {
  const profile = st.profile || DEFAULT_PROFILE
  const uvx = uvxPath()
  const base = ['--python', EMBED_PYTHON, EMBED_SPEC, 'daemon', '--profile', profile]
  // Mark the restart running SYNCHRONOUSLY: the panel polls as soon as /apply or
  // /restart returns and used to read restarting=false, stop waiting, and never
  // show the outcome.
  st.lastRestart = { at: nowIso(), status: 'running', steps: [] }
  saveState(st)
  restartChain = restartChain.then(async () => {
    const startedAt = st.lastRestart.at
    const stopped = await runCommand(uvx, [...base, 'stop'], 90000)
    st.lastRestart.steps.push({ step: 'stop', ok: stopped.ok, code: stopped.code, ms: stopped.ms })
    saveState(st)
    const downAfterStop = await waitUnhealthy(12, 1000)
    st.lastRestart.steps.push({ step: 'down', ok: downAfterStop, ms: 0 })
    saveState(st)
    // If the port never closed, the daemon was not stopped: starting another one
    // would "succeed" instantly against the old process and report a restart that
    // never happened. Fail loudly instead.
    if (!downAfterStop) {
      st.lastRestart = {
        at: startedAt,
        finishedAt: nowIso(),
        status: 'failed',
        steps: st.lastRestart.steps,
        healthy: true,
        stoppedFirst: false,
        error: 'daemon 在 stop 之后仍然可访问，未执行 start（它可能不是由 uvx … daemon 启动的）',
      }
      saveState(st)
      log('restart aborted: daemon still reachable after stop')
      return
    }
    const start = await startDaemonAndWait(uvx, base, START_TIMEOUT_MS)
    st.lastRestart.steps.push({
      step: 'start',
      ok: start.ok,
      code: start.code,
      ms: start.ms,
      note: start.viaHealth ? 'health' : start.timedOut ? 'timeout' : '',
    })
    const healthy = await waitHealthy(20, 1500)
    st.lastRestart = {
      at: startedAt,
      finishedAt: nowIso(),
      status: healthy ? 'ok' : 'failed',
      steps: st.lastRestart.steps,
      healthy,
      stoppedFirst: downAfterStop,
      output: (start.out || '').slice(-1200),
    }
    saveState(st)
    log('restart finished:', st.lastRestart.status, 'healthy:', healthy, 'ms:', start.ms)
  })
  restartChain.catch((err) => {
    st.lastRestart = { at: nowIso(), finishedAt: nowIso(), status: 'failed', steps: [], error: String(err) }
    saveState(st)
  })
}

// ---------------------------------------------------------------------------
// view model
// ---------------------------------------------------------------------------

const BUILD_MARKER = 'build-2026-11-19T09-00Z'

function publicState(st) {
  const refs = readCredentialRefs()
  const stats = logStats(st)
  const keys = (st.keys || []).map((k) => {
    const fp = fingerprint(k.apiKey)
    const s = stats[fp] || { ok: 0, fail: 0, lastCode: 0, lastAt: null, lastFailAt: null }
    const probe = st.lastProbe && st.lastProbe.results
      ? st.lastProbe.results.find((r) => r.id === k.id) || null
      : null
    return {
      id: k.id,
      label: k.label,
      masked: mask(k.apiKey),
      fingerprint: fp,
      ref: k.ref || null,
      enabled: k.enabled !== false,
      primary: k.id === st.primary,
      note: k.note || '',
      okCount: s.ok,
      failCount: s.fail,
      lastCode: s.lastCode || null,
      lastFailAt: s.lastFailAt || null,
      probe,
    }
  })
  const used = new Set((st.keys || []).map((k) => fingerprint(k.apiKey)))
  const availableRefs = Object.entries(refs)
    .filter(([ref, value]) => !used.has(fingerprint(value)))
    .filter(([ref]) => /API_KEY/.test(ref))
    .map(([ref, value]) => ({ ref, masked: mask(value) }))

  return {
    ok: true,
    build: BUILD_MARKER,
    profile: st.profile,
    envPath: st.envPath,
    logPath: st.logPath,
    model: st.model,
    baseUrl: st.baseUrl,
    provider: st.provider,
    strategy: st.strategy,
    primary: st.primary,
    keys,
    enabledCount: orderedKeys(st).length,
    availableRefs,
    lastApply: st.lastApply,
    lastProbe: st.lastProbe,
    lastRestart: st.lastRestart,
    restarting: !!(st.lastRestart && st.lastRestart.status === 'running'),
    envPreview: renderManagedBlock(st),
  }
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

function normalizeKey(input, refs) {
  const apiKey = String(input.apiKey || '').trim()
  if (!apiKey) throw new Error('缺少 api key')
  if (apiKey.length < 12) throw new Error('api key 太短')
  const ref = Object.keys(refs).find((r) => refs[r] === apiKey) || input.ref || null
  return {
    id: input.id || keyId(apiKey),
    label: String(input.label || '').trim() || labelFromRefs(apiKey, refs) || '账号',
    apiKey,
    ref,
    enabled: input.enabled !== false,
    note: String(input.note || '').slice(0, 200),
  }
}

function applyChanges(st, payload) {
  const refs = readCredentialRefs()
  const prevById = new Map((st.keys || []).map((k) => [k.id, k]))
  const incoming = Array.isArray(payload.keys) ? payload.keys : null
  if (incoming) {
    const seen = new Set()
    const keys = []
    for (const raw of incoming) {
      // The panel never gets plaintext keys back, so an entry without apiKey is
      // an edit of an existing entry and reuses the secret the host already has.
      const known = raw && raw.id ? prevById.get(raw.id) : null
      const apiKey = String((raw && raw.apiKey) || (known && known.apiKey) || '').trim()
      if (!apiKey) throw new Error('key 已失效，请重新粘贴：' + ((raw && (raw.label || raw.id)) || '?'))
      const key = normalizeKey({ ...raw, apiKey }, refs)
      key.label = String((raw && raw.label) || key.label).trim() || key.label
      if (seen.has(key.id)) throw new Error('重复的 key: ' + key.label)
      seen.add(key.id)
      keys.push(key)
    }
    if (!keys.length) throw new Error('至少要保留一个 key')
    st.keys = keys
  }

  if (payload.addRef) {
    const ref = String(payload.addRef)
    const value = refs[ref]
    if (!value) throw new Error('凭据库里没有 ref: ' + ref)
    st.keys = [...(st.keys || []), normalizeKey({ apiKey: value, ref, label: ref }, refs)]
  }

  if (payload.addKey) {
    const raw = typeof payload.addKey === 'string' ? { apiKey: payload.addKey } : payload.addKey
    st.keys = [...(st.keys || []), normalizeKey(raw, refs)]
  }

  if (Array.isArray(payload.removeIds) && payload.removeIds.length) {
    const drop = new Set(payload.removeIds)
    st.keys = (st.keys || []).filter((k) => !drop.has(k.id))
  }

  if (payload.strategy && typeof payload.strategy === 'object') {
    const mode = String(payload.strategy.mode || st.strategy.mode)
    if (!MODES.has(mode)) throw new Error('不支持的轮换模式: ' + mode)
    const cooldown = Number(payload.strategy.cooldownSeconds ?? payload.strategy.cooldown_seconds)
    const weights = Array.isArray(payload.strategy.weights) ? payload.strategy.weights.map(Number) : []
    if (weights.length && weights.some((w) => !Number.isInteger(w) || w <= 0)) {
      throw new Error('weights 必须是正整数')
    }
    st.strategy = {
      mode,
      cooldownSeconds: Number.isFinite(cooldown) ? Math.max(0, Math.min(86400, cooldown)) : st.strategy.cooldownSeconds,
      weights,
    }
  }

  const enabled = orderedKeys(st)
  if (!enabled.length) throw new Error('至少要启用一个 key')
  if (payload.primary) {
    if (!enabled.some((k) => k.id === payload.primary)) throw new Error('主 key 必须处于启用状态')
    st.primary = payload.primary
  } else if (!enabled.some((k) => k.id === st.primary)) {
    st.primary = enabled[0].id
  }
  if (st.strategy.weights && st.strategy.weights.length && st.strategy.weights.length !== enabled.length) {
    // weights must line up with members; drop them rather than write a broken strategy
    st.strategy.weights = []
  }

  const env = applyEnv(st)
  st.lastApply = { at: nowIso(), ok: true, changed: env.changed, backup: env.backup || null }
  saveState(st)
  return { env }
}

// ---------------------------------------------------------------------------
// http plumbing
// ---------------------------------------------------------------------------

const MAX_BODY = 512 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function handleState(req, res) {
  const st = loadState()
  sendJson(res, 200, { ...publicState(st), health: await health() })
}

async function handleApply(req, res) {
  const st = loadState()
  const payload = await readBody(req)
  const result = applyChanges(st, payload)
  const restart = payload.restart === true
  if (restart) restartDaemon(st)
  sendJson(res, 200, {
    ok: true,
    changed: result.env.changed,
    envPath: result.env.envPath,
    backup: result.env.backup || null,
    restartStarted: restart,
    state: publicState(loadState()),
  })
}

async function handleProbe(req, res) {
  const st = loadState()
  const payload = await readBody(req)
  const ids = Array.isArray(payload.ids) ? payload.ids : null
  const results = await probeAll(st, ids)
  st.lastProbe = { at: nowIso(), results }
  saveState(st)
  sendJson(res, 200, { ok: true, results, state: publicState(loadState()) })
}

async function handleRestart(req, res) {
  const st = loadState()
  restartDaemon(st)
  sendJson(res, 200, { ok: true, started: true })
}

function handlePanel(req, res) {
  const html = readText(PANEL_PATH)
  if (!html) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('panel.html missing')
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

function handle(req, res, pathname) {
  const route = pathname.split('?')[0]
  if (route === '/api/hindsight-keys/state' && req.method === 'GET') {
    return handleState(req, res)
  }
  if (route === '/api/hindsight-keys/apply' && req.method === 'POST') {
    return handleApply(req, res)
  }
  if (route === '/api/hindsight-keys/probe' && req.method === 'POST') {
    return handleProbe(req, res)
  }
  if (route === '/api/hindsight-keys/restart' && req.method === 'POST') {
    return handleRestart(req, res)
  }
  if (route === '/api/hindsight-keys/panel' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handlePanel(req, res)
  }
  sendJson(res, 404, { ok: false, error: 'not found' })
}

// ---------------------------------------------------------------------------
// plugin wiring
// ---------------------------------------------------------------------------

const passThroughSchema = (value) => ({ ...value })
passThroughSchema.toJSON = () => ({ uid: 0, refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } } })

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer service unavailable; control panel not served')
      return
    }
    for (const path of [
      '/api/hindsight-keys/state',
      '/api/hindsight-keys/apply',
      '/api/hindsight-keys/probe',
      '/api/hindsight-keys/restart',
      '/api/hindsight-keys/panel',
    ]) {
      webServer.register({
        name: 'hindsight-keys:' + path.split('/').pop(),
        kind: 'exact',
        path,
        handler: async (req, res) => {
          const pathname = String(req.url || path).split('?')[0]
          try {
            await handle(req, res, pathname)
          } catch (err) {
            log('route error', pathname, err)
            try {
              sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
            } catch {
              /* ignore */
            }
          }
        },
      })
    }
    log('control panel served at /api/hindsight-keys/panel')
  })

  ctx.inject(['settings'], (scope) => {
    if (!scope.settings || typeof scope.settings.register !== 'function') return
    try {
      scope.settings.register('hindsight-keys', passThroughSchema, { base: {} })
    } catch (err) {
      log('settings namespace registration failed:', String((err && err.message) || err))
    }
  })
}

/** Internals exposed for the offline test harness (never called by the plugin). */
export const __test = {
  fingerprint,
  mask,
  migrateFromEnv,
  stripManagedBlock,
  renderManagedBlock,
  applyEnv,
  readEnvPairs,
  logStats,
  publicState,
  applyChanges,
  restartDaemon,
  daemonEnv,
  profileEnvPath,
  STATE_PATH,
}

