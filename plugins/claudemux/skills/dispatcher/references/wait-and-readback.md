# Wait for a turn and read it back (scenario reference)

Read this when an external actor (Remote Control web UI, mobile app, cron callback, or the teammate's own sub-agents) is driving a teammate and you need to collect the result without sending a fresh prompt. Skip when you are the sender; `tm send` and `tm spawn --prompt` already wait and print the result atomically (see `dispatch-task.md`).

## Primary verbs

```bash
tm wait <repo> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]
tm wait <codex-name> [timeout=1800] [--timeout N]
```

For Claude tmux teammates, pass `--fresh` for passive observation. It clears the idle/.last/.busy baseline up front so the wait targets the next Stop, not a prior one. `tm send` does this reset internally before sending; passive observers have to ask for it explicitly.

For Codex daemon teammates, do not pass `--fresh` or `--pane-quiet`; current `tm wait` rejects both on Codex targets. Codex wait reads the current thread/turn state through the Codex driver and prints the Turn result on stdout.

`--timeout N` is the flag form of the positional timeout; both forms are accepted and the default is 1800 seconds. Run `tm wait` in the background so the dispatcher stays free. The harness fires a task notification when the result arrives.

Run `tm wait --help` for the full flag/output contract.

## Claude wait machinery: idle / .last files

Two on-disk files per Claude teammate power reply readback:

- `/tmp/claude-idle/<sid>` — zero-byte idle signal. The plugin's `on-stop.sh` hook touches it on **Stop**, **StopFailure**, **PostCompact**, and **SessionEnd**.
- `/tmp/claude-idle/<sid>.last` — assistant text from the last settled turn, written by `on-stop.sh` **on Stop only**.

`tm send`, `tm spawn --prompt`, and `tm wait` read `.last` for reply text. `tm compact` is different: it waits for the PostCompact idle marker and prints `compacted`; it does not read `.last`.

`tm send` and `tm spawn --prompt` clear both files plus `<sid>.busy` before sending so the following wait targets this turn. `tm wait --fresh` does the same baseline reset without sending.

`.last` is the full assistant text as recorded in the jsonl transcript. The verbs read it instead of `tmux capture-pane` because pane scrollback can silently clip long replies.

The Stop hook fires for every Claude Code session including the dispatcher; the dispatcher's sid is never waited on, so its hook firings are inert.

## TUI-only commands and the `--pane-quiet` fallback

The Stop hook covers Stop / StopFailure / PostCompact / SessionEnd, so `/compact`, `/clear`, and API errors unblock the default `tm send` / `tm wait` paths.

Use `--pane-quiet` only for Claude TUI-only slash commands and dialogs that fire no hook: `/help`, `/effort`, `/agents` opening dialogs, permission prompts. Example:

```bash
tm send <repo> --prompt /help --pane-quiet
```

It polls the pane and returns when the spinner has been absent for about 4 seconds and at least 3 seconds have passed since the last send. `--fresh` is a no-op under `--pane-quiet`; the send-at timing gate provides freshness. The ctx echo to stderr is skipped on `--pane-quiet` because there is no fresh usage block in jsonl.

Known blind spot: a permission prompt blocks Claude with no spinner. `--pane-quiet` can return "ready" while the teammate is stuck on a y/n decision. If you suspect a prompt, follow with `tm status <repo>` to see the pane.

## Two foot-guns

- **Don't read `/tmp/claude-idle/<sid>` directly to check "done".** `tm send` removes the marker before sending, so an old completed turn is not visible there. Use `tm wait --fresh` or `tm last <repo>`.
- **Don't build a custom polling loop with `grep` on prompt-echo words.** Match expected result keywords (`Scheduled`, `Cancelled`, anticipated error codes), never words from the prompt you just sent. The prompt appears in the user turn, so prompt-word grep returns instantly.

## A reply may cite instructions you never saw

The user can drive a teammate directly through Remote Control web UI or mobile on a channel the dispatcher cannot observe. A reply that references an instruction, decision, or constraint you never dispatched is expected.

Treat such references as genuine user input. Do not assume the teammate invented them, and do not "correct" the teammate back to what you remember dispatching. If a cited instruction conflicts with something you need to act on and cannot be reconciled, ask the user.
