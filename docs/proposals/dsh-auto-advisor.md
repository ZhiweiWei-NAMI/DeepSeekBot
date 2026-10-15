---
Status: Draft for review
Date: 2026-10-15
Issue: pending (local branch `feature/dsh-auto-advisor`; no public issue or PR yet)
Origin: user-owned `dsh-auto` / `magpie-auto` Jev routing prototype
---

# A one-shot model advisor in front of Bot-scoped Subagent dispatch

## Why

A PersonaBot already carries an Assignment model set (`modelPlan.assignmentModels`): the
provider/model/effort pairs the Human allowed for that Bot. When the model delegates, it must
pick one pair for the child — either explicitly, or by omitting the fields and inheriting the
parent route (falling back to `assignmentDefault` when the parent route is outside the set).

That choice is capability work the orchestrating model does on every dispatch. The user's
`dsh-auto` prototype solved the same problem with a scoring/selection model (`jev-1.13-free`
served by the OpenCode **System One** primitives) rather than free-form text: a single
structured call returns a **choice**, not a plan. This proposal ports exactly that idea, and
nothing else, into BotHarness.

## What this is not

- **Not a permission.** The advisor never grants access, never widens the Assignment set, never
  touches Tool Approval rules, Workspace Grants, budgets, depth limits, or the `subagent` /
  `subagent_fork` guard. It only proposes a route that the existing allowlist already accepts.
- **Not a planner.** No free text, no multi-round dialogue, no recursion: one request, one
  answer, one decision.
- **Not a new authority.** Behavior with the advisor disabled — the default — is byte-for-byte
  the current behavior.
- **Not a frontend change.** The per-Bot opt-in switch is a separate PR (see
  [Frontend contract](#frontend-contract--handed-to-the-client-pr)).

## Origin evidence

| Claim | Source |
| --- | --- |
| `jev-1.13-free` is a free scoring/selection model, not a text generator | user repo `dsh-auto/README.md` ("Jev 是评分/选择模型，不生成自由文本任务计划") |
| Wire endpoint, auth scheme, body fields (`model`, `state`, `questions`) | `jev_opt/jev-free-check/jev_free.py:21-25,87-114` and `docs-verification.json` |
| Question kinds `noul` / `choice` / `score` | `docs-verification.json` → `docs.typesafe.ai/primitives/{noul,choice,score}` |
| `choice` answers are `{ choice: <criterion key>, confidence: number }` | `dsh-auto/decisions.js:51` (`owner.choice === 'shared'`, `owner.confidence`) |
| Candidate-fit ranking that treats the candidate list as data | `dsh-auto/routing.js:12-14,34-42` |
| Confidence threshold gate before acting | `dsh-auto/routing.js:24-25,39` |
| Fixed model / fixed endpoint refusal, no redirect, no retry | `jev_free.py:95-96,104,257` |
| State byte budget as a transport bound | `dsh-auto/decisions.js:1-3` (`STATE_BYTES = 24000`) |

Upstream target re-verified on 2026-10-15: `git ls-remote https://github.com/BotHarness/DeepSeekBot`
returned HEAD `06d952f67786d66bee232df4cc70ccb06ac56c02`. Both repos are MIT
(BotHarness © 2026 BotHarness; `dsh-auto` © 2026 Zhiwei Wei), so reuse is compatible.

## Backend boundary

Everything lives behind the existing Bot-scoped Subagent seam. The two seams that already exist
and are **not** modified in their contract:

- `packages/core/src/models/presets.ts` — `assignmentModelsOf`, `selectAssignmentRoute`,
  `PersonaBotModelPlan`. The single source of truth for "what this Bot may use".
- `packages/core/src/models/subagent-route.ts` — `resolveSubagentRoute`. The single place a
  parent route is checked against the plan.

New file, framework-free and dependency-injected so the whole decision is testable offline:

```
packages/core/src/models/subagent-advisor.ts
```

Wiring, a small diff:

```
packages/core/src/runtime/subagent-model-tools.ts   (installBotSubagentModelTools gains an optional 4th argument)
```

No new Host bridge method, no new `/api` route, no new Bot tool — so the CLI-parity check
(`scripts/check-cli-parity.mjs`) gains no obligation from this PR. The follow-up PR that adds the
per-Bot switch **does** owe a `deepseekbot` CLI command for whatever bridge method it introduces.

### Decision flow (advisor enabled, caller omitted model fields)

1. `plan === undefined` → no advisor; unchanged behavior.
2. Candidate set = `assignmentModelsOf(plan)` expanded to `(provider, model, effort)` triples in
   plan order. `≤ 1` candidate → fallback, **zero** advisor calls.
3. No cache and no single flight. The advisor is a per-dispatch decision, so every dispatch
   preparation that reaches this step makes exactly **one** request and nothing is reused across
   dispatches — a different task can never receive another task's answer.
4. Build one System One `choice` question over the candidates, serialized under a byte budget,
   and send it through the injected transport with `AbortSignal.any([caller, timeout])`.
   Exactly **one** attempt; there is no retry path.
5. Validate the answer: `answers.route.choice` must equal an enumerated candidate id and
   `answers.route.confidence` must be a finite number in `[0, 1]` at or above
   `ADVISOR_MIN_CONFIDENCE`. Anything else → deterministic fallback.
6. `selectAssignmentRoute(plan, candidateRoute)` re-derives the route. It **throws** for anything
   outside the set, which downgrades to a fallback. The advisor cannot mint a route.
7. The wiring probes the final route with the existing `llm.resolveCallConfig`. If the
   *suggested* route is unavailable, it falls back once to the ordinary no-fields resolution —
   the parent route when the current plan still allows it, otherwise the Assignment default — and
   probes that route. If the re-resolution yields the route that just failed, the original error
   propagates unchanged.
8. Every path emits one structured record.

### Fallback is deterministic and closed

`AdvisorFallbackReason` is a closed union; each value names exactly one trigger:

```
disabled | no-plan | single-candidate | state-budget
timeout | transport-error | invalid-response | unknown-candidate
invalid-confidence | low-confidence | not-allowed | cancelled
suggested-route-unavailable
```

Every route the advisor itself reports on a fallback is
`selectAssignmentRoute(plan, plan.assignmentDefault)`. The dispatch layer is deliberately less
clever: it re-resolves with no model fields, which is exactly the pre-existing
`resolveSubagentRoute` behavior, so a dispatcher whose parent route is still allowed keeps that
route and everyone else lands on the Assignment default. No path invents a route, and no path
retries the advisor.

Before the child starts, the plan is read again and the chosen route is re-validated against the
current allowed set. A model revoked while the advisor or the probe was in flight cannot be
started, and a route that had to change is probed once more before it is used.

### Observability

One record per decision, written through an injected bounded sink (no task text, no secrets):

```
{ plugin, owner: 'bot:<slug>', kind: 'subagent-model-advisor',
  detail: { source, reason, tool, planRevision, candidateId?, confidence?,
            route, cached, calls, latencyMs, candidates, labelHash } }
```

The wiring emits it through `ctx.logger` in this PR. Routing it onto the operational log surface
(`logs.db`, read with the `reading-operational-logs` skill) belongs with the config PR, which is
where the Host has the log handle in scope.

### Cost and blast radius

- Advisor requests per dispatch preparation: **at most one**, on every path, with no retry.
- Worst case added latency: `ADVISOR_TIMEOUT_MS = 4000` once, then a fallback.
- Reverting the PR restores current behavior with no data migration: nothing persists at all.

## Frontend contract — handed to the client PR

This PR defines the switch but does not build it. The client PR (GLM) needs:

| Item | Contract |
| --- | --- |
| Per-Bot switch | `subagentAdvisor?: boolean`, default **off**, stored on the PersonaBot record next to `modelPlan` — **already implemented** in this PR (`packages/core/src/bots/registry.ts`) |
| Read model | surfaced on the Bot detail snapshot as `subagentAdvisor` — **already implemented** (`packages/core/src/bridge/methods.ts`) |
| Bridge method | `subagentAdvisorSet({ slug, enabled })` returning the updated Bot detail — **already implemented** |
| CLI parity | `deepseekbot advisor-enable <id>` / `deepseekbot advisor-disable <id>` — **already implemented**, offline through `--home` and against a live Host through the registered RPC (`packages/core/src/bots/bot-create-cli.ts`, `packages/core/src/bots/cli-management.ts`, documented in `docs/bot-cli.md` and `docs/bot-cli.zh.md`) |
| RPC registration | `subagentAdvisorSet` is exposed on the bridge service and marked as a remote method (`packages/core/src/bridge/rpc.ts`) |
| Switch timing | the flag is read on every dispatch preparation, so turning it off stops the advisor immediately |
| Credential | the advisor resolves the reference `OPENCODE_CONSOLE_API_KEY` through the platform credential service; nothing is read from a credential file directly |
| UI | a checkbox in the existing model-preset/Bot settings surface, with one line: "Let an advisor suggest one of this Bot's allowed model/effort pairs per delegation. Suggestions never widen the allowed set." |
| Copy honesty | must not claim measured quality improvement; only that selection is delegated |

What is left for the client PR is only the checkbox and its copy. The backend switch already
works without any UI: `deepseekbot advisor-enable <id>` turns it on, and the untranslated advisor
then runs on that Bot's next delegation. Until the credential reference above is populated the
transport refuses, the advisor records `transport-error`, and dispatch falls back to the
Assignment default — observable, never silent.

## Test plan (offline, no network)

`packages/core/test/subagent-advisor.test.ts` — unit, injected transport and clock:

- candidate expansion is deterministic, ids stable, and every candidate round-trips through
  `selectAssignmentRoute`
- `disabled`, `no-plan`, `single-candidate`, `over-candidate-cap` → fallback with **zero** calls
- happy path returns an advisor route that is in `assignmentModelsOf(plan)`
- `unknown-candidate`, `invalid-confidence`, `low-confidence`, `invalid-response` → fallback
- transport rejection mapped to `timeout` vs `transport-error`, each with exactly **one** call
- one request per dispatch: three sequential dispatches make three requests, with no cross-task
  reuse of an earlier answer
- a wide plan (20 models × 16 efforts) still makes one request, because there is no candidate cap
- no-secret: a label carrying `Bearer …` / `sk-…` / `api_key=…` never reaches the transport
  verbatim; with `includeTaskExcerpt: false` the prompt body never reaches it at all
- candidate `note` text cannot inject a criteria key or escape the enumerated ids

`packages/core/test/subagent-model-tools.test.ts` — wiring:

- advisor enabled + candidate `c1` → child starts on `c1`, probed once
- explicit `provider`/`model`/`reasoning_effort` in the tool args → advisor **not** consulted
- advisor proposal outside the plan → `selectAssignmentRoute` still refuses, child not started
- suggested route unavailable, default available → one deterministic fallback, reason recorded
- no advisor option → existing behavior and the existing test unchanged

## Open decisions for review

1. **Availability fallback.** Falling back from an unavailable *suggestion* to
   `assignmentDefault` means one dispatch can probe two routes. The alternative — fail hard —
   preserves today's semantics exactly. Flagged for the Human.
2. **Task detail.** This PR sends no prompt body (`includeTaskExcerpt: false`), only the tool's
   short task label. The label is not structurally guaranteed secret-free, so it is redacted and
   truncated before it leaves the process.
3. **Model id.** Pinned to `jev-1.13-free` exactly as the prototype did, including the refusal to
   talk to any other endpoint or model.
