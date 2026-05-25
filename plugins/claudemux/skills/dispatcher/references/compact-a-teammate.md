# Compact a Claude teammate (scenario reference)

Read this when a Claude tmux teammate's context window is filling up and you want to compact its transcript before the next turn. Skip when you are sending fresh work or waiting on a turn; those use `tm send` / `tm wait`.

## Check fill: `tm ctx`

`tm ctx <repo>` (or `tm ctx --all`) reads the jsonl usage block for accurate prompt size. Do not rely on the TUI status-bar percentage. Run `tm ctx --help` for the window heuristic and `--window 200k|1m` override.

## Compact

```bash
tm compact <repo> [timeout=1800] [--timeout N]
```

Sends `/compact` to the teammate, waits for the **PostCompact** hook to fire, and prints `compacted` on stdout when the idle marker arrives. Default timeout is 1800 s.

Run every `tm compact` with `run_in_background: true` on the Bash tool. Compaction can take minutes; the harness fires a task notification when the verb returns.

Run `tm compact --help` for the full flag/output contract.

## Non-success modes

| Mode | Exit | What to do |
|---|---|---|
| `"Not enough messages to compact"` | `1` | The transcript is too short. Treat this as a true refusal; continue without compacting. |
| PostCompact never fires within `--timeout` | `124` | The teammate may still be compacting. Do not respawn or kill on this code; use `tm status <repo>` to inspect the pane, or keep watching with `tm wait <repo>`. |

## After compaction

`tm compact` does not echo ctx. Run `tm ctx <repo>` separately if you need the new size, or let the next `tm send` stderr ctx echo carry it.

Compaction commands in this skill use only `tm compact <repo>`.
