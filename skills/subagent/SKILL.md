---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` CLI to delegate work to a separate Pi process with its own context and tmux session. Managed subagents cannot spawn nested subagents, and this skill is not loaded into their sessions.

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the generated handle remains its stable identifier:

```sh
subagent spawn --name implementation --prompt "Complete task"
```

By default, the child inherits the current Pi provider, model, and reasoning level from the bash environment. Use `--provider`, `--model`, or `--thinking` only when deliberately choosing a different configuration, for example a faster model for simple investigation or a stronger model for difficult review. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to the CLI explicitly.

`--cwd` defaults to the current directory. Repeat `--prompt` and `--file` as needed; Pi receives all of them in the first user turn. Run `subagent spawn` directly without piping or redirecting its concise output.

## Tools

Without `--tools`, Pi enables its four default tools:

- `read` - Read text files and images.
- `bash` - Execute shell commands. This can also modify files, so it is not a read-only capability.
- `edit` - Apply exact text replacements to existing files.
- `write` - Create or overwrite files.

Three additional built-in tools are available but off by default:

- `grep` - Search file contents.
- `find` - Find files by glob pattern.
- `ls` - List directory contents.

`--tools` is a comma-separated allowlist across built-in, extension, and custom tools. Common choices:

```sh
# Enforced read-only repository investigation
--tools read,grep,find,ls

# Investigation that may run tests or other commands; bash can modify files
--tools read,bash,grep,find,ls

# Implementation work: omit --tools to use the defaults
```

## Isolation flags

- `--no-extensions` - Disable normal extension discovery. Use for an independent run that should not inherit unrelated extension behavior or extension-provided tools. The subagent control bridge is still explicitly loaded.
- `--no-skills` - Hide installed skills from the child. Use for tightly specified tasks that should rely only on the supplied prompt and files.
- `--no-prompt-templates` - Disable prompt-template commands. Usually unnecessary, but useful when testing a minimal child environment.
- `--no-context-files` - Ignore repository instruction files such as `AGENTS.md` and `CLAUDE.md`. Use only when those instructions would bias an independent investigation. Do not use for implementation unless intentionally bypassing repository guidance.

Spawn prints a random handle and the exact tmux attach command. Keep the handle for later commands. Subagents are owned by the spawning Pi session and are terminated automatically when that session quits or is replaced; they survive `/reload`.

## Inspect and wait

```sh
subagent status <handle>
subagent list
subagent wait <handle>
```

`wait` follows the durable session state and prints the latest final assistant response. Run it directly so the bash tool returns that response; do not redirect it to a file or pipe it unless the user explicitly asks for an artifact. Do not infer completion from captured terminal text. Set the bash timeout above `wait`'s default 1800-second deadline.

## Communicate

```sh
# Change the name shown in the parent UI.
subagent rename <handle> "new name"

# Idle: starts a new prompt. Busy: steers the current work.
subagent send <handle> "message"

# Busy: waits until current work finishes, then starts another turn.
subagent send <handle> --follow-up "message"
```

Names are 1–64 characters and need not be unique. Messages use the subagent extension's control inbox; do not use `tmux send-keys`.

## Stop

```sh
subagent stop <handle>
```

This terminates tmux and removes the run transcript and metadata. Keep an idle subagent alive when follow-up work may be useful.

The interactive `/subagent` command lists active subagents spawned by the current Pi session. Selecting one suspends the current Pi TUI and attaches to its tmux session; detaching returns to the parent Pi. When the parent already runs inside tmux, selection switches the current tmux client instead.
