# Subagent dispatch visibility — backend contract

Status: implemented in `packages/core` on the review tree `botharness/bot-subagent-visibility`
(base `6ad2594`). Frontend consumes the wire contract below; integration review (Sol, xhigh)
decides the merged shape with the parallel `subagent-model-tools.ts` work in `dsh-auto`.

## 1. What a user sees

When a PersonaBot delegates through `bot_subagent` / `bot_subagent_fork`, the Channel that
spawned the delegation gets one **dispatch card** whose `subagentDispatch` field tracks the real
Host lifecycle: `queued` → `running` → `completed` / `failed`, or `declined` when the delegation
never started. The card is an ordinary system-authored `ChannelMessage`, so history reads and the
existing Channel live stream carry it; nothing new is streamed.

## 2. Wire contract

```ts
// ChannelMessage (packages/core/src/channels/channel.ts)
subagentDispatch?: SubagentDispatchProjection;

interface SubagentDispatchProjection {
  dispatchId: string;        // Host tool-call id of the delegating call, assigned before routing
  kind: 'subagent';
  description: string;       // sanitized delegation description; <= 120 chars, no control chars
  status: 'queued' | 'running' | 'completed' | 'failed' | 'declined';
  revision: number;          // monotonic per dispatch; drop any update at or below it
  updatedAt: string;         // ISO
  parentSessionId: string;   // the PersonaBot Session that delegated
  resolvedRoute?: { provider: string; model: string; reasoningEffort?: string };
  reasonCode?: SubagentDispatchReasonCode;
}
```

Card message: `id = subagent-dispatch-<dispatchId token>-<hash>`, `author = { kind: 'system' }`,
`format = 'text'`, body `Subagent: <description>` (or `Subagent delegation`). The message id is
deterministic from the dispatch id, so a reconnect, a live update, and a history read all address
the same card without a second handshake.

### Live frames (existing Channel SSE, `/api/botharness/stream?channelId=…`)

| event | payload | when |
| --- | --- | --- |
| `channel/subagent-dispatch` | `{ channelId, messageId, subagentDispatch }` | every applied transition, including the route upgrade |
| `channel/subagent-dispatch-baseline` | `{ channelId, dispatches: [{ messageId, subagentDispatch }] }` | on every (re)subscribe, before live updates — the reconnect convergence point |

Ordering and idempotence: `revision` increases by one per published transition; terminal states
(`completed` / `failed` / `declined`) are final — no later frame reopens them. A client that drops
frames at or below the revision it already holds converges on reconnect from the baseline alone.

### Status semantics (what the backend can prove)

| status | evidence |
| --- | --- |
| `queued` | the child Session exists under this parent (`agent/created` with `header.parentSession`), or a background Job was registered for this owner — accepted, not yet resident |
| `running` | the child Session's first `turn/start` |
| `completed` | a **one-shot** child's `turn/end` reason `kind: 'completed'`, or the Host's `subagent/end` edge `stopReason: 'completed'`, or the Job settled `status: 'completed'` |
| `failed` | a one-shot child's `turn/end` reason `error` / `aborted` / `max-tokens` / `refusal`, or `subagent/end` with the same stop reason, or the Job settled `killed` / `failed`; `reasonCode` carries the mapped code |
| `declined` | the delegation never started: its own `tool/result` (matched by `toolCallId`) is an error |

**A continuable child's ordinary `turn/end` is not settlement.** The continuation manager only
publishes the paired `subagent/end` edge once the child agent is idle, its inbox has no pending
input, its owned children are gone, and the final state is flushed; that edge — or a background
Job's `settled` status — is the only fact that may complete a `continuable` card. Anything less
leaves the card on its last proven status.

`resolvedRoute` is published only when the child's durable `subagent/descriptor` (a
continuable child) records `agentProvider` / `agentModel` / `agentReasoningEffort` — the route the
child really started on. A `declined` card **never** carries `resolvedRoute`, and a one-shot child
whose descriptor has no route keeps `resolvedRoute` absent rather than guessed.

`reasonCode ∈ { refused, aborted, killed, max-tokens, refusal, route-not-allowed, credential,
provider-unavailable, no-plan, unfinished, error }` — a closed vocabulary. Raw Host error
messages, stack traces, prompts, fork context, tool arguments, and child output never enter a
projection.

**No fabrication rule.** If no reliable terminal fact arrives (child disposed without `turn/end`,
process stop, lost Job settlement) the card keeps its last observed status. It is never advanced to
`completed` on a guess; a stale non-terminal card is visible as such through `updatedAt`.

## 3. Boundaries

- **Isolation.** A projection is created only for a Session bound to a Channel (`BotRuntime.askChannel`
  semantics: orchestrator Session, single inbound Channel, membership checked), stored per
  `channelId`, and published only to that Channel's subscribers. Another bot's Channel never
  receives it. Assignment Sessions keep their existing semantics and are not projected.
- **Durability.** The card is committed to the Channel journal once, at its first observed state;
  later transitions are live-only and held in the bounded in-memory registry
  (`SUBAGENT_DISPATCH_MAX_PER_CHANNEL = 64` per Channel). The reconnect baseline is the convergence
  source after a Host restart; the journal keeps the state the card was committed with.
- **Correlation.** `dispatchId` is the Host tool-call id (unique, allocated before routing);
  `bot_subagent` / `bot_subagent_fork` are the only tools projected. A child or Job binds to the
  delegation only when exactly one candidate can own it: the only pending delegation there is, or
  the only pending delegation whose label matches the label the Host published for that child
  (its durable `subagent/descriptor` label) or Job (`label`). A label is not an identity — two
  delegations sharing one are never treated as interchangeable — and creation order is never
  consulted. A candidate that already carries a child or Job is never offered again, so two Jobs
  cannot claim one call. When nothing proves the target, the child waits with its first-turn facts
  retained until a later observation is unambiguous; a Job that proves nothing binds nothing, and
  the delegation stays unpublished rather than attributed by guesswork.
- **No inferred refusal.** A dispatching turn ending, or the parent Session being disposed, proves
  nothing about acceptance: the child or Job may still arrive, and the Session is reused across
  turns and Channels. Only the call's own error `tool/result` (matched by `toolCallId`) declines a
  delegation; otherwise the card keeps its last proven state, or is never published at all.
- **No agent-framework change.** `packages/core/src/runtime/subagent-model-tools.ts` is untouched: the projection is derived from Host surfaces the plugin already observes. Integration conflict points are listed in §6 — the parallel branches do overlap this change in `plugin.ts` and, for the token-speed branch, in `channel.ts` / `index.ts`.

## 4. Where it lives

| file | role |
| --- | --- |
| `packages/core/src/channels/subagent-dispatch.ts` | dependency-free vocabulary, sanitizer, revision/ordering reducer, per-Channel registry |
| `packages/core/src/channels/live.ts` | the two live frames, the baseline on subscribe, `publishSubagentDispatch` |
| `packages/core/src/channels/channel.ts` | `ChannelMessage.subagentDispatch` plus its journal validation |
| `packages/core/src/runtime/subagent-dispatch-projection.ts` | reduces real Host observations into the registry, commits the card, publishes transitions |
| `packages/core/src/plugin.ts` | registry in `createCore`; hub source; `session/event`, `agent/created`, `agent/disposed`, and the composition-scoped `jobs` subscription |
| `packages/core/test/subagent-dispatch.test.ts` | vocabulary, ordering, and projection reduction |
| `packages/core/test/subagent-dispatch-live.test.ts` | live frames, reconnect baseline, per-Channel isolation |
| `packages/core/test/subagent-dispatch-wiring.test.ts` | the real chain: plugin wiring → journal → live stream → reconnect (fake DSH agent host, no real Host) |

## 5. Verification

Executed offline against a read-only local dependency tree (Vitest 5.0.1 / TypeScript 5.9.3 borrowed
from sibling checkouts; the reviewed tree has no `node_modules` and installing is out of scope):

- `packages/core/test/subagent-dispatch*.test.ts` — **31 tests pass**, including the wiring test,
  which boots the real plugin through the repository's fake DSH agent host and asserts:
  a real `tool/call` event → a system card committed into the real Channel journal (author,
  body, `subagentDispatch`, no tool arguments) → `channel/message` plus
  `channel/subagent-dispatch` frames with revisions 1→2→3 (`queued`→`running`→`completed`) →
  a fresh subscriber's baseline carrying the terminal state; and a refused delegation committed
  as `declined` with `reasonCode: 'refused'` and no `resolvedRoute`.
- Strict `tsc` (repo compiler options, real DSH types via path mapping): **no errors in the new or
  changed subagent-dispatch code**. The remaining errors in the run are environmental (the
  hand-built program cannot reproduce the repository's declaration-merge ordering, so
  `@deepseek-ai/dsh-user-questions/types` and the `agent/created` listener signature report);
  the unmodified base `plugin.ts` reports the same ones.

## 6. Integration conflict points (real, not zero)

Both parallel branches change `plugin.ts`; the token-speed branch changes more of the same files.
Per-file evidence against base `6ad2594`:

| file | `dsh-auto-advisor` | `bot-token-speed` | conflict |
| --- | --- | --- | --- |
| `packages/core/src/runtime/subagent-model-tools.ts` | changed (advisor route) | unchanged | **none** — this change never edits it |
| `packages/core/src/plugin.ts` | changed: imports ~185, `botAdvisorOptions` ~195, `agent/created` call site ~2067 | changed: imports ~184, `messagePerf` wiring ~986/1007/2011, `agent/disposed` ~2054 | **overlap** in the import block and inside `agent/created` / `agent/disposed`. Mine are at import `~97`, `createCore` `~587/651/887`, projector wiring `~1577`, `session/event` `~2047`, `agent/created` `~2072`, `agent/disposed` `~2101`. Expect textual conflicts in the import block and in the two Agent lifecycle handlers; keep both call sites. |
| `packages/core/src/channels/channel.ts` | unchanged | changed: `ChannelMessagePerf` field ~325 (inside/next to `ChannelMessage`) | **adjacent, same interface** — my field is at ~297. Auto-merge likely; review the interface as a whole. |
| `packages/core/src/index.ts` | unchanged | changed: exports ~69/~73 | **overlap** with my export block at ~73. Trivial: keep both export lists. |
| `packages/core/src/channels/live.ts` | unchanged | unchanged | none |

New files (`channels/subagent-dispatch.ts`, `runtime/subagent-dispatch-projection.ts`, the three
tests, this doc) collide with nothing.

## 7. Deferred / not covered here

- `subagent/end` **is** consumed (registered with `{ global: true }`, which Cordis admits without
  scope filtering), because it is the Host's paired terminal for a continuable activation. It is
  the only terminal a continuable card accepts besides a Job settlement, and it is not used for
  residency reporting (`subagent/start` is deliberately not consumed).
- Continuable children that resume for a later activation keep the first terminal state
  (first terminal wins); per-activation cards are out of scope.
- **Durability boundary**: a Host restart keeps only the journal state the card was committed with;
  later transitions live in the bounded in-memory registry and the reconnect baseline. Reloading
  the page against a running Host converges on the latest state.
- The wiring test uses the repository's fake DSH agent host: it proves the plugin registration,
  journal write, live publication, and reconnect path, but not a real Host process, real
  `ctx.jobs` service, or real IM/browser delivery. Client rendering, the `changes/` changelog
  fragment, CLI parity (no bridge method/route/tool was added), and the living-architecture / ADR
  updates belong to the integration PR, not this review tree.

