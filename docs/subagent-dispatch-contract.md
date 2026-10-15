# Subagent dispatch visibility — backend contract

The Host projects observed lifecycle facts into Channel messages and live frames; the Web Client
renders the public projection. This does not change dispatch routing or grant new permissions.

## 1. What a user sees

When a PersonaBot delegates through `bot_subagent` / `bot_subagent_fork`, the Channel that
spawned the delegation gets one **dispatch card** whose `subagentDispatch` field tracks the real
Host lifecycle: `queued` → `running` → `completed` / `failed`, or `declined` when the delegation
never started. The card is an ordinary system-authored `ChannelMessage`, so history reads and the
existing Channel live stream carry it, using the two new frame types below.

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

| event                                | payload                                                        | when                                                                          |
| ------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `channel/subagent-dispatch`          | `{ channelId, messageId, subagentDispatch }`                   | every applied transition, including the route upgrade                         |
| `channel/subagent-dispatch-baseline` | `{ channelId, dispatches: [{ messageId, subagentDispatch }] }` | on every (re)subscribe, before live updates — the reconnect convergence point |

Ordering and idempotence: `revision` increases by one per published transition; terminal states
(`completed` / `failed` / `declined`) are final — no later frame reopens them. A client that drops
frames at or below the revision it already holds converges on reconnect from the baseline alone.

### Status semantics (what the backend can prove)

| status      | evidence                                                                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`    | the child Session exists under this parent (`agent/created` with `header.parentSession`), or a background Job was registered for this owner — accepted, not yet resident                                       |
| `running`   | the child Session's first `turn/start`                                                                                                                                                                         |
| `completed` | a **one-shot** child's `turn/end` reason `kind: 'completed'`, or the Host's `subagent/end` edge `stopReason: 'completed'`, or the Job settled `status: 'completed'`                                            |
| `failed`    | a one-shot child's `turn/end` reason `error` / `aborted` / `max-tokens` / `refusal`, or `subagent/end` with the same stop reason, or the Job settled `killed` / `failed`; `reasonCode` carries the mapped code |
| `declined`  | the delegation never started: its own `tool/result` (matched by `toolCallId`) is an error                                                                                                                      |

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
  (`SUBAGENT_DISPATCH_MAX_PER_CHANNEL = 64` per Channel). The reconnect baseline converges while
  the Host is running. A Host restart retains only the initially committed journal state, not later
  live transitions.
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
- **No agent-framework change.** The projection observes Host surfaces without changing
  `subagent-model-tools.ts`, model routing, or child execution. Job subscriptions belong to the
  composition, not the dispatching Agent, so settlement remains observable after that Agent disposes.
- **Client bounds.** Only existing system-message anchors receive overlays; stale history cannot
  erase a newer live revision or reopen a terminal card. Mobile accepts the frame vocabulary to
  preserve transport flow; it does not implement the Web dispatch-card UI.

## 4. Where it lives

| file                                                        | role                                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/channels/subagent-dispatch.ts`           | dependency-free vocabulary, sanitizer, revision/ordering reducer, per-Channel registry                                                   |
| `packages/core/src/channels/live.ts`                        | the two live frames, the baseline on subscribe, `publishSubagentDispatch`                                                                |
| `packages/core/src/channels/channel.ts`                     | `ChannelMessage.subagentDispatch` plus its journal validation                                                                            |
| `packages/core/src/runtime/subagent-dispatch-projection.ts` | reduces real Host observations into the registry, commits the card, publishes transitions                                                |
| `packages/core/src/plugin.ts`                               | registry in `createCore`; hub source; `session/event`, `agent/created`, `agent/disposed`, and the composition-scoped `jobs` subscription |
| `packages/core/test/subagent-dispatch.test.ts`              | vocabulary, ordering, and projection reduction                                                                                           |
| `packages/core/test/subagent-dispatch-live.test.ts`         | live frames, reconnect baseline, per-Channel isolation                                                                                   |
| `packages/core/test/subagent-dispatch-wiring.test.ts`       | the real chain: plugin wiring → journal → live stream → reconnect (fake DSH agent host, no real Host)                                    |

## 5. Offline verification

```bash
pnpm vitest run packages/core/test/subagent-dispatch.test.ts \
  packages/core/test/subagent-dispatch-live.test.ts \
  packages/core/test/subagent-dispatch-wiring.test.ts \
  packages/client/test/subagent-dispatch.test.tsx \
  packages/client/test/subagent-dispatch-live.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

The existing tests cover lifecycle/correlation counterexamples, sanitization, immutable terminal
states, journal/live wiring, reconnect baselines, Client parsing/rendering, and Channel isolation.
The wiring fixture uses a fake DSH agent host; visual fixtures use synthetic public values, not
real jobs or private Session content. Test results belong to the reviewed commit's evidence.

## 6. Deferred / not covered here

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
  `ctx.jobs` service, or real IM/browser delivery. No new bridge method, route, or Bot tool is added;
  the card is a projection, not a dispatch-control surface.
