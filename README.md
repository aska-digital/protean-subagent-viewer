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
- **Ownership-gated viewing** — follows the active session id; cards stream
  for the orchestrator that spawned the fan-out.

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

- Hermes backend **v0.21.0+** exposing the `subagent.*` event stream (incl.
  `summary` and `output_tail` on `subagent.complete`) and a live worker list.
  The pane ladders between `session.info` (carrying `active`) and
  `delegation.status` — whichever the backend serves.
- Workers are REAL subagents spawned by `delegate_task`. This plugin never
  spawns anything; it observes and copies.
- No telemetry. All state is local to the running desktop process.

## Scope guards

- Does not touch the room log / group-chats localStorage.
- Does not auto-spawn, steer, or interrupt anything.
- No telemetry, all local.
