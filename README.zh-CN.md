[English](./README.md) · **简体中文**

# claudemux

> `claude` + `tmux`。一个 dispatcher 会话跟你对话,每个 repo 一个 teammate
> 跑在自己的 tmux session 里,你用大白话指挥整支 fleet。

## 架构

```mermaid
flowchart TB
    user(["你<br/>(终端 · 网页 · 移动端)"])

    subgraph dispatcher_dir["dispatcher 目录 · 你 repo 的共同父目录"]
        dispatcher["dispatcher<br/>(tmux 里的 claude,跟你对话)"]
        repoA[("repo-a/")]
        repoB[("repo-b/")]
        repoC[("repo-c/")]
    end

    subgraph teammates["teammates · 每个 repo 一个 tmux session"]
        tA["teammate-repo-a<br/>(claude in repo-a/)"]
        tB["teammate-repo-b<br/>(claude in repo-b/)"]
    end

    user <-->|聊天| dispatcher
    user -.->|可选:Remote Control<br/>直接驱动| tA
    dispatcher -->|tm spawn / send / ask| tA
    dispatcher -->|tm spawn / send / ask| tB
    tA -.cwd.-> repoA
    tB -.cwd.-> repoB
```

## 跨设备驱动 teammate

每个 teammate 都是真实的 `claude` REPL,自带 Remote Control URL。浏览器
打开、手机 app 打开,就是直接在跟这个 teammate 对话——不用回终端。

- 地铁上用手机看长跑的 teammate 进展
- 咖啡馆笔记本上接着派新活,dispatcher 同时继续协调其他 teammate
- 三台设备三个窗口,并行驱动同一支 fleet

`/claudemux:setup` 会帮你打开 Claude Code 的 `remoteControlAtStartup`,
之后每个 teammate 一起来就注册好自己的 URL。

## 安装

任意 Claude Code 会话里:

```
/plugin marketplace add excitedjs/claudemux
/plugin install claudemux@claudemux
/reload-plugins
```

然后 `cd` 到你 sibling repo 的共同父目录,启动 dispatcher:

```bash
cd ~/path/to/your/dev-dir
claude
```

REPL 里:

```
/claudemux:setup
```

## 快速上手

直接说人话,`dispatcher` 技能会接住:

> 派一个 teammate 去 repo-a 跑测试
>
> 看看 repo-b 现在在干啥
>
> 让 repo-a 跑 lint,同时让 repo-b 升级 react 到 19

或者直接调 `tm`:

```bash
tm spawn repo-a                                # 起 teammate
tm ask   repo-a 'run yarn test in unit-test'   # 发送 + 等回话 + 打印
tm states                                      # 一览整支 fleet
tm kill  repo-a                                # 收掉
```

## `tm` 命令

Claude Code 会话里 `tm` 自动在 `PATH` 上。会话外用法见
[在 Claude Code 之外用 `tm`](#在-claude-code-之外用-tm)。

| 子命令 | 作用 |
|---|---|
| `tm ls` | 列出在跑的 teammate session。 |
| `tm states` | 一行一个的整体快照:repo、sid、忙不忙、上次回复多大多久前、首 50 字。 |
| `tm spawn <repo> [--task <slug>] [--resume <sid>]` | 在新 tmux session 里为 `<repo>` 起 teammate。`--task <slug>` 给会话起个可读名字(`<repo>-<slug>`;ASCII 字母数字 + 中文汉字都可以);不传就是 `<repo>-<rand4>`。 |
| `tm resume <repo> [<sid>] [--prompt "…"] [--task <slug>]` | 恢复旧会话。优先从台账拿 `sid`;不传则按 mtime 选最新 jsonl。`--task` 给恢复的会话改名。 |
| `tm send <repo> <prompt…>` | 发送一条 prompt + Enter。 |
| `tm ask [--quiet] [--timeout=N] <repo> <prompt…>` | round-trip 原语:发送 + 等待 + 把回复打到 stdout。`/compact` 这种不触发 Stop 的命令配 `--quiet`。 |
| `tm wait-idle [--fresh] <repo> [timeout]` | 阻塞到 teammate Stop hook 触发(= 一次 turn 结束)。`--fresh` 忽略之前已经存在的 idle 信号。 |
| `tm wait-quiet <repo> [timeout]` | 阻塞到 teammate pane 上转圈消失几秒。Stop 不会触发的命令用这个。 |
| `tm last <repo>` | 打印 teammate 上一轮回复的完整正文。要全文时用它——`tm status` 受 tmux scrollback 截断影响。 |
| `tm status <repo> [lines]` | capture-pane 看 teammate 实时屏幕。 |
| `tm poll <repo> <regex> [timeout]` | 阻塞到 pane 内容匹配正则。wait-idle / wait-quiet 都不适用时兜底。 |
| `tm kill <repo>` | 干掉 teammate 的 tmux session,清状态文件。 |
| `tm archive <id> [--status '<tag>']` | 把 `active-dispatcher-tasks.md` 里一个收尾的 task 搬到 archive(收尾文字从 stdin 进)。 |
| `tm ctx <repo>… \| --all [--window 200k\|1m]` | 每个 teammate 的真实上下文用量,从 jsonl 的 `usage` 字段读,比 TUI 那个百分比准。 |
| `tm history <repo> [<sid-or-prefix>]` | 列 `<repo>` 的历史会话(最新在前);传 sid 前缀则展开一条详情。 |

等待原语和磁盘状态契约见
[`plugins/claudemux/skills/dispatcher/SKILL.md`](plugins/claudemux/skills/dispatcher/SKILL.md)。

## `/claudemux:optimize` —— 周期自检

随包一个技能,扫 dispatcher 最近的对话,识别反复踩的坑、没沉淀的约定,
按合适的载体写进 `CLAUDE.md` 或项目 memory。跑在 fork 出来的独立上下文
里,返回一份简短报告。手动调用,或用 `CronCreate` 排成每周一次。

## 依赖

| 工具 | 用途 |
|---|---|
| Claude Code CLI | 插件挂在它上面。 |
| `tmux` | Teammate 跑在 tmux session 里。 |
| `jq` | Stop hook 解析 harness JSON。 |
| `bash` | 插件脚本用 Bash 特性。 |
| macOS 或 Linux | 脚本用 BSD `stat`,Windows 不支持。 |

## 配置

没有。dispatcher 目录就是你 `cd` 过去跑 `claude` 的那个地方——`tm` 在
调用时直接拿 `$PWD`。换目录就 `cd` 到别处,没全局状态文件要改。

## 在 Claude Code 之外用 `tm`

`tm` 在插件里是 `bin/tm`。普通终端要用的话,做一次软链:

```bash
ln -sf ~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm ~/.local/bin/tm
```

确认 `~/.local/bin` 在 `PATH` 上。`<version>` 换成实际装的版本号。

## 已知限制

- **只支持单 dispatcher 根**。`tm spawn <repo>` 把 `<repo>` 按
  `$PWD/<repo>` 解,sibling repo 必须共享一个父目录。
- **只 macOS / Linux**。脚本用 BSD `stat`,GNU Linux 需要
  `-c %Y`——PR welcome。
- **Cron 只在 dispatcher REPL 里 fire**。`claude -p` 或 Agent Teams
  teammate 里 `CronCreate` 返回成功但永不触发。

## 本地开发

### 一次性

```bash
git clone https://github.com/excitedjs/claudemux ~/src/claudemux
claude --plugin-dir ~/src/claudemux/plugins/claudemux
```

### 持久(推荐)

```bash
claude plugin marketplace add ~/src/claudemux --scope local
claude
# REPL 里:
/plugin install claudemux@claudemux
```

`/reload-plugins` 热加载 skill / command / hook / `tm` 脚本,不用重启。

clone 后跑一次启用 pre-commit hook:

```bash
git config core.hooksPath .githooks
```

它会拦截同一提交里改了 feature-class(`bin/` / `hooks/` / `scripts/` /
`templates/` / `skills/*/SKILL.md`)却没 bump 版本的 commit。在这次
commit 里用 `bin/bump-version <patch|minor|major>` 抬一下版本即可。

## 卸载

```
/plugin uninstall claudemux
```

插件和它的 hook 一起摘掉。dispatcher 目录里的 `CLAUDE.md` 留在原地——
不想要就手动删。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
