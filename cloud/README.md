# Cloud67 — OpenHands conversations

Cloud67's browser workspace connects repository conversations to the real **OpenHands SDK 1.55.1**. The former custom JSON-action coding loop has been removed from the cloud runner. The original Odysseus application and its history remain preserved elsewhere in this repository.

The frontend is Cloud67's own conversation client. This deployment uses the OpenHands SDK, tools, events, and persistence; it does not claim to deploy the entire Agent Canvas/Agent Server product on Cloudflare Workers.

## What runs where

- **Cloudflare Worker:** owner login, repository access checks, conversations, queued turns, activity, patches, and a scoped OpenAI-compatible model gateway.
- **D1:** durable conversation records, turns, events, model reservations, and SDK checkpoints.
- **Standard public GitHub Actions runner:** trusted job controller and branch publisher.
- **Unprivileged Docker container:** the OpenHands SDK and its terminal/file tools. No GitHub publishing token, owner session secret, or runner token enters this container.
- **Workers AI:** Qwen3 30B with native tool calling. Fifteen application calls per UTC day, at most eight per turn, bounded context and output. The earlier chat endpoint retains its fixed model; both share the same application allowance.
- **Optional OpenRouter:** only `openrouter/free`, after verifying zero catalog prices and sending zero-price provider bounds. Twenty application calls per day. No paid fallback.

## User flow

1. Attach a full GitHub repository URL. Cloud67 verifies access and pins its default-branch revision before creating the conversation. An unresolved name such as `frd02` produces an actionable error and does not queue work.
2. Choose **inspect**, which mounts the public repository read-only, or **edit**, which currently supports the connected `sriram369/cloud67` repository and requires an owner-specified verification command.
3. Send a message. OpenHands executes a conversation turn in the cloud. Actual tool calls, results, model usage, verification, and publication appear in Activity.
4. Send follow-ups in the same conversation. SDK state and workspace patches are restored into a fresh sandbox at the same repository revision.
5. For edits, the trusted controller independently runs the configured verification command in a no-network container. A nonempty verified patch can be published to a branch in the connected repository. The owner opens the PR using its compare link. Protected workflow, credential, and environment files require owner review rather than automatic publication.

Runner pickup is **job-based**, best-effort on a five-minute schedule. The UI links to the workflow for a manual start. It is not an always-on interactive VM or an immediate-start guarantee. A repository-scoped GitHub App dispatch integration would be needed for automatic immediate starts; no broad personal token is copied into Cloudflare.

Private repository sandbox checkout is not connected. Another public repository can be inspected, while editing/publishing is restricted to the configured repository. Repository revisions stay pinned within a conversation; create a new conversation to inspect a newer snapshot.

Earlier prototype tasks and their failures remain in **Earlier prototype runs**. They are not represented as successful OpenHands conversations. The unresolved `frd02` request is preserved with an explanation that its repository URL is needed.

## Checks

```sh
node --test cloud/test/*.test.mjs
python3 -m unittest discover -s cloud/test -p 'test_*.py' -v
# In an isolated Python 3.13 environment with the pinned SDK dependencies:
python cloud/test/sdk_smoke.py
```

The SDK smoke test uses a local mock LLM and actual SDK file tools to check native tool calling and a persisted follow-up. It does not prove live-model quality. Verify actual inference and Docker execution in a cloud workflow separately.

## Deploy and operate

Apply the additive `schema.sql` migration to D1. Upload ESM modules `worker.mjs`, `ui.mjs`, `free-router.mjs`, `agent-gateway.mjs`, and `conversations.mjs`. Preserve existing bindings and secret values on updates.

Bindings: `DB`, `AI`, `REPOSITORY`, `RUNNER_ENABLED`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `RUNNER_TOKEN`. Optional: `OPENROUTER_API_KEY`. GitHub repository variable `CLOUD67_URL` and secret `CLOUD67_RUNNER_TOKEN` connect the trusted controller. Its workflow requests contents-write permission for publication and no PR-review approval permission.

The sandbox model key is scoped to one active turn and grants only bounded model requests. Cancellation fences new requests; the trusted controller checks the lease every five seconds while the agent runs. Code cannot mount a Docker socket or access the host filesystem. Git metadata is mounted read-only. Sandbox network access is available for model calls and public dependencies; no platform credentials are exposed there. Verification runs with networking disabled.

Free-service exhaustion stops work. Neither app limits nor this code can prevent charges from unrelated services on a paid account. Keep the account on a Free plan for the stated zero-spend constraint. No paid Cloudflare Containers or larger GitHub runners are configured.

Disable the workflow to stop execution. D1 retains history and checkpoints. Roll back by redeploying previous modules while preserving the additive tables and secrets. `.cloud67/` is ignored local deployment state and must never be committed.

## Upstream

- [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk), pinned at 1.55.1, MIT; its packages retain their upstream notices and licenses.
- [OpenHands architecture](https://docs.openhands.dev/overview/introduction).
- [Odysseus](https://github.com/odysseus-dev/odysseus), preserved AGPL-3.0-or-later foundation; see the repository license and provenance files.
- [Workers AI model](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/).
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Cloud67 remains an AGPL-3.0-or-later fork; using the MIT SDK does not remove the existing project's notices.
