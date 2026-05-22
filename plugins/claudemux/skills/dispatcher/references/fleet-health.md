# Fleet health: detect dead teammates and auto-resume them (scenario reference)

Read this when you need to know whether teammates are still alive, recover one that died, or set up the recurring health sweep. Skip it for routine send/wait on a teammate you already know is up (`dispatch-task.md`, `wait-and-readback.md`).

A teammate is a `claude` process in a tmux pane. It can die while you are not looking — the process crashes, the tmux session is killed, the tmux server falls over. Nothing pushes you a notification. So the dispatcher *observes* liveness from outside and resumes the teammates whose work is not finished. There is no separate health verb: the capability lives inside `tm states` (observe) and `tm resume --auto` (recover).

## The liveness model

`tm states` classifies every teammate into one `STATUS`:

| STATUS | Meaning | Auto-resume? |
|---|---|---|
| `alive` | tmux session up, claude process up | no — it is healthy |
| `dead-session` | the tmux session is gone | yes — unambiguous death |
| `dead-proc` | session up, but claude crashed back to a shell | yes — unambiguous death |
| `maybe-wedged` | claude up, but its `.busy` marker is very stale | **no** — only flagged |
| `starting` | launched moments ago, still coming up | no — give it time |

`dead-session` and `dead-proc` are unambiguous — the process is gone, so resuming cannot race a live teammate. `maybe-wedged` is only a *suspicion*: a wedged REPL and a teammate legitimately grinding on a 30-minute turn look identical from outside, so it is never auto-resumed. Surface it to the user as a WARN and let them judge.

## On session boot — reconcile the fleet

When you start a dispatcher session, a teammate may have died while the previous dispatcher was down. Reconcile before taking new work:

1. Read `active-dispatcher-tasks.md` (the live ledger).
2. Run `tm states --json` — the machine-readable fleet snapshot.
3. For each ledger task whose teammate is `dead-session` / `dead-proc` / missing, **and whose task is still active** (not merged, not finished): `tm resume --auto <repo> <sid>`, with the sid from that ledger entry.
4. Leave `alive` and `starting` teammates alone; report any `maybe-wedged` ones to the user.

## The recurring sweep cron

Boot reconciliation only covers session start. To catch deaths *during* a session, keep a sweep cron armed:

- Create it with `CronCreate` and `durable: true`, so it survives a dispatcher restart (it is persisted to `.claude/scheduled_tasks.json` and auto-reloaded). A non-durable cron dies with the dispatcher — exactly when you would need it most.
- ~10-minute interval on an off-minute (e.g. `3,13,23,33,43,53 * * * *`) — the fleet aliases on `:00`/`:30`.
- The callback prompt runs the same four steps as boot reconciliation.
- Recurring crons expire after 7 days. Have the callback re-arm itself, or re-arm at session boot.

The cron fires only while the dispatcher is idle — a sweep delayed a few minutes by an active conversation is fine, because a dispatcher that is busy is a dispatcher that is alive.

## tm resume --auto and the circuit breaker

`tm resume --auto <repo> <sid>` is the resume form for automated callers — the sweep cron and boot reconciliation. It differs from a plain `tm resume`:

- It handles a dead shell: a `dead-proc` teammate's stale session is killed before the resume recreates it.
- It runs a deterministic circuit breaker and **can refuse**:
  - **N-strike** — `tm states` must have independently recorded the repo dead first. The sweep and boot flow both run `tm states` before `tm resume --auto`, so this is satisfied in normal use.
  - **cooldown** — no auto-resume within ~5 min of the last resume of that repo.
  - **budget** — at most ~3 auto-resumes per repo per rolling hour.
- With no `--prompt`, it drives the resumed teammate with a post-crash recovery instruction (re-check the last action, `git status`) — the jsonl restores the conversation, but a tool call half-finished at crash time is not.

A refusal exits non-zero with the reason on stderr. When the breaker fires, the teammate is *flapping* — it dies, gets resumed, dies again. Do not fight it: surface the refusal to the user as a WARN. A teammate that crash-loops needs a human to find out why, not another resume.

For a deliberate, hand-driven resume, use plain `tm resume` (no `--auto`): it is authoritative and never rate-limited.

## Why the resume decision stays with you

`tm` is mechanism; it does not read the ledger. A teammate whose task is **already finished** but was never `tm kill`ed still looks resumable to `tm`. Resuming it is a bug — it brings a done teammate back only to idle-wait for nothing. Only you can see, from the ledger, whether the task is still worth reviving. So: `tm` decides *whether it can be resumed*; you decide *whether it should be*. Always cross-check the ledger before `tm resume --auto`.

## What this does not cover

- A wedged-but-alive teammate (`maybe-wedged`) — flagged, never auto-resumed.
- The dispatcher's own death — nothing here revives the dispatcher; a human restarts it, and boot reconciliation then recovers the teammates.
- A whole-machine restart — it clears `/tmp`, so all teammate enrollment state is gone.

Run `tm states --help` and `tm resume --help` for the full flag and output contracts.
