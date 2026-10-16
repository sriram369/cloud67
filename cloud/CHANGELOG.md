# Changelog

## Unreleased

- Identify runner HTTP requests as Cloud67 so Cloudflare accepts the service client.
- Request structured coding actions and accept Workers AI's object response format, preventing invalid multi-action text from exhausting a task's action limit.
- Set the shared application allowance to fifteen bounded Workers AI calls per day; Cloudflare's free account quota remains authoritative.

## 0.1.0 — 2026-10-16

- Deploy an authenticated Cloudflare-native dashboard alongside the preserved Odysseus app.
- Persist threads, messages, task queues, execution leases, and run activity in D1.
- Route inference through a bounded Workers AI allowance and optional verified free-only OpenRouter fallback.
- Add a scoped GitHub Actions coding harness, isolated Python tests, and branch publication with an owner-controlled PR link.
- Add free-routing, authentication, cancellation, database, and filesystem-boundary tests.

The cloud edition currently supports Python edits in `cloud/agent-workspace/`. Broader repository execution, parallel agents, and the full Odysseus application are separate milestones.
