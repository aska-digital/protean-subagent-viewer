# Subagent Viewer — Hermes Desktop (MVP)

A read-only **Subagent Viewer** pane for Hermes Desktop. It turns the agent's
async subagent fan-out into a live card view: every spawned worker shows up as
its own card with its goal, model, status, streaming thinking, latest tool
line, and accumulated output — plus an **Active/Past** view toggle and a
**Copy output for forward** button for JIT handoff.

This is the **MVP subset** of a larger in-development fan-out plugin
(**Chief of Staff**). The viewer slice is deliberate: the user verified LIVE
that viewing spawned subagents works perfectly, while the steer / interrupt /
orchestrator-control features were not yet reliable. This fork keeps the
verified viewer and strips everything else. It **observes and copies only** —
it never steers, interrupts, spawns, or mutates the orchestrator session.

## Features

- **Live worker cards** — one card per spawned subagent, keyed by
  `subagent_id`, showing:
  - goal + status badge (`running` / `done` / `interrupted` / `errored`)
  - worker model (read-only, delegation-resolved)
  - streaming **thinking** (collapsible, capped ~2KB)
  - latest **tool** line
  - **accumulated** output preview (every `subagent.text` chunk appended,
    never overwritten) with a show-all toggle
- **Active/Past toggle** — split the view between running workers and
  finished/interrupted/errored ones. All workers stay in state; only the
  render is filtered.
- **Full-output copy** — "Copy output for forward" grabs the worker's
  **complete final answer**, extracting the full `final_response` from the
  orchestrator's live session history and falling back to the event summary,
  then the last tool results, then the accumulated buffer.
- **Session-scoped viewing** — follows the focused runtime session (the active
  session on older hosts). Cards and buffers reset on a focus/source change;
  polling repopulates that session's current roster. Events from other sessions
  are ignored, and copy reads the card's owning runtime session history.

## Install

The plugin root is profile-aware — copy `plugin.js` into the desktop plugin
root of the profile you run:

```sh
# ACTIVE profile root (e.g. halakukhan) — the one the desktop loads
mkdir -p ~/.hermes/profiles/halakukhan/desktop-plugins/subagent-viewer/
cp plugin.js ~/.hermes/profiles/halakukhan/desktop-plugins/subagent-viewer/plugin.js
```

Then find **Subagent Viewer** in the ⌘K palette (PLUGINS header) and open the
right-hand pane. Each `plugin.js` is fs-watched, so edits reload live.

## Usage

1. In the orchestrator session, post a `delegate_task` fan-out. Worker cards
   appear live as the subagents spawn.
2. **Watch**: goal + status badge, streaming thinking, latest tool line, and
   accumulated output.
3. **Toggle** Active/Past to review finished workers.
4. **Copy**: "Copy output for forward" puts a worker's full final answer on
   your clipboard for handoff.

Empty state (no active workers) explains the flow.

## Requirements

- Hermes backend exposing `subagent.list({session_id})` and the `subagent.*`
  event stream (including `summary` and `output_tail` on `subagent.complete`).
  The runtime/UI id from the desktop is the owner key for roster, history, and
  events; durable conversation ids and child ids are different identifiers.
  A backend without the scoped roster RPC shows an unavailable state. The
  viewer never falls back to the global `delegation.status` registry.
- The SDK's `host.request` uses the active gateway. A focused tile owned by a
  different source/profile shows an empty state until that gateway is active;
  the viewer does not guess a route to another source.
- Workers are REAL subagents spawned by `delegate_task`. This plugin never
  spawns anything; it observes and copies.
- No telemetry. All state is local to the running desktop process.

## Scope guards

- Does not touch the room log / group-chats localStorage.
- Does not auto-spawn, steer, or interrupt anything.
- No telemetry, all local.

## Validation

Run `node --test tests/session-scope.cjs` to execute the checked-in plugin with
synthetic session data and host/React lifecycle mocks, including delayed polls,
queued state updates, focus changes, global event filtering, and full-output
copy. These tests and a read-only SDK contract check validate the scope logic;
they do not establish live desktop acceptance for this change.

Manual acceptance still required: in the desktop, open two orchestrator sessions
with distinct workers, switch focus during a poll and a copy, confirm active and
past cards remain scoped, switch back, and verify copied output belongs to the
selected card's session. No live installation is performed by the test suite.
