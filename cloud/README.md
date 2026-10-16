# cloud67 — free cloud edition

An initial Cloudflare-native release alongside the preserved Odysseus application. This directory does not port or deploy every feature of the original Python application.

## Architecture

- Cloudflare Worker: owner login, dashboard, chat, task API, free-only inference routing.
- D1: threads, messages, task state, execution leases, event history, usage reservations.
- Workers AI: a fixed model with bounded context/output and fifteen application calls per UTC day. Coding actions use a JSON schema; chat uses plain text.
- OpenRouter: optional fallback using only `openrouter/free`. Current zero pricing must be verified before inference; zero-price provider bounds are also sent. Twenty application calls per UTC day. Provider limits are separate.
- GitHub Actions: one bounded repository coding job per run on a standard Ubuntu runner. Scheduled starts are best-effort, not an immediate execution guarantee. No paid runner, artifact uploads, or cache allocation is configured.

The first coding harness edits Python files only in `cloud/agent-workspace/`, runs standard-library tests in a read-only, no-network Docker container, and publishes a branch with a link for the owner to review and open a PR. It has at most eight agent actions and a ten-minute task execution limit. The workflow has a 15-minute timeout. It cannot launch a large agent fleet or run arbitrary repositories.

## Security and costs

The dashboard requires an owner password. Sessions use signed, Secure, HttpOnly, SameSite cookies. API writes check origin. Runner requests require a separate server-side token; task actions require a live lease. Model-generated code receives neither that token nor GitHub credentials. Tests execute in a container without networking, host control sockets, or platform credentials. File access is confined to the allowed work directory.

No paid model is selected. Free-service exhaustion stops inference. Application reservations count failed attempts conservatively. Cloudflare's account quota may also be used by other apps. On a paid Cloudflare account, account-wide usage beyond included allowances can still incur charges; this project cannot control other account usage. Use a Free plan and account billing limits for a strict zero-spend account policy.

OpenRouter's key is not required for the default Workers AI route. Add it only as the Worker secret `OPENROUTER_API_KEY`; never place it in source, workflow YAML, browser storage, or chat. Provider quotas and the free catalog can change. No key rotation or account cycling is implemented to bypass quotas.

## Run checks

Requires Node.js 24 and Python 3.12 or later. Tests have no third-party dependencies.

```bash
cd cloud
npm run check
npm test
python3 -m unittest discover -s test -p 'test_*.py' -v
```

Local tests exercise SQL through Node's SQLite runtime. Verify the deployed Worker and D1 endpoints separately; these tests do not replace a Workers runtime smoke test.

## Deployment configuration

`deployment.json` records the Worker name, compatibility date, observability settings, and non-secret variables. Deploy ESM modules `worker.mjs`, `free-router.mjs`, and `ui.mjs` using the Cloudflare Workers upload API with this metadata and bindings:

- `DB`: D1 database, initialized with `schema.sql`.
- `AI`: Workers AI binding.
- `SESSION_SECRET`: random signing secret.
- `ADMIN_PASSWORD_HASH`: SHA-256 hex digest of a high-entropy generated workspace password.
- `RUNNER_TOKEN`: independent random runner secret.
- `OPENROUTER_API_KEY`: optional secret, added only when supplied by the owner.

The local `.cloud67/` directory is ignored and may contain machine-local deployment/login information. Never commit it. Re-deployments must preserve secrets or explicitly reattach the existing bindings.

To connect the GitHub Actions runner, set repository variable `CLOUD67_URL` to the live HTTPS URL and repository secret `CLOUD67_RUNNER_TOKEN` to the matching Worker secret. Enable the `Cloud67 coding runner` workflow. The workflow requests contents write permission for branch publication and does not request review-approval permission. Set the Worker variable `RUNNER_ENABLED` only after configuration is verified.

The scheduled workflow must be present on the default branch to run on schedule. Before merge, its pull request contains the pending runner setup. `workflow_dispatch` availability is subject to GitHub's default-branch workflow requirements.

## Operations

- Inspect Worker logs and GitHub Actions runs for failures; neither logs nor prompts contain the secret values by design.
- Task event polling occurs only while the authenticated dashboard is visible.
- An expired lease fails the task rather than silently replaying a possibly published change.
- A cancelled task cannot make new model requests. An already-running test can run until its 120-second timeout. Cancellation does not undo a remote GitHub write already in flight.
- Publication returns a compare link; PR creation remains an owner action under the existing repository policy.
- To stop the system, disable the Actions workflow, cancel queued tasks, and revoke the runner secret. Keep D1 for history.
- Rollback: redeploy the preceding Worker modules while retaining bindings and data. Code rollback does not undo PRs or task changes.

## Sources

- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions): standard runners are free for public repositories; larger runners and excess storage have separate costs.
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
- [OpenRouter free router](https://openrouter.ai/openrouter/free).
- [OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

This release remains part of the AGPL-3.0-or-later Cloud67 fork. Original Odysseus code, licenses, notices, and history are preserved.
