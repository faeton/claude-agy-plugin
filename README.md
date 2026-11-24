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

You are a read-only code reviewer and technical consultant. You can read files in the repository with the file tools you have been given. You cannot run commands or edit files. Answer the user's request directly, accurately, and concisely.
```

With web access switched on (off by default), runs use a sibling agent, `claude-agy-readonly-web` (`~/.gemini/config/agents/claude-agy-readonly-web.md`), with the same four tools plus agy's `search_web` and `read_url_content`. See [Web access](#web-access).

**What agy 1.5 actually hands the model.** agy 1.5 moved searching and directory listing into `run_command`, which these agents switch off. The tool names above are still accepted, but the model only receives `read_file` (the new name of `view_file`), plus `search_web` on the web agent. Checked on agy 1.5.16: there is no grep, no directory listing and no way to open a URL. To make up for the missing search, every review and consult prompt carries the repository's file list (tracked and untracked, ignored files left out, capped at 1500 paths), so the model can pick the callers of a changed function and read them. On an older agy the four tools still work as named.

- **Trimming `agy` down to 4 read-only tools and a short 2-sentence system prompt cuts input token overhead by ~85% (~3.9k tokens instead of ~25k+), roughly halving to tripling its speed.**
- **Defense in depth:**
  - Explicit 4-tool allowlist (`view_file`, `grep_search`, `list_dir`, `find_by_name`) — all file-editing and command-execution tools are excluded from the model's tool declarations.
  - `commandExecutionPolicy: "off"` and `subagent: false` disable terminal execution and subagent spawning at the agent configuration layer.
  - Every `agy` invocation passes `--agent claude-agy-readonly` (or `claude-agy-readonly-web`), `--sandbox`, `--disable-slash-commands`, and `--output-format stream-json`.
  - Prompts up to 128KB go via `-p`; larger ones are piped over `stdin` (so large diffs never hit OS `ARG_MAX` / `E2BIG` limits).
  - A custom agent set via `AGY_PLUGIN_AGENT` is refused unless its frontmatter is at least as restrictive (subset of the 4 tools or `read_file`, plus the 2 web tools when web access is on; `commandExecutionPolicy: "off"`, `subagent: false`).
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
| `/agy:setup [--web on\|off]` | Check that `agy` is installed, authenticated, and provisioned with the read-only agents. `--web on\|off` saves the web-access default (off unless you turn it on). |

### Common flags

- `--background` — run as a tracked detached job; read it back with `/agy:status` / `/agy:result`.
- `--profile balanced|fast|deep` — model preset. **Defaults to `balanced`** (`gemini-4-neon-low`: found every planted bug in under a minute in the benchmark, about a third faster than Argon low). `fast` is `gemini-3.8-flash-low` (15-20 seconds, answers from the diff without reading other files); `deep` is `gemini-4-neon-medium` (about a minute and a half, more likely to open callers the diff does not touch). Set the default with `AGY_PLUGIN_PROFILE`.
- `--model <id>` / `--effort <low|medium|high|xhigh|max>` — override the profile (`AGY_PLUGIN_MODEL` / `AGY_PLUGIN_EFFORT` globally; `default` sends no flag). agy model ids carry their effort and agy refuses a suffixed id with a different `--effort`, so an effort is applied by swapping the suffix: `--effort high` on the default profile runs `gemini-4-neon-high`. The `--effort` flag itself is only sent for a model id without a suffix. Not every model has every level (`agy models` lists them).
- `--web` / `--no-web` — turn web search on or off for one run (see below).
- `--scope auto|working-tree|branch` and `--base <ref>` — for reviews.
- `--timeout-ms <ms>` — wall-clock backstop (default 8 minutes).
- `--idle-ms <ms>` — kill a run that produces no output at all for this long (default 3 minutes; `0` disables).

---

### Web access

Off by default: agy sees only the repository. Turn it on when you want agy to search the web (docs, changelogs, issues).

**On agy 1.5 web access means search only.** The model gets `search_web` but not `read_url_content`, so it cannot open a URL you give it; it answers from search results and says so if asked to read a specific page (checked on agy 1.5.16). If you need a particular page read, fetch it yourself and attach it with `--file`.

**How to turn web on**

- For one run, add `--web`:

  ```text
  /agy:consult --web -- what changed in the latest Node.js LTS?
  /agy:review --web
  ```

- For every run, in every workspace:

  ```text
  /agy:setup --web on
  ```

  `/agy:setup --web off` switches it back. Plain `/agy:setup` shows the current state and where it comes from (`default`, `setup` or `AGY_PLUGIN_WEB`).

- Through the environment, e.g. in `~/.claude/settings.json`:

  ```json
  { "env": { "AGY_PLUGIN_WEB": "on" } }
  ```

- When asking through the `agy-consult` subagent or `/agy:rescue`, just say you want agy to look it up online; it passes `--web`.

With web on, the agent lists `search_web` and `read_url_content` (the second only takes effect on an agy that still offers it), and the run passes `--settings '{"permissions":{"allow":["read_url(*)"]}}'` because headless agy otherwise auto-denies page fetches. That rule lives only for the run and is never written to your agy `settings.json`.

Precedence, highest first:

1. `--web` / `--no-web` on the command.
2. `AGY_PLUGIN_WEB=on|off` (e.g. in `~/.claude/settings.json` `"env"`).
3. `/agy:setup --web on|off`, saved in `~/.claude-agy/companion/settings.json` for every workspace.
4. Off.

The trade-off: a page agy reads, or text planted in the code under review, could steer it into fetching a URL that carries repository content in the query string. agy still cannot write files or run commands, which is why it is off by default. If you turn it on globally, use `--no-web` when reviewing untrusted code.

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
