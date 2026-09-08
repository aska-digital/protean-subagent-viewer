/**
 * subagent-viewer — Hermes Desktop read-only Subagent Viewer (MVP).
 *
 * A standalone runtime plugin (no codebase modification, no bundle patch) that
 * turns the agent's async subagent fan-out into a read-only viewer pane: live
 * worker cards, streaming thinking / tool / output, full-output copy, and an
 * Active/Past view toggle.
 *
 * This is the MVP subset of a larger in-development fan-out plugin ("Chief of
 * Staff"). The viewer-only slice is deliberate: the user verified LIVE that
 * viewing spawned subagents works perfectly, while the steer / interrupt /
 * orchestrator-control features were not yet reliable — so this fork keeps the
 * verified viewer and strips the rest. It OBSERVES and lets you copy output;
 * it never steers, interrupts, spawns, or mutates the orchestrator session.
 *
 * Data sources (all local, no telemetry):
 *   - Live worker list: the gateway's `active` subagent snapshot. Preferred
 *     RPC is `session.info` (returns `active` when the backend carries it);
 *     this checkout registers `delegation.status` as the reliable `active`
 *     source, so we LADDER: try `session.info`, fall back to
 *     `delegation.status`. Both return records shaped
 *     `{subagent_id, parent_id, depth, goal, model, started_at, tool_count,
 *     status}`.
 *   - Live stream: `subagent.*` events (start / thinking / text / tool /
 *     complete / progress) relayed by the owning session's delegate_task —
 *     reach renderer plugin listeners FIRST via emitGatewayEvent.
 *   - Poll `session.info` (then `delegation.status`) every ~8s as a backstop,
 *     coalesced so overlapping polls never stack.
 *
 * No upstream approval needed: standalone desktop plugin, mirrors
 * group-model-sync's register + pane + host.request + host.onEvent shape.
 */

import {
  Badge,
  Button,
  Codicon,
  EmptyState,
  GlyphSpinner,
  host,
  Tip
} from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState } from 'react'

const ID = 'subagent-viewer'
const POLL_MS = 8000
const THINKING_CAP = 2000
const OUTPUT_CAP = 2000
const SUBAGENT_EVENTS = [
  'subagent.start',
  'subagent.thinking',
  'subagent.text',
  'subagent.tool',
  'subagent.complete',
  'subagent.progress'
]
const STATUS_LABELS = {
  running: 'running',
  done: 'done',
  complete: 'done',
  interrupted: 'interrupted',
  error: 'errored',
  errored: 'errored',
  failed: 'errored'
}
const STATUS_VARIANTS = {
  running: 'default',
  done: 'success',
  complete: 'success',
  interrupted: 'warning',
  error: 'destructive',
  errored: 'destructive',
  failed: 'destructive'
}

// ── tiny helpers ────────────────────────────────────────────────────────────

const asRecord = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

const rpcErrorText = err => {
  const e = asRecord(err)
  return String(e.message || e.error || err || 'request failed')
}

const str = v => String(v == null ? '' : v)

const truncate = (text, max) => {
  const t = str(text)
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** A subagent's live status (events + active records use slightly different
 *  vocab; normalize to the brief's four-card states). */
const normalizeStatus = raw => {
  const s = str(raw).toLowerCase()
  return STATUS_LABELS[s] || s || 'running'
}

const statusVariant = raw => STATUS_VARIANTS[normalizeStatus(raw)] || 'muted'

/** The pane's active session id — host.state.activeSessionId atom, falling
 *  back to the last seen session.info event session_id. */
function currentSessionId(fallbackEventSid) {
  try {
    const atom = host.state && host.state.activeSessionId
    const live = typeof atom === 'function' ? atom() : atom
    const sid = live && typeof live.get === 'function' ? live.get() : live
    if (sid) {
      return str(sid)
    }
  } catch {
    /* atom read failed — fall through */
  }
  return fallbackEventSid ? str(fallbackEventSid) : ''
}

// ── RPC helpers ─────────────────────────────────────────────────────────────

/** The gateway JSON-RPC door. */
const gate = (method, params = {}) => host.request(method, params)

/** Live worker snapshot — ladder: session.info (per brief) → delegation.status
 *  (the registered `active` source in this checkout). */
async function fetchActiveWorkers() {
  try {
    const res = await gate('session.info', {})
    const rec = asRecord(res)
    const active = Array.isArray(rec.active)
      ? rec.active
      : Array.isArray(rec.payload && rec.payload.active)
        ? rec.payload.active
        : null
    if (active) {
      return { active, source: 'session.info' }
    }
    /* session.info resolved but carried no active list — ladder down */
  } catch {
    /* unknown method or transport error — ladder down */
  }
  const res = await gate('delegation.status', {})
  const rec = asRecord(res)
  const active = Array.isArray(rec.active) ? rec.active : null
  return { active: active || [], source: 'delegation.status' }
}



/** Pull the FULL final_response for a worker out of the ORCHESTRATOR's session
 *  history. The [ASYNC DELEGATION BATCH COMPLETE] message injected into the
 *  parent session carries the child's complete final_response (up to 24k
 *  chars) — NOT the 500-char cap the subagent.complete event relays
 *  (delegate_tool.py:3442 `summary[:500]`). Matches by a distinctive goal
 *  prefix and extracts text after the task header. Returns '' if not found. */
function extractDelegationSummary(goal, messages) {
  const goalKey = str(goal || '').trim().slice(0, 80)
  if (!goalKey || !Array.isArray(messages) || !messages.length) {
    return ''
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || typeof m !== 'object') {
      continue
    }
    const text = str(m.text != null ? m.text : m.content)
    if (!text || !text.includes(goalKey)) {
      continue
    }
    // Found the completion message. Walk back to the task header line.
    const idx = text.indexOf(goalKey)
    let lineStart = text.lastIndexOf('\n--- ', idx)
    if (lineStart === -1) {
      lineStart = text.lastIndexOf('\n───', idx)
    }
    const after = lineStart === -1 ? text : text.slice(lineStart + 1)
    // Cut at the next task header, the transcript footer, or the end.
    const cut = after.search(/\n--- |\n────────/)
    return (cut === -1 ? after : after.slice(0, cut)).trim()
  }
  return ''
}

/** Assemble the FULL output for a worker. Priority (verified against source):
 *  1. Full final_response extracted from the ORCHESTRATOR's live session
 *     history (the completion message carries the full text; the event
 *     summary is capped at 500 chars at delegate_tool.py:3442).
 *  2. `summary` — the 500-char event relay.
 *  3. `outputTail` — subagent.complete relays output_tail: the last 12 tool
 *     results with real content ({tool, preview, is_error}).
 *  4. `outputBuffer` — locally accumulated previews (thin: the gateway
 *     DELIBERATELY skips subagent.text to the parent — server.py "skip the
 *     parent emit"). */
async function fetchFullOutput(worker, orchSid) {
  const rec = asRecord(worker)
  const summary = str(rec.summary || '').trim()
  if (orchSid && rec.goal) {
    try {
      const res = await gate('session.history', { session_id: orchSid })
      const msgs = (asRecord(res).messages || []).filter(m => m && typeof m === 'object')
      const full = extractDelegationSummary(rec.goal, msgs)
      if (full && full.length > summary.length) {
        return full
      }
    } catch {
      /* history fetch failed — fall through */
    }
  }
  if (summary) {
    return summary
  }
  const tail = Array.isArray(rec.outputTail) && rec.outputTail.length
    ? rec.outputTail.map(t => {
        const tr = asRecord(t)
        const preview = str(tr.preview || tr.text || '').trim()
        return preview ? `[${tr.tool || 'tool'}${tr.is_error ? ' · error' : ''}] ${preview}` : ''
      }).filter(Boolean).join('\n\n')
    : ''
  if (tail) {
    return tail
  }
  return str(rec.outputBuffer) || str(rec.output)
}

// ── components ──────────────────────────────────────────────────────────────

function Spinner({ label }) {
  return jsx('div', {
    className: 'flex items-center gap-2 py-4 text-xs text-(--ui-text-tertiary)',
    children: [jsx(GlyphSpinner, { className: 'size-3.5 text-(--ui-text-tertiary)', spinner: 'breathe' }), label || 'Loading…']
  })
}

function StatusBadge({ status }) {
  const norm = normalizeStatus(status)
  return jsx(Badge, {
    className: 'shrink-0 text-[0.6rem] capitalize',
    variant: statusVariant(status),
    children: norm
  })
}

// ── worker card ─────────────────────────────────────────────────────────────

function WorkerCard({ worker, sessionId, onCopied }) {
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const [busy, setBusy] = useState('')
  // FIX 4 — output body expand/collapse so full in-pane worker output is
  // reachable (the copy feature still grabs the authoritative full summary).
  const [outputOpen, setOutputOpen] = useState(false)

  const running = worker.status === 'running'
  const goal = truncate(worker.goal, 160)
  const thinking = str(worker.thinking)
  const thinkingTruncated = thinking.length > THINKING_CAP
  const shownThinking = thinkingTruncated ? thinking.slice(-THINKING_CAP) : thinking
  const showThinking = running || !!thinking

  // Worker model block — read-only. The worker's model field is the
  // delegation-resolved truth; the viewer only DISPLAYS it. Model/reasoning
  // control (spawn hints / orchestrator overrides) was stripped from this
  // fork — the MVP viewer never steers or reconfigures workers.
  const workerModel = worker.model || ''

  // Fix 2 (V4) — full-output copy: orchestrator-history extraction (the
  // completion message carries the full final_response), then summary /
  // output_tail / buffer fallbacks. Never just the last preview.
  const doCopy = async () => {
    setBusy('copy')
    try {
      const full = await fetchFullOutput(worker, sessionId)
      await navigator.clipboard.writeText(full)
      onCopied(`Copied full output for ${worker.subagent_id}`)
    } catch (e) {
      onCopied(`Copy failed: ${rpcErrorText(e)}`)
    } finally {
      setBusy('')
    }
  }

  return jsx('div', {
    className: 'flex h-56 flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-surface-secondary) p-2',
    children: [
      // ── header (fixed, never scrolls) ────────────────────────────────────
      jsx('div', {
        className: 'shrink-0',
        children: [
          jsx('div', {
            className: 'flex items-center gap-1.5',
            children: [
              jsx(StatusBadge, { status: worker.status }),
              jsx('div', {
                className: 'min-w-0 flex-1',
                children: [
                  jsx('div', {
                    className: 'truncate text-xs font-medium text-(--ui-text-primary)',
                    title: goal,
                    children: goal || '(no goal)'
                  }),
                  jsx('div', {
                    className: 'truncate text-[0.6rem] text-(--ui-text-quaternary)',
                    children: [
                      worker.subagent_id,
                      worker.depth ? ` · depth ${worker.depth}` : '',
                      worker.tool_count != null ? ` · ${worker.tool_count} tool${worker.tool_count === 1 ? '' : 's'}` : '',
                      worker.child_session_id ? ' · history' : ''
                    ].join('')
                  })
                ]
              })
            ]
          }),
          // worker model block — read-only (viewer only)
          workerModel
            ? jsx('div', {
                className: 'mt-1 truncate text-[0.6rem] text-(--ui-text-tertiary)',
                title: workerModel,
                children: `Worker model: ${workerModel}`
              })
            : null
        ]
      }),

      // ── middle (bounded, internal scroll; footer never moves) ────────────
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto',
        children: [
          // thinking block — ALWAYS present while running (ellipsis if empty)
          showThinking
            ? jsx('div', {
                className: 'mt-1.5',
                children: [
                  jsx(Button, {
                    className: 'h-5 px-1 text-[0.6rem] text-(--ui-text-tertiary)',
                    onClick: () => setThinkingOpen(o => !o),
                    size: 'sm',
                    variant: 'ghost',
                    children: thinkingOpen
                      ? '▾ thinking'
                      : `▸ thinking${thinking ? ` (${thinking.length} chars)` : ' (…)'}`
                  }),
                  thinkingOpen
                    ? jsx('div', {
                        className: 'mt-0.5 max-h-24 overflow-y-auto rounded bg-(--ui-surface-tertiary) p-1.5 text-[0.65rem] leading-snug whitespace-pre-wrap text-(--ui-text-secondary)',
                        children: !thinking
                          ? (running ? '…' : '')
                          : thinkingTruncated ? `…${shownThinking}` : shownThinking
                      })
                    : null
                ]
              })
            : null,

          // tool line — fixed-height single line, truncated
          worker.lastTool
            ? jsx('div', {
                className: 'mt-1 flex h-4 items-center gap-1 text-[0.65rem] text-(--ui-text-tertiary)',
                children: [
                  jsx(Codicon, { className: 'size-3 shrink-0', name: 'debug-alt' }),
                  jsx('span', { className: 'truncate', children: truncate(worker.lastTool, 120) })
                ]
              })
            : null,

          // output block — internal scroll. Collapsed shows a truncated
          // preview; once output exceeds OUTPUT_CAP a toggle reveals it fully.
          worker.output || running
            ? jsx('div', {
                className: outputOpen
                  ? 'mt-1 max-h-60 overflow-y-auto rounded bg-(--ui-surface-tertiary) p-1.5 text-[0.65rem] leading-snug whitespace-pre-wrap text-(--ui-text-secondary)'
                  : 'mt-1 max-h-20 overflow-y-auto rounded bg-(--ui-surface-tertiary) p-1.5 text-[0.65rem] leading-snug whitespace-pre-wrap text-(--ui-text-secondary)',
                children: worker.output ? (outputOpen ? worker.output : truncate(worker.output, OUTPUT_CAP)) : (running ? '…' : '')
              })
            : null,
          (worker.output && worker.output.length > OUTPUT_CAP)
            ? jsx('button', {
                className: 'mt-1 text-[0.6rem] text-(--ui-text-tertiary) underline decoration-dotted underline-offset-2 hover:text-foreground',
                onClick: () => setOutputOpen(o => !o),
                type: 'button',
                children: outputOpen ? 'show less' : `show all output (${worker.output.length} chars)`
              })
            : null
        ]
      }),

      // ── footer (always rendered, pinned to card bottom) ───────────────────
      jsx('div', {
        className: 'shrink-0',
        children: [
          // action row — full-output copy for all states (viewer-only)
          jsx('div', {
            className: 'mt-1.5 flex items-center gap-1.5',
            children: [
              jsx(Button, {
                className: 'h-6 px-2 text-xs',
                disabled: busy === 'copy',
                onClick: () => void doCopy(),
                size: 'sm',
                variant: 'ghost',
                children: busy === 'copy' ? '…' : 'Copy output for forward'
              })
            ]
          })
        ]
      })
    ]
  })
}

// ── pane root ───────────────────────────────────────────────────────────────

function PaneRoot() {
  const [sessionId, setSessionId] = useState(() => currentSessionId(''))
  const [workers, setWorkers] = useState([])
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  // fix 5 — view toggle: 'active' (running) | 'past' (done/interrupted/errored)
  const [view, setView] = useState('active')
  const pollInFlight = useRef(false)
  const eventSid = useRef('')

  // Refresh the active-session id from the live atom periodically (the atom
  // can be null on a fresh draft and populate once a session activates).
  useEffect(() => {
    const t = window.setInterval(() => {
      setSessionId(s => currentSessionId(eventSid.current) || s)
    }, POLL_MS)
    return () => window.clearInterval(t)
  }, [])

  /** Upsert a worker card keyed by subagent_id. `_appendOutput` marks output
   *  chunks that ACCUMULATE (subagent.text / subagent.complete previews) —
   *  never overwrite; everything else replaces its field. */
  const upsertWorker = patch => {
    const rec = asRecord(patch)
    const sid = str(rec.subagent_id)
    if (!sid) {
      return
    }
    setWorkers(prev => {
      const idx = prev.findIndex(w => w.subagent_id === sid)
      if (idx === -1) {
        const initialOutput = rec.outputBuffer != null
          ? str(rec.outputBuffer)
          : rec.output != null ? str(rec.output) : ''
        return [
          ...prev,
          {
            subagent_id: sid,
            parent_id: rec.parent_id ? str(rec.parent_id) : '',
            depth: rec.depth != null ? rec.depth : 0,
            goal: rec.goal != null ? str(rec.goal) : '',
            model: rec.model ? str(rec.model) : '',
            child_session_id: rec.child_session_id ? str(rec.child_session_id) : '',
            started_at: rec.started_at || null,
            tool_count: rec.tool_count != null ? rec.tool_count : 0,
            status: rec.status ? normalizeStatus(rec.status) : 'running',
            thinking: rec.thinking ? str(rec.thinking) : '',
            lastTool: rec.lastTool ? str(rec.lastTool) : '',
            summary: rec.summary != null ? str(rec.summary) : '',
            outputTail: Array.isArray(rec.outputTail) ? rec.outputTail : [],
            output: initialOutput,
            outputBuffer: initialOutput
          }
        ]
      }
      const next = [...prev]
      const cur = next[idx]
      let output = cur.output
      let outputBuffer = cur.outputBuffer || ''
      if (rec._appendOutput && rec.output != null) {
        const chunk = str(rec.output)
        if (chunk) {
          outputBuffer = outputBuffer ? `${outputBuffer}\n\n${chunk}` : chunk
          output = outputBuffer
        }
      } else if (rec.output != null) {
        outputBuffer = str(rec.output)
        output = outputBuffer
      }
      next[idx] = {
        ...cur,
        parent_id: rec.parent_id != null ? str(rec.parent_id) : cur.parent_id,
        depth: rec.depth != null ? rec.depth : cur.depth,
        goal: rec.goal != null ? str(rec.goal) : cur.goal,
        model: rec.model ? str(rec.model) : cur.model,
        child_session_id: rec.child_session_id ? str(rec.child_session_id) : cur.child_session_id,
        started_at: rec.started_at || cur.started_at,
        tool_count: rec.tool_count != null ? rec.tool_count : cur.tool_count,
        status: rec.status ? normalizeStatus(rec.status) : cur.status,
        thinking: rec.thinking != null ? str(rec.thinking) : cur.thinking,
        lastTool: rec.lastTool != null ? str(rec.lastTool) : cur.lastTool,
        summary: rec.summary != null ? str(rec.summary) : cur.summary,
        outputTail: Array.isArray(rec.outputTail) ? rec.outputTail : cur.outputTail,
        output,
        outputBuffer
      }
      return next
    })
  }

  /** Poll session.info (→ delegation.status) as the backstop live-worker
   *  source, coalesced. Poll records MERGE into existing workers so
   *  accumulated fields (outputBuffer, child_session_id, thinking) survive. */
  const pollWorkers = async () => {
    if (pollInFlight.current) {
      return
    }
    pollInFlight.current = true
    try {
      const { active } = await fetchActiveWorkers()
      const seen = new Set()
      const byId = {}
      for (const w of active) {
        const rec = asRecord(w)
        const sid = str(rec.subagent_id)
        if (!sid) {
          continue
        }
        seen.add(sid)
        byId[sid] = {
          subagent_id: sid,
          parent_id: rec.parent_id ? str(rec.parent_id) : '',
          depth: rec.depth != null ? rec.depth : 0,
          goal: rec.goal != null ? str(rec.goal) : '',
          model: rec.model ? str(rec.model) : '',
          started_at: rec.started_at || null,
          tool_count: rec.tool_count != null ? rec.tool_count : 0,
          status: rec.status ? normalizeStatus(rec.status) : 'running'
        }
      }
      setWorkers(prev => {
        const merged = prev.map(w => {
          const poll = byId[w.subagent_id]
          if (!poll) {
            return { ...w, status: w.status === 'running' ? 'done' : w.status }
          }
          return { ...w, ...poll }
        })
        const fresh = Object.values(byId).filter(w => !prev.some(p => p.subagent_id === w.subagent_id))
        return [...fresh, ...merged]
      })
      setStatus('')
    } catch (err) {
      setStatus(`Worker poll failed: ${rpcErrorText(err)}`)
    } finally {
      pollInFlight.current = false
      setLoading(false)
    }
  }

  /** Initial load: session id + live workers. */
  const refresh = async () => {
    setLoading(true)
    setStatus('')
    const sid = currentSessionId(eventSid.current)
    if (sid) {
      setSessionId(sid)
    }
    await pollWorkers()
  }

  // Mount: subscribe to the subagent.* event family + initial load.
  useEffect(() => {
    refresh()
    const disposers = SUBAGENT_EVENTS.map(type =>
      host.onEvent(type, event => {
        const payload = asRecord(event && event.payload)
        const sid = event && event.session_id
        if (sid) {
          eventSid.current = str(sid)
        }
        if (!payload.subagent_id) {
          return
        }
        switch (type) {
          case 'subagent.start':
            upsertWorker({
              subagent_id: payload.subagent_id,
              parent_id: payload.parent_id,
              depth: payload.depth,
              goal: payload.goal || payload.preview,
              model: payload.model,
              child_session_id: payload.child_session_id,
              tool_count: payload.tool_count,
              status: 'running'
            })
            break
          case 'subagent.thinking':
            upsertWorker({ subagent_id: payload.subagent_id, thinking: payload.preview || payload.text })
            break
          case 'subagent.text':
            upsertWorker({ subagent_id: payload.subagent_id, output: payload.preview || payload.text, _appendOutput: true })
            break
          case 'subagent.tool':
            upsertWorker({
              subagent_id: payload.subagent_id,
              lastTool: [payload.tool_name, payload.preview].filter(Boolean).join(' · '),
              tool_count: payload.tool_count
            })
            break
          case 'subagent.complete':
            upsertWorker({
              subagent_id: payload.subagent_id,
              status: payload.status || 'done',
              summary: payload.summary || payload.preview || payload.text,
              outputTail: Array.isArray(payload.output_tail) ? payload.output_tail : undefined,
              output: payload.summary || payload.preview || payload.text,
              _appendOutput: true
            })
            break
          case 'subagent.progress':
            upsertWorker({ subagent_id: payload.subagent_id })
            break
          default:
            break
        }
      })
    )
    // Also latch the session id from session.info events.
    const sidDisp = host.onEvent('session.info', event => {
      const sid = event && event.session_id
      if (sid) {
        eventSid.current = str(sid)
        setSessionId(str(sid))
      }
    })
    const poll = window.setInterval(() => void pollWorkers(), POLL_MS)
    return () => {
      disposers.forEach(d => d && d())
      sidDisp && sidDisp()
      window.clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sortedWorkers = useMemo(
    () =>
      [...workers].sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') {
          return -1
        }
        if (b.status === 'running' && a.status !== 'running') {
          return 1
        }
        return String(a.started_at || 0).localeCompare(String(b.started_at || 0))
      }),
    [workers]
  )

  // fix 5 — filter render only; all workers stay in state
  const filteredWorkers = useMemo(
    () => sortedWorkers.filter(w => (view === 'active' ? w.status === 'running' : w.status !== 'running')),
    [sortedWorkers, view]
  )

  const runningCount = workers.filter(w => w.status === 'running').length

  return jsx('div', {
    className: 'flex h-full flex-col',
    children: [
      // header
      jsx('div', {
        className: 'border-b border-(--ui-stroke-secondary) px-2 py-1.5',
        children: [
          jsx('div', {
            className: 'flex items-center justify-between gap-2',
            children: [
              jsx('div', {
                className: 'min-w-0',
                children: [
                  jsx('div', {
                    className: 'truncate text-xs font-semibold text-(--ui-text-primary)',
                    children: sessionId ? `Subagents · ${sessionId}` : 'Subagents'
                  }),
                  jsx('div', {
                    className: 'text-[0.6rem] text-(--ui-text-quaternary)',
                    children: sessionId ? 'read-only view — spawned workers below' : 'no active session'
                  })
                ]
              }),
              // Active/Past segmented toggle (fix 5)
              jsx('div', {
                className: 'flex shrink-0 items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5',
                children: [
                  jsx(Button, {
                    'aria-label': 'Show active workers',
                    className: 'h-5 px-2 text-[0.65rem]',
                    onClick: () => setView('active'),
                    size: 'sm',
                    variant: view === 'active' ? 'secondary' : 'ghost',
                    children: `Active${runningCount ? ` ${runningCount}` : ''}`
                  }),
                  jsx(Button, {
                    'aria-label': 'Show past workers',
                    className: 'h-5 px-2 text-[0.65rem]',
                    onClick: () => setView('past'),
                    size: 'sm',
                    variant: view === 'past' ? 'secondary' : 'ghost',
                    children: 'Past'
                  })
                ]
              }),
              jsx(Tip, {
                label: 'Refresh workers',
                children: jsx(Button, {
                  'aria-label': 'Refresh',
                  className: 'shrink-0 text-(--ui-text-tertiary) hover:text-foreground',
                  onClick: () => void refresh(),
                  size: 'sm',
                  variant: 'ghost',
                  children: jsx(Codicon, { name: 'refresh' })
                })
              })
            ]
          })
        ]
      }),

      // visible status line (instrumentation: never a bare silent return)
      status
        ? jsx('div', {
            className: 'border-b border-(--ui-stroke-secondary) px-2 py-1 text-[0.65rem] text-(--ui-text-secondary)',
            children: status
          })
        : null,

      // worker list / empty state
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto p-2',
        children: loading
          ? jsx(Spinner, { label: 'Loading workers…' })
          : !filteredWorkers.length
            ? jsx(EmptyState, {
                title: view === 'active' ? 'No active workers' : 'No past workers',
                description:
                  view === 'active'
                    ? 'Post a delegate_task fan-out from the orchestrator session and live worker cards appear here: goal, model, status, streaming thinking, tool lines, and accumulated output.'
                    : 'Finished, interrupted, and errored subagents appear here with their final output ready to copy.'
              })
            : jsx('div', {
                className: 'flex flex-col gap-2',
                children: [
                  jsx('div', {
                    className: 'text-[0.6rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)',
                    children: view === 'active'
                      ? `${filteredWorkers.length} worker${filteredWorkers.length === 1 ? '' : 's'}${runningCount ? ` · ${runningCount} running` : ''}`
                      : `${filteredWorkers.length} past worker${filteredWorkers.length === 1 ? '' : 's'}`
                  }),
                  ...filteredWorkers.map(w =>
                    jsx(WorkerCard, {
                      key: w.subagent_id,
                      onCopied: msg => setStatus(msg),
                      sessionId,
                      worker: w
                    })
                  )
                ]
              })
      })
    ]
  })
}

// ── plugin export ────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Subagent Viewer',
  version: '0.1.0',
  description: 'Read-only Subagent Viewer for Hermes Desktop: live worker cards (goal, model, status, streaming thinking/tool/output), Active/Past toggle, and full-output copy. MVP subset of the in-development Chief of Staff fan-out plugin — observes, never steers or interrupts.',

  register(ctx) {
    ctx.register({
      id: 'subagent-viewer-pane',
      area: 'panes',
      title: 'Subagent Viewer',
      data: {
        placement: 'right',
        width: 380
      },
      render: () => jsx(PaneRoot, {})
    })
  }
}
