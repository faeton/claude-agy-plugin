# Antigravity (`agy`) plugin for Claude Code

Consult Google's **Antigravity CLI (`agy`)** from inside Claude Code for a **fast, strictly read-only** second opinion or code review — without ever letting `agy` touch your files.

Think of it as the Antigravity counterpart to [`claude-grok-plugin`](../claude-grok-plugin) and OpenAI's [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc): you stay in Claude Code, and hand specific questions or diffs to `agy` when you want an independent perspective. `agy` answers; you decide what to do with it.

```text
/agy:consult -- is a sync.Map the right choice for this hot-path cache?
/agy:review --scope working-tree
/agy:adversarial-review hunt for race conditions in the new worker pool
```

---

## Why this is fast and strictly read-only

By default, `agy` is a full agent with a large built-in system prompt (~25k+ tokens) and write/shell tools. When consulting `agy` for a second opinion or code review, you want:
1. **Strict read-only guarantees** so `agy` can inspect the repository but never edit files or run shell commands.
2. **Low latency** without paying the full agent prompt overhead on every turn.

`claude-agy-plugin` solves both by automatically provisioning and invoking a custom Markdown-defined Antigravity agent (`~/.gemini/config/agents/claude-agy-readonly.md`):

```markdown
---
name: claude-agy-readonly
description: "Strictly read-only code reviewer and consultation agent for claude-agy-plugin."
tools:
  - view_file
  - grep_search
  - list_dir
  - find_by_name
mainAgent: true
subagent: false
commandExecutionPolicy: "off"
---

# System Prompt

You are a read-only code reviewer and technical consultant. You can inspect the repository with view_file, grep_search, list_dir, and find_by_name. You cannot run commands or edit files. Answer the user's request directly, accurately, and concisely.
```

- **Trimming `agy` down to 4 read-only tools and a short 2-sentence system prompt cuts input token overhead by ~85% (~3.9k tokens instead of ~25k+), roughly halving to tripling its speed.**
- **Defense in depth:**
  - Explicit 4-tool allowlist (`view_file`, `grep_search`, `list_dir`, `find_by_name`) — all file-editing and command-execution tools are excluded from the model's tool declarations.
  - `commandExecutionPolicy: "off"` and `subagent: false` disable terminal execution and subagent spawning at the agent configuration layer.
  - Every `agy` invocation passes `--agent claude-agy-readonly`, `--sandbox`, `--disable-slash-commands`, and `--output-format stream-json`.
  - Prompts up to 128KB go via `-p`; larger ones are piped over `stdin` (so large diffs never hit OS `ARG_MAX` / `E2BIG` limits).
  - A custom agent set via `AGY_PLUGIN_AGENT` is refused unless its frontmatter is at least as restrictive (subset of the 4 tools, `commandExecutionPolicy: "off"`, `subagent: false`).
  - Known limit: agy hooks configured in your workspace or globally still run during a consult; the agent tool list does not constrain them.
  - Supervised by both an idle watchdog (default 3m) and a wall-clock backstop (default 8m, inside Claude Code's 10-minute Bash cap) with full process-group teardown (`SIGTERM` → `SIGKILL`).

---

## Install

This is a Claude Code plugin distributed as a plugin marketplace.

```text
/plugin marketplace add faeton/claude-agy-plugin
/plugin install agy@claude-agy-plugin
```

Then check your setup:

```text
/agy:setup
```

---

## Commands

| Command | What it does |
|---|---|
| `/agy:consult -- <question>` | Ask `agy` a free-form question. `--file <path>` (repeatable) attaches context. |
| `/agy:review` | Review your local git changes (working tree or branch diff). |
| `/agy:adversarial-review <focus>` | Review with extra focus instructions (e.g. "hunt for auth bypasses"). |
| `/agy:rescue <request>` | Hand a question/review to the `agy-consult` subagent (proactive, model-invocable). |
| `/agy:status [job-id]` | List recent jobs, or show one job (add `--wait` to block until done). |
| `/agy:result [job-id]` | Print the stored final output of a finished job. |
| `/agy:cancel [job-id]` | Cancel a running background job (kills `agy`'s process group cleanly). |
| `/agy:setup` | Check that `agy` is installed, authenticated, and provisioned with `claude-agy-readonly`. |

### Common flags

- `--background` — run as a tracked detached job; read it back with `/agy:status` / `/agy:result`.
- `--profile balanced|fast|deep` — model preset. **Defaults to `balanced`** (`gemini-4-argon-low`: found every planted bug in about a minute in benchmarks). `fast` is `gemini-3.8-flash-low` (about twice as fast, less reliable on cross-file bugs); `deep` is `gemini-4-argon-medium` (2-10 minutes). Set the default with `AGY_PLUGIN_PROFILE`.
- `--model <id>` / `--effort <low|medium|high|xhigh|max>` — override the profile (`AGY_PLUGIN_MODEL` / `AGY_PLUGIN_EFFORT` globally; `default` sends no flag). agy model ids carry their effort, so `--effort` is only sent when you pass it or pick a model without a suffix.
- `--scope auto|working-tree|branch` and `--base <ref>` — for reviews.
- `--timeout-ms <ms>` — wall-clock backstop (default 8 minutes).
- `--idle-ms <ms>` — kill a run that produces no output at all for this long (default 3 minutes; `0` disables).

---

### Review context

Reviews inline the full current text of the changed files next to the diff (150 KB budget, lockfiles and minified files skipped; `AGY_PLUGIN_INLINE_BYTES` changes it), and every prompt ends with a short working method (cover every changed hunk and what depends on it, batch reads, read whole functions, skip unrelated code). Both came from the same benchmark that set the grok plugin's defaults.

---

## Testing

Run the zero-dependency test suite with:

```bash
node plugins/agy/scripts/test/runner.test.mjs
node plugins/agy/scripts/test/state.test.mjs
```

---

## License

MIT © faeton
