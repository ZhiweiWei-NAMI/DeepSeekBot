---
Status: Proposed
Date: 2026-10-15
Issues: pending (see `docs/proposals/dsh-auto-advisor.md`; local branch `feature/dsh-auto-advisor`)
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
  dispatch was in flight cannot be started. The whole preparation, including credential lookup,
  runs under one deadline; an answer that arrives after it is discarded rather than used.
- **Config decides, not the model.** The advisor is off unless a per-Bot opt-in enables it and a
  Host supplies a transport. With it off, behavior is unchanged.
- **The request carries no secrets by construction.** Only the tool name, a redacted and bounded
  task label, and the Bot-configured candidate list leave the process. The prompt body is not
  sent by default; the transport refuses any endpoint or model other than the pinned free one and
  refuses redirects, mirroring the prototype's fixed-endpoint rule.

## Consequences

- Selection quality is delegated to a model nobody has calibrated against this workload. The
  README of the prototype explicitly refuses to claim that Auto beats native routing; this ADR
  inherits that honesty. The change is a scheduling convenience, not a measured improvement.
- An unavailable *suggestion* may cause one extra `resolveCallConfig` probe before the copy falls
  back to the Assignment default. That is one dispatch doing two probes; the alternative is a
  hard failure preserving today's semantics. Left open in the proposal for the Human.
- `jev-1.13-free` is documented as a limited-time free model on a third-party endpoint. Its
  availability, pricing and terms are outside this repository's control, so the feature must stay
  inert-by-default and must never be a correctness dependency.
- The per-Bot switch is a Client surface with its own CLI parity obligation, so it ships as a
  separate PR; this one only defines the contract.
