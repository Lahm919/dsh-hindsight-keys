/**
 * End-to-end check of the host half without a running DSH: mounts apply(ctx)
 * against a fake webServer service, then talks HTTP to the real handlers.
 *
 *   node test/serve-local.mjs
 *
 * Uses HINDSIGHT_HOME when set (defaults to ~/.hindsight) — read-only for the
 * env, but the pool of record (hindsight-keys.json) is created on first run.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const routes = new Map()

const ctx = {
  inject(services, cb) {
    if (services.includes('webServer')) {
      cb({ webServer: { register(route) { routes.set(route.path, route) } } })
    } else if (services.includes('settings')) {
      cb({ settings: { register() {} } })
    }
  },
}

apply(ctx)
assert.ok(routes.size >= 5, 'expected every route to register, got ' + routes.size)

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const route = routes.get(pathname)
  if (!route || typeof route.handler !== 'function') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(err))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port
const results = []
const check = async (label, fn) => {
  try {
    await fn()
    results.push(['ok', label])
  } catch (err) {
    results.push(['FAIL', label, String((err && err.message) || err)])
  }
}

try {
  const stateRes = await fetch(base + '/api/hindsight-keys/state')
  const state = await stateRes.json()

  await check('GET /state answers 200 json', () => {
    assert.equal(stateRes.status, 200)
    assert.equal(stateRes.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(state.ok, true)
  })

  await check('state exposes the 4 key pool without plaintext', () => {
    assert.ok(Array.isArray(state.keys) && state.keys.length >= 4)
    assert.equal(state.model, 'deepseek-v4.1-flash')
    assert.ok(state.strategy && ['round-robin', 'failover'].includes(state.strategy.mode))
    const raw = JSON.stringify(state)
    assert.ok(!/oc_sk_[A-Za-z0-9]{20,}/.test(raw), 'no full key in the payload')
    for (const k of state.keys) {
      assert.equal(k.fingerprint.length, 8)
      assert.ok(!k.masked.includes(k.fingerprint))
    }
  })

  await check('state reports health for daemon + bridge', () => {
    assert.ok(state.health && state.health.daemon && state.health.bridge)
  })

  await check('env preview is the managed block that will be written', () => {
    assert.match(state.envPreview, /# >>> dsh-hindsight-keys/)
    assert.match(state.envPreview, /HINDSIGHT_API_LLM_STRATEGY=/)
    assert.match(state.envPreview, /HINDSIGHT_API_LLM_BASE_URL=http:\/\/127\.0\.0\.1:8787\/v1/)
  })

  const panelRes = await fetch(base + '/api/hindsight-keys/panel')
  const html = await panelRes.text()

  await check('GET /panel serves the control panel', () => {
    assert.equal(panelRes.status, 200)
    assert.equal(panelRes.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(html, /Hindsight API Key 池/)
    assert.match(html, /\/api\/hindsight-keys\/apply/)
  })

  await check('inline panel script parses', () => {
    const m = html.match(/<script>([\s\S]*?)<\/script>/)
    assert.ok(m, 'inline script found')
    // eslint-disable-next-line no-new-func
    new Function(m[1])
  })

  const missing = await fetch(base + '/api/hindsight-keys/nope')
  await check('unknown route answers a json 404', async () => {
    assert.equal(missing.status, 404)
  })

  const badApply = await fetch(base + '/api/hindsight-keys/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys: [] }),
  })
  const badJson = await badApply.json()
  await check('POST /apply surfaces validation errors instead of crashing', () => {
    assert.ok(badApply.status === 500 || badApply.status === 200)
    assert.equal(badJson.ok, false)
    assert.match(String(badJson.error), /至少要保留一个 key/)
  })

  const probe = await fetch(base + '/api/hindsight-keys/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['does-not-exist'] }),
  })
  await check('POST /probe tolerates an unknown id', async () => {
    assert.equal(probe.status, 200)
    const body = await probe.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.results, [])
  })

  // panel.html and index.js must stay consistent about the routes it calls
  const panelSource = readFileSync(join(HERE, '..', 'panel.html'), 'utf8')
  await check('panel only calls routes the host registers', () => {
    const called = [...panelSource.matchAll(/'(\/api\/hindsight-keys\/[a-z]+)'/g)].map((m) => m[1])
    assert.ok(called.length >= 3)
    for (const path of called) assert.ok(routes.has(path), 'panel calls unregistered route ' + path)
  })
} finally {
  server.close()
}

const failed = results.filter((r) => r[0] === 'FAIL')
for (const [status, label, detail] of results) {
  console.log(`${status === 'ok' ? 'PASS' : 'FAIL'}  ${label}${detail ? '\n        ' + detail : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exitCode = 1
