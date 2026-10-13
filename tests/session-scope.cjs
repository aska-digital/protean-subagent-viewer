// Execute the shipped plugin with a host contract mock and keyed React lifecycle
// mock. Effects commit after render, dependencies are compared, removed cards
// clean up, and deferred RPCs settle against the component actually on screen.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const sourcePath = process.env.PLUGIN_SOURCE || path.join(__dirname, '../desktop/plugin.js')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function atom(initial) {
  let value = initial
  const listeners = new Set()
  return { get: () => value, listen: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { value = next; for (const fn of listeners) fn(next) } }
}
function mount(options = {}) {
  const listeners = new Map(), intervals = new Set(), fibers = new Map()
  const requests = [], clipboard = [], cards = []
  const active = atom('runtime-A'), focused = atom('runtime-A'), gateway = atom('open')
  const state = { activeSessionId: active, gateway }
  if (!options.legacy) Object.assign(state, { focusedSessionId: focused,
    focusedStoredSessionId: atom('durable-conversation-A'), connectionId: atom('local'),
    profile: atom('default'), focusedSessionOwner: atom({ connectionId: 'local', profile: 'default' }) })
  const rosters = { 'runtime-A': [{ subagent_id: 'worker-A', goal: 'A-only task', status: 'running' }],
    'runtime-B': [{ subagent_id: 'worker-B', goal: 'B-only task', status: 'running' }] }
  const host = { state, onEvent(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(fn); return () => listeners.get(type).delete(fn)
  }, request(method, params) {
    requests.push({ method, params })
    if (options.request) return options.request(method, params)
    if (method === 'subagent.list') return Promise.resolve({ subagents: rosters[params.session_id] || [], delegations: [] })
    if (method === 'session.history') return Promise.resolve({ messages: [{ text: `\n--- ${params.session_id === 'runtime-A' ? 'A-only task' : 'B-only task'}\nFull answer for ${params.session_id}` }] })
    return Promise.reject(new Error(`Unknown RPC ${method}`))
  } }
  let root, tree, currentFiber, cursor, rendering = false, dirty = false, stopped = false
  let holdFunctions = false
  const queued = []
  const effects = []
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const hooks = {
    useState(initial) {
      const f = currentFiber, i = cursor++
      if (!(i in f.values)) f.values[i] = typeof initial === 'function' ? initial() : initial
      return [f.values[i], next => {
        if (holdFunctions && typeof next === 'function') { queued.push(() => { f.values[i] = next(f.values[i]); render() }); return }
        const value = typeof next === 'function' ? next(f.values[i]) : next
        if (!Object.is(value, f.values[i])) { f.values[i] = value; render() } }]
    },
    useRef(initial) { const f = currentFiber, i = cursor++; if (!(i in f.values)) f.values[i] = { current: initial }; return f.values[i] },
    useMemo(fn, deps) { const f = currentFiber, i = cursor++; if (!equal(f.deps[i], deps)) { f.values[i] = fn(); f.deps[i] = deps } return f.values[i] },
    useEffect(fn, deps) { const f = currentFiber, i = cursor++; if (!equal(f.deps[i], deps)) {
      f.deps[i] = deps; effects.push(() => { if (f.cleanup[i]) f.cleanup[i](); f.cleanup[i] = fn() })
    } }
  }
  const jsx = (type, props) => ({ type, props: props || {} })
  const context = vm.createContext({ ...hooks, host, jsx, console,
    Badge: 'Badge', Button: 'Button', Codicon: 'Codicon', EmptyState: 'EmptyState', GlyphSpinner: 'GlyphSpinner', Tip: 'Tip',
    navigator: { clipboard: { async writeText(text) { clipboard.push(text) } } },
    window: { setInterval(fn) { intervals.add(fn); return fn }, clearInterval(fn) { intervals.delete(fn) } } })
  const source = fs.readFileSync(sourcePath, 'utf8').replace(/^import[\s\S]*?from 'react'\n/m, '').replace(/^export default \{/m, 'const plugin = {')
  vm.runInContext(source + '\nthis.plugin = plugin;', context, { filename: sourcePath })
  context.plugin.register({ register(def) { root = def.render() } })
  function walk(node, key, seen) {
    if (Array.isArray(node)) return node.map((n, i) => walk(n, `${key}/${n?.props?.key || i}`, seen))
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      key += `:${node.type.name}`
      seen.add(key)
      if (!fibers.has(key)) fibers.set(key, { values: [], deps: [], cleanup: [] })
      currentFiber = fibers.get(key); cursor = 0
      if (node.type.name === 'WorkerCard') cards.push(node.props)
      return walk(node.type(node.props), key, seen)
    }
    return { ...node, props: { ...node.props, children: walk(node.props.children, `${key}/children`, seen) } }
  }
  function render() {
    if (stopped) return
    dirty = true
    if (rendering) return
    rendering = true
    while (dirty) {
      dirty = false; cards.length = 0
      const seen = new Set()
      tree = walk(root, 'root', seen)
      for (const [key, f] of fibers) if (!seen.has(key)) { f.cleanup.forEach(fn => fn && fn()); fibers.delete(key) }
      effects.splice(0).forEach(fn => fn())
    }
    rendering = false
  }
  render()
  function nodes(node, list = []) {
    if (Array.isArray(node)) node.forEach(n => nodes(n, list))
    else if (node && typeof node === 'object') { list.push(node); nodes(node.props?.children, list) }
    return list
  }
  return { state, requests, clipboard, rosters, cards,
    focus(sid) { active.set(sid); if (!options.legacy) focused.set(sid); else intervals.forEach(fn => fn()) },
    emit(type, sid, payload, tags = options.legacy ? {} : { connectionId: 'local', profile: 'default' }) {
      for (const fn of listeners.get(type) || []) fn({ type, session_id: sid, payload, ...tags })
    }, poll() { intervals.forEach(fn => fn()) },
    workers() { return cards.map(c => c.worker) },
    button(label) { return nodes(tree).find(n => n.props?.children === label && typeof n.props?.onClick === 'function') },
    text() { return JSON.stringify(tree) },
    deferUpdates(fn) { holdFunctions = true; fn(); holdFunctions = false; return () => queued.splice(0).forEach(apply => apply()) },
    holdUpdates() { holdFunctions = true; return () => { holdFunctions = false; queued.splice(0).forEach(apply => apply()) } },
    unmount() { stopped = true; fibers.forEach(f => f.cleanup.forEach(fn => fn && fn())) }
  }
}

test('scoped roster and event buffers follow runtime focus, never durable ids', async () => {
  const h = mount(); await tick()
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['worker-A'])
  assert.equal(h.requests[0].method, 'subagent.list')
  assert.equal(h.requests[0].params.session_id, 'runtime-A')
  h.emit('subagent.text', 'durable-conversation-A', { subagent_id: 'wrong-id', text: 'foreign durable event' })
  h.emit('subagent.text', 'runtime-A', { subagent_id: 'worker-A', text: 'A buffer' })
  assert.equal(h.workers()[0].output, 'A buffer')
  h.focus('runtime-B')
  assert.equal(h.workers().length, 0)
  await tick()
  h.emit('subagent.text', 'runtime-A', { subagent_id: 'worker-A', text: 'late A event' })
  h.emit('subagent.start', 'runtime-B', { subagent_id: 'wrong-source' }, { connectionId: 'foreign', profile: 'default' })
  h.emit('subagent.text', 'runtime-B', { subagent_id: 'worker-B', text: 'B buffer' })
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['worker-B'])
  assert.equal(h.workers()[0].output, 'B buffer')
  h.focus('runtime-A'); await tick()
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['worker-A'])
  assert.equal(h.workers()[0].output, undefined)
  assert(!h.requests.some(r => r.method === 'delegation.status'))
  h.unmount()
})

test('stale polls cannot refill another session or a newer generation of the same session', async () => {
  const old = deferred(), newer = deferred(); let a = 0
  const h = mount({ request(method, params) {
    assert.equal(method, 'subagent.list')
    if (params.session_id === 'runtime-A') return (++a === 1 ? old : newer).promise
    return Promise.resolve({ subagents: [{ subagent_id: 'worker-B', status: 'running' }] })
  } })
  h.focus('runtime-B'); await tick()
  old.resolve({ subagents: [{ subagent_id: 'old-A', status: 'running' }] }); await tick()
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['worker-B'])
  h.focus('runtime-A')
  newer.resolve({ subagents: [{ subagent_id: 'new-A', status: 'running' }] }); await tick()
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['new-A'])
  h.unmount()
})

test('past cards and buffers reset on focus change', async () => {
  const h = mount(); await tick()
  h.emit('subagent.complete', 'runtime-A', { subagent_id: 'worker-A', summary: 'A done', status: 'done' })
  h.button('Past').props.onClick()
  assert.equal(h.workers()[0].summary, 'A done')
  h.focus('runtime-B'); await tick()
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['worker-B'])
  h.button('Past').props.onClick()
  assert.equal(h.workers().length, 0)
  h.unmount()
})

test('no session and disconnected states clear cards without global fallback', async () => {
  const h = mount(); await tick()
  h.focus(null); await tick()
  assert.equal(h.workers().length, 0)
  const count = h.requests.length
  h.emit('subagent.start', 'runtime-A', { subagent_id: 'late-A' }); h.poll(); await tick()
  assert.equal(h.requests.length, count)
  h.focus('runtime-B'); await tick()
  h.state.gateway.set('closed'); await tick()
  assert.equal(h.workers().length, 0)
  h.emit('subagent.start', 'runtime-B', { subagent_id: 'late-B' }); h.poll(); await tick()
  assert.equal(h.workers().length, 0)
  h.state.gateway.set('open'); await tick()
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['worker-B'])
  h.unmount()
})

test('missing scoped RPC degrades unavailable and mismatched focused route makes no request', async () => {
  const h = mount({ request: () => Promise.reject(new Error('method not found')) }); await tick()
  assert.equal(h.workers().length, 0)
  assert(h.text().includes('unavailable'))
  assert(h.requests.every(r => r.method === 'subagent.list'))
  h.state.focusedSessionOwner.set({ connectionId: 'other-source', profile: 'default' }); await tick()
  const count = h.requests.length; h.poll(); await tick()
  assert.equal(h.requests.length, count)
  h.unmount()
})

test('copy requests owning runtime history; stale history completion cannot copy after focus changes', async () => {
  const history = deferred()
  const h = mount({ request(method, params) {
    if (method === 'subagent.list') return Promise.resolve({ subagents: [{ subagent_id: params.session_id, goal: `${params.session_id} goal`, status: 'running' }] })
    assert.equal(method, 'session.history'); return history.promise
  } }); await tick()
  h.button('Copy output for forward').props.onClick()
  assert.equal(h.requests.at(-1).params.session_id, 'runtime-A')
  h.focus('runtime-B'); await tick()
  history.resolve({ messages: [{ text: '\n--- runtime-A goal\nA full answer' }] }); await tick()
  assert.equal(h.clipboard.length, 0)
  assert(!h.text().includes('Copied full output'))
  h.unmount()
  const live = mount(); await tick()
  live.button('Copy output for forward').props.onClick(); await tick()
  assert.equal(live.requests.at(-1).params.session_id, 'runtime-A')
  assert(live.clipboard[0].includes('Full answer for runtime-A'))
  live.focus('runtime-B'); await tick()
  live.button('Copy output for forward').props.onClick(); await tick()
  assert.equal(live.requests.at(-1).params.session_id, 'runtime-B')
  assert(live.clipboard[1].includes('Full answer for runtime-B'))
  live.unmount()
})

test('older standalone hosts with only active-session atom still stay scoped', async () => {
  const h = mount({ legacy: true }); await tick()
  h.focus('runtime-B'); await tick()
  h.emit('subagent.text', 'runtime-A', { subagent_id: 'worker-A', text: 'foreign' })
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['worker-B'])
  h.unmount()
})


test('queued event and poll state updaters cannot be applied under a new focus', async () => {
  const h = mount(); await tick()
  const flushEvent = h.deferUpdates(() => h.emit('subagent.start', 'runtime-A', { subagent_id: 'queued-A', goal: 'queued A' }))
  h.focus('runtime-B'); await tick()
  flushEvent()
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['worker-B'])
  const snapshot = deferred()
  const p = mount({ request(method, params) {
    if (params.session_id === 'runtime-A') return snapshot.promise
    return Promise.resolve({ subagents: [{ subagent_id: 'poll-B', status: 'running' }] })
  } })
  const flushPoll = p.holdUpdates()
  snapshot.resolve({ subagents: [{ subagent_id: 'queued-poll-A', status: 'running' }] }); await tick()
  p.focus('runtime-B'); await tick()
  flushPoll()
  assert.deepEqual(p.workers().map(w => w.subagent_id), ['poll-B'])
  p.unmount()
  h.unmount()
})


test('A to B to A discards the first A generation even when its response lands last', async () => {
  const first = deferred(), second = deferred(); let calls = 0
  const h = mount({ request(method, params) {
    if (params.session_id === 'runtime-A') return (++calls === 1 ? first : second).promise
    return Promise.resolve({ subagents: [] })
  } })
  h.focus('runtime-B'); await tick(); h.focus('runtime-A')
  second.resolve({ subagents: [{ subagent_id: 'current-A', status: 'running' }] }); await tick()
  first.resolve({ subagents: [{ subagent_id: 'obsolete-A', status: 'running' }] }); await tick()
  assert.deepEqual(h.workers().map(w => w.subagent_id), ['current-A'])
  h.unmount()
})

test('unmounted card ignores a history completion even while its owner remains focused', async () => {
  const history = deferred()
  const h = mount({ request(method) {
    if (method === 'subagent.list') return Promise.resolve({ subagents: [{ subagent_id: 'worker-A', goal: 'A-only task', status: 'running' }] })
    return history.promise
  } }); await tick()
  h.button('Copy output for forward').props.onClick(); h.unmount()
  history.resolve({ messages: [{ text: '\n--- A-only task\nFull A response' }] }); await tick()
  assert.equal(h.clipboard.length, 0)
})

test('newer streaming event wins over an earlier roster response', async () => {
  const snapshot = deferred()
  const h = mount({ request: () => snapshot.promise })
  h.emit('subagent.start', 'runtime-A', { subagent_id: 'worker-A', goal: 'A-only task' })
  h.emit('subagent.text', 'runtime-A', { subagent_id: 'worker-A', text: 'new event output' })
  snapshot.resolve({ subagents: [] }); await tick()
  assert.equal(h.workers()[0].status, 'running')
  assert.equal(h.workers()[0].output, 'new event output')
  h.unmount()
})
