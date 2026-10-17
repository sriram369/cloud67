# Changelog

## 0.2.1 — 2026-10-16

- Search and select public repositories by name or description, with account filtering and URL entry preserved.
- Cache a sanitized public repository catalog in D1; the trusted runner refreshes it hourly without exposing GitHub credentials or consuming model calls.
- Reject private or out-of-account catalog entries and retain the last good catalog when refresh fails.

## 0.2.0 — 2026-10-16

- Replace the custom coding loop with OpenHands SDK 1.55.1 in an isolated cloud sandbox.
- Make repository conversations, follow-ups, tool activity, and workspace diffs the primary interface.
- Verify repository access before queuing; retain unresolved prototype requests as history.
- Persist actual SDK checkpoints and workspace patches across cloud jobs.
- Add a scoped native-tool model gateway using Workers AI Qwen3 30B and optional verified free-only OpenRouter fallback.
- Separate read-only inspection from edits, independently verify edits, and keep publishing credentials outside agent execution.
- Add conversation, credential boundary, checkpoint, and actual SDK persistence tests.

## 0.1.1 — 2026-10-16

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
