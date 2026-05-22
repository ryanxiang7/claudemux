# 0009 — tm heartbeat is passive dispatcher-side liveness, not a teammate-push heartbeat

- **Status:** Accepted
- **Date:** 2026-05-22
- **Affects:** `tm` (planned `states` / `resume` enhancements, internal helpers, path builders), the `dispatcher` skill, `/claudemux:setup`, deployment topology

## Context

The original requirement asked for a heartbeat: teammates periodically report
that they are alive, and the dispatcher auto-resumes the dead. Investigation
found that framing wrong. A teammate cannot emit a clean heartbeat — a
cron-based report goes silent while the teammate is busy, an event-hook
report goes silent while it is idle and healthy, and an in-pane sidecar is
decoupled from claude's real liveness. Meanwhile, whether a teammate exists
is something the dispatcher already observes from outside `tmux`, for free
and with no blind spot.

A real correlated failure also forced a deployment question: on 2026-05-22 at
20:44 a `tmux` server crash took down the dispatcher and every teammate at
once, because all of them shared a single `tmux` server.

An earlier draft of this design exposed the capability as two **new** verbs,
`tm health` and `tm revive`. Review rejected the added command surface: the
`tm` verb set is already broad, a new verb is a real cognitive cost, and the
goal is the best architecture rather than another layer of patches. The
capability splits along a seam `tm` already has — *observing* fleet state is
`tm states`, *recovering* a session is `tm resume` — so it folds into those
two verbs instead of adding any.

## Decision

Reverse the framing. There is **no teammate-push heartbeat**; the dispatcher
**passively observes** teammate liveness. The capability adds **no new `tm`
verb** — it enhances the two existing verbs whose jobs already cover it, and
extends `/claudemux:setup`.

- **A three-tier liveness model.** L1 (tmux session) and L2 (claude process)
  are observable and unambiguous; L3 (REPL responsive) is not cheaply
  observable. Auto-resume targets only L1/L2 death; L3 only emits a WARN.
- **Liveness folds into `tm states`.** `tm states` gains a `STATUS` column
  (`alive` / `dead-session` / `dead-proc` / `maybe-wedged`), a widened
  enumeration over `iter_repos` ∪ `/tmp/teammate-*.sid` (so a fully vanished
  teammate still shows as a `dead-session` row), a `--json` flag for the
  cron callback, and a persisted per-repo verdict file. Probing fleet state
  is what `tm states` already does — liveness is the same fact, observed the
  same way, at the same time.
- **Resume sequencing and the circuit breaker fold into `tm resume`.**
  `tm resume` gains a liveness probe and dead-shell `tm kill`-first
  sequencing (a live claude is still refused with "already running"). The
  deterministic, file-based circuit breaker — N-strike confirmation, per-repo
  cooldown, hourly budget, `mkdir` lock — is engaged only by a new `--auto`
  flag. A plain manual `tm resume` keeps its authoritative, un-rate-limited
  semantic; only the unattended auto-resume path (the cron callback and the
  boot flow) passes `--auto` and is throttled. The breaker's counting is not
  delegated to the LLM.
- **Detection is reflex plus a durable cron, with no resident process** — the
  STATUS column makes every `tm states` snapshot a liveness check, an L2
  fast-fail is added to `tm send` / `tm wait`, and a
  `CronCreate({durable: true})` dispatcher sweep runs `tm states --json`.
- **The resume decision stays a dispatcher LLM turn and is ledger-aware.**
  `tm` owns mechanism; the dispatcher skill owns the policy of whether a task
  is still worth reviving. Reviving a teammate whose task is already done is
  a bug, and only the ledger knows the difference.
- **The three existing teammate hooks are not changed.**
- **Deployment topology 3b, set up through `/claudemux:setup`.** The
  dispatcher runs in its own `tmux` server (`tmux -L dispatcher`).
  `/claudemux:setup` gains a guided step that explains the 20:44 failure and
  walks the human through launching the dispatcher that way. `tm` pins the
  teammate socket with `unset TMUX` at startup, so `tm spawn` does not follow
  `$TMUX` into the dispatcher's server — chosen over threading an explicit
  `-L` flag through ~12 call sites, because one line at the entry point
  carries the whole guarantee. This isolates a teammate-server crash from the
  dispatcher — the structural fix for the 20:44 class of failure.
- **A tmux-external `launchd` supervisor (the "Tier 2" idea) is rejected.**
  `claude --resume` restores conversation context, not execution; the
  dispatcher's own sid has nowhere to be recorded; the cron table is cleared
  by a crash; and topology 3b already removes, structurally, the
  correlated-crash problem Tier 2 was meant to solve.

The full design — the verb enhancements, the circuit breaker, the topology
comparison, and the code-landing points — is in
[the design doc](/.agents/designs/tm-heartbeat-passive-liveness.md).
Implementation is pending; this record fixes the direction so it is not
re-litigated.

## Consequences

- The design covers the common case — a single teammate falling over while
  the dispatcher is alive. It deliberately does **not** cover: L3 wedge
  auto-resume (WARN only), the dispatcher's own death, a whole-machine
  restart (which clears `/tmp`), or the dispatcher's own `-L` server
  crashing.
- `tm` gains **no verb**. `tm states` and `tm resume` grow; their `--help`
  text and the dispatcher `SKILL.md` command table must move in lockstep.
- `tm resume` now has two modes. The plain form stays authoritative and
  un-throttled; `--auto` is rate-limited. A caller that wants a guaranteed
  resume must not pass `--auto`; a caller that wants storm protection must.
  This split is the load-bearing distinction — folding the breaker in
  unconditionally would have broken the manual-resume semantic.
- The `.sid` enrollment gate respects an explicit `tm kill` (which deletes
  `.sid`) but **not** "task completed" — a finished-but-unkilled teammate
  still has its `.sid`. The real guard against reviving a completed teammate
  is the ledger check, not the `.sid` gate.
- Topology 3b **requires** a `tm` change: bare `tmux` follows `$TMUX`, so
  without `unset TMUX` the dispatcher's `-L` server would capture freshly
  spawned teammates and the isolation would be silently defeated.
- New repo-keyed protocol files appear under `/tmp/teammate-<repo>.*`:
  `.proc`, `.health`, `.resumed-at`, `.resume-log`, `.last-launch`, and the
  `.resume.lock` directory. They are `tm`-owned (the hooks do not touch
  them); [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md)
  records them when the enhancements land.
- An incidental bug fix rides along: `tm send` / `tm wait` to a dead-shell
  teammate currently block for the full 1800s timeout; the L2 fast-fail
  closes that.

## References

- [Design: tm heartbeat — passive dispatcher-side liveness](/.agents/designs/tm-heartbeat-passive-liveness.md)
- [`/plugins/claudemux/bin/tm`](/plugins/claudemux/bin/tm)
- [components/tm.md](/.agents/components/tm.md),
  [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md),
  [decisions/0002-atomic-tm-verbs.md](/.agents/decisions/0002-atomic-tm-verbs.md)
</content>
