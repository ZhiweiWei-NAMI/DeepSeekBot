---
Status: Implemented; pending upstream review
Date: 2026-10-15
---

# A one-shot model advisor for Bot-scoped Subagent dispatch

A PersonaBot can opt into one structured model-selection request per eligible delegation.
The advisor suggests an existing Assignment model/effort pair; it is not a planner or an
additional permission authority. The default is **off**. Explicit model fields bypass it.

## Authority and lifecycle

- `assignmentModelsOf`, `selectAssignmentRoute`, and `resolveSubagentRoute` remain the
  authorization boundary. The advisor returns an enumerated candidate id, never an arbitrary route.
- Candidates are expanded in plan order. Zero or one candidate makes no request. There is no
  candidate-count cap, cache, single flight, retry, recursive advice, or cross-task answer reuse.
  The serialized state has a 24,000-byte budget; oversized state falls back without a request.
- The response must identify a candidate and supply finite confidence in `[0, 1]`, at least `0.5`.
  This threshold is a heuristic, not a calibrated quality guarantee.
- An eligible request has a 4,000ms advisor deadline, including credential lookup. A late result
  is discarded, and an expired credential lookup cannot start a later network request. This is
  not a deadline for the entire child lifecycle or for subsequent route probes.
- The switch is read at dispatch preparation, not captured when the parent Agent is created.
  The plan is re-read after asynchronous advice and route probes, including a final allowlist
  check after the last await. Revoked routes cannot be used to start a child.
- Tool Approval, Workspace Grants, budgets, depth limits, and Subagent guards are unchanged.

## Fallback and observability

The advisor's fallback result uses the plan's Assignment default. Dispatch itself follows the
existing no-fields resolution: inherit the parent route if still allowed, otherwise use the
Assignment default. An unavailable suggestion gets one fallback to that resolution and a probe
of the fallback route; when it is the same failed route, the original error is propagated.
A changed plan can require another route probe before the final allowlist check.

Fallback reasons are bounded codes:

```text
disabled | no-plan | single-candidate | state-budget
timeout | transport-error | invalid-response | unknown-candidate
invalid-confidence | low-confidence | not-allowed | cancelled
suggested-route-unavailable
```

Structured records go through the injected sink and `ctx.logger`. They contain source, reason,
tool, plan revision, route, call count, latency, candidate count, label hash, and optional candidate
id/confidence. The dispatch layer can emit a separate `suggested-route-unavailable` record.
Raw task text and credential values are not logged. There is no cache or `cached` field.

## Transport and privacy

The implementation pins `jev-1.13-free` and
`https://opencode.ai/inference/v1/systemone`, uses one System One `choice` question, refuses
redirects, and bounds response reads to 64,000 bytes. It resolves the credential reference
`OPENCODE_CONSOLE_API_KEY` through the platform credential service, never a credential file.

The production wiring sends no prompt body or fork context. It sends the tool name, a bounded
label, and the configured candidate list, including candidate notes. Labels and notes pass through
known-secret-pattern redaction; labels are truncated to 500 characters. Redaction is **not** a
proof that arbitrary free text contains no private information: do not put sensitive information
in delegation labels or model notes when enabling a third-party advisor.

Missing credentials, transport failure, malformed answers, and low confidence lead to the bounded
fallback. External availability, terms, pricing, and selection quality are not established by the
offline tests. This feature must not become a correctness dependency.

## Settings and CLI

The implementation includes both the Client switch and Host persistence:

| Surface                                | Contract                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| PersonaBot record, detail, and summary | `subagentAdvisor?: boolean`; only `true` is stored/exposed, absence means off                                                |
| Bridge RPC                             | `subagentAdvisorSet({ slug, enabled })` returns the updated Bot detail; disabling removes the field                          |
| Client                                 | Native switch in the model-preset settings; no separate store or permission grant                                            |
| CLI                                    | `deepseekbot advisor-enable <id>` / `deepseekbot advisor-disable <id>`; offline registry via `--home`, Host RPC via `--host` |

See [CLI guide](../bot-cli.md) and
[ADR-0212](../adr/0212-a-subagent-model-advisor-may-only-pick-from-the-allowed-set.md).
Disabling the switch stops advice on subsequent preparations; it does not cancel a child already
started. Reverting the feature needs no data migration; the opt-in field is optional.

## Offline verification

```bash
pnpm vitest run packages/core/test/subagent-advisor.test.ts \
  packages/core/test/subagent-model-tools.test.ts \
  packages/core/test/subagent-advisor-rpc.test.ts \
  packages/client/test/subagent-advisor-contract.test.ts \
  packages/client/test/subagent-advisor-setting.test.tsx
pnpm typecheck
pnpm lint
pnpm format:check
```

Tests cover enumeration, budgets, timeout/late credentials, response validation, per-dispatch
isolation, explicit-route bypass, dynamic toggling, plan revocation, RPC/CLI persistence, and Client
parsing. The capture fixture uses an in-memory bridge and blocks external requests; it is not
live Host/provider evidence. Run results belong to the exact reviewed commit's CI/PR evidence,
not to a permanent test count in this contract.

## Provenance

The design adapts the structured choice approach from the MIT-licensed `dsh-auto` prototype
(© 2026 Zhiwei Wei). BotHarness is MIT-licensed (© 2026 BotHarness). Protocol ideas were reused,
not copied source files. No claim is made that advisor routing outperforms native routing.
