---
name: agy-cli-runtime
description: Internal helper contract for calling the agy-companion runtime from Claude Code
user-invocable: false
---

# Antigravity (agy) Runtime

Use this skill only inside the `agy:agy-consult` subagent (and when reasoning about how agy commands shell out).

Primary helpers (one `Bash` call each, never combined):
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" consult [flags] -- <question>`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review [flags]`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review [flags] [focus text]`

Execution rules:
- The subagent is a forwarder, not an orchestrator. Invoke exactly once and return stdout unchanged.
- Prefer the helper over hand-rolled `git`, raw `agy` strings, or any other Bash activity.
- **Always read-only and trimmed for speed.** The companion automatically provisions and selects the custom read-only Markdown agent `claude-agy-readonly` (`~/.gemini/config/agents/claude-agy-readonly.md`), which restricts `agy` to an explicit 4-tool allowlist (`view_file`, `grep_search`, `list_dir`, `find_by_name`), sets `commandExecutionPolicy: "off"` and `subagent: false`, and uses a short 2-sentence system prompt that cuts prompt overhead by ~85% (2x–3x faster responses). Every call also runs with `--sandbox`, `--disable-slash-commands`, and `--output-format stream-json`, supervised by idle and wall-clock watchdogs. Never add flags that would re-enable editing, and never call `agy` directly — that bypasses the safety wrapper.
- Leave `--effort` / `--model` unset unless the user explicitly asked. Effort defaults to `medium` (overridable with `AGY_PLUGIN_EFFORT`).
- Shell-quote the question: pass it after `--` inside single quotes (escape any embedded `'` as `'\''`), never in double quotes or bare — `$(...)`, backticks and `;` in the text would otherwise run in the shell.
- **Always run the companion in the foreground — never pass the companion's `--background`.** Strip `--wait`/`--background` from the natural-language task text. Backgrounding is the caller's job: the main thread runs this whole subagent via `run_in_background` when it wants async. The companion's `--background` detaches its own worker, which gets orphaned the moment this subagent returns and its process tree is torn down (the worker then reconciles to `failed` / "Worker process exited without finishing"). Foreground is the only safe mode inside the subagent.

Command selection:
- Free-form question or "what do you think of X" → `consult`. Put the whole question after `--`.
- "Review my changes / this diff / this branch" → `review` (add `--scope` / `--base` if the user specified).
- "Review, and specifically hunt for <X>" → `adversarial-review <X>`.
- Background jobs (created only by the direct `/agy:consult` / `/agy:review` slash commands, never by this subagent) are tracked: the user reads them back with `/agy:status`, `/agy:result <id>`, `/agy:cancel <id>`. Do not poll these yourself from the subagent.

Failure handling:
- If the companion says `agy` is missing/unauthenticated, return that verbatim and stop (point the user at `/agy:setup`).
- If it reports a timeout or cancellation, return that verbatim. Do not retry silently or answer yourself.
