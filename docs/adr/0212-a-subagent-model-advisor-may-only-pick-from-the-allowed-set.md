---
Status: Proposed
Date: 2026-10-15
---

# A Subagent model advisor may only pick from the Assignee's allowed set

A PersonaBot's Assignment model set (`modelPlan.assignmentModels`) is the Human's authorization:
which provider/model/effort pairs a Bot may delegate to. Choosing among them per dispatch is
capability work every orchestrating model repeats. The user's `dsh-auto` prototype answers the
same question with a structured scoring call (`jev-1.13-free` over the OpenCode **System One**
`choice` primitive) instead of free text.

## Decision

When a Bot's advisor opt-in is on and the caller omitted all model fields, one bounded advisor
call may propose a candidate **by id** — never by writing a route.

- **The advisor has no authority.** Its answer is validated as an id in the enumerated candidate
  set, then re-resolved through `selectAssignmentRoute` against `assignmentModelsOf(plan)`. A
  proposal outside the set is refused exactly as an explicit model request would be. It cannot
  change Tool Approval, Workspace Grants, budgets, depth limits, or the tool guard.
- **One call, no recursion.** One `choice` question per dispatch preparation. No retry, no
  multi-round dialogue, no advisor inside an advisor. A response that is not a valid enumeration
  member, or is under the confidence threshold, falls back deterministically.
- **The fallback stays inside what the Human allowed.** The advisor's own fallback route is
  `selectAssignmentRoute(plan, plan.assignmentDefault)`; the dispatch layer then re-resolves with
  no model fields, which is the pre-existing `resolveSubagentRoute` behavior (parent route while
  the current plan allows it, otherwise the Assignment default). Nothing is cached: the advisor is
  a per-dispatch decision, so a dead advisor costs one bounded attempt on that dispatch and cannot
  make a later dispatch reuse another dispatch's answer.
- **The decision is re-validated before it is used.** The plan is read again after the advisor and
  the probe have returned, and the chosen route must still be allowed — a model revoked while the
  dispatch was in flight cannot be started. The advisor request, including credential lookup,
  runs under one deadline; an answer that arrives after it is discarded rather than used.
- **Config decides, not the model.** The advisor is off unless a per-Bot opt-in enables it and a
  Host supplies a transport. With it off, behavior is unchanged.
- **Minimize external task data.** Only the tool name, a redacted and bounded task label, and the
  Bot-configured candidate list (including redacted notes) leave the process. Known-pattern
  redaction cannot guarantee that arbitrary free text is secret-free; sensitive labels and notes
  must not be sent. The prompt body is not sent by default; the transport pins the endpoint/model
  and refuses redirects.

## Consequences

- Selection quality is delegated to a model nobody has calibrated against this workload. The
  README of the prototype explicitly refuses to claim that Auto beats native routing; this ADR
  inherits that honesty. The change is a scheduling convenience, not a measured improvement.
- An unavailable _suggestion_ may cause an extra `resolveCallConfig` probe through the existing
  no-fields fallback (allowed parent route, otherwise Assignment default). A changed plan may
  require another probe; the final allowlist check still follows the last await.
- `jev-1.13-free` is documented as a limited-time free model on a third-party endpoint. Its
  availability, pricing and terms are outside this repository's control, so the feature must stay
  inert-by-default and must never be a correctness dependency.
- The per-Bot switch, persistence, RPC, and matching CLI commands ship together; see the
  [implementation contract](../proposals/dsh-auto-advisor.md).
