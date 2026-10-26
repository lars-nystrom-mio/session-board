# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One user, the developer who runs it, at a Windows desktop. The board stays open
in a browser beside the terminals where many Claude Code sessions run at once,
usually 8–20 live sessions across 3–6 projects.

## Product Purpose

Show at a glance what every running Claude Code session is doing, and make the
one that needs you impossible to miss. It also runs a queue of Azure DevOps work
items, starting each one as a session when its project has a free slot.

## Operating Context

- A Claude Code mod writes one status file per session; the page polls them
  every 2 s. It's a glance-and-return surface, not one you work inside.
- Sessions span several repos and ADO work items at once; delivery runs start
  from the queue.
- Served locally by `python -m http.server` or `server/serve.py`.

## Capabilities and Constraints

- One self-contained static HTML page, no build step and no framework.
- It must still work under plain `python -m http.server`; anything that needs
  `server/serve.py` (the queue) appears only when that server answers.
- Tiles are keyed by session id and keep their place between polls; layout must
  not reshuffle on heartbeats or busy/idle changes.
- View preferences live in `localStorage`, so they belong to one browser.

## Product Principles

- The session that needs you is never hidden.
- Stability over freshness: nothing moves unless its meaning changed.
- Dense and quiet: it sits in peripheral vision all day.
