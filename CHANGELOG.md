# Changelog

All notable changes to this plugin are documented here.

## [0.3.0] — 2026-10-30

### Added

- **Web access, on by default.** Runs use a new agent, `claude-agy-readonly-web`, which adds agy's `search_web` and `read_url_content` to the four file tools, and pass a session-only `--settings` rule allowing `read_url(*)`, because headless agy auto-denies page fetches otherwise.
- **Web switch:** `--web` / `--no-web` per run, `AGY_PLUGIN_WEB=on|off`, and `/agy:setup --web on|off` (saved for all workspaces in `~/.claude-agy/companion/settings.json`). `/agy:setup` shows the current state and where it comes from.
- Job records store `web`; progress lines show fetched URLs.

### Fixed

- The `web` argument to `readOnlyArgs` was ignored (`void web`), so consults never had web access despite asking for it.

## [0.2.0] — 2026-10-19

Brings in the grok plugin's 0.6.x speed work, tuned for agy from the same benchmark.

### Added

- **Profiles** `--profile balanced|fast|deep` and `AGY_PLUGIN_PROFILE`: `balanced` (default) = `gemini-4-argon-low`, `fast` = `gemini-3.8-flash-low`, `deep` = `gemini-4-argon-medium`. `AGY_PLUGIN_MODEL` / `AGY_PLUGIN_EFFORT` and `--model` / `--effort` still override.
- **Reviews inline the full text of changed files** (150 KB budget, `AGY_PLUGIN_INLINE_BYTES`).
- Job records store the model, profile, effort, tool-call count and agy session id.

### Changed

- **Default model `gemini-4-argon-low`, no `--effort` flag.** Before, runs used agy's own default model at `--effort medium`, the slowest configuration in the benchmark.
- Review and consult prompts end with a working method (cover every hunk, batch reads, whole functions, skip unrelated code).
- Wall-clock timeout 15 → 8 minutes; commands, the subagent and the runtime skill pass Bash `timeout: 600000`.

### Fixed

- A timeout reports the tool-call count and last activity instead of "no response".
- An unfinished run keeps agy's reasoning tail as working notes.
- `max_turns` / `tool_use` / `pause_turn` / `timeout` stops with only a preamble now fail instead of completing.
- Effort-support detection accepts a `reasoning_efforts` menu.
- The companion's exit log no longer records `ok: true` for failed runs.
- After agy recovers from an interrupted stream, the final `result.response` is used instead of the re-streamed deltas (which held the aborted attempt plus the full answer).
- Branch reviews batch `git ls-tree` so thousands of changed paths cannot overflow argv.

## [0.1.0] — 2026-10-19

### Added

- Initial release of `claude-agy-plugin` (`agy@claude-agy-plugin`) for Claude Code, mirroring `claude-grok-plugin`.
- Automatic provisioning of the 4-tool read-only Antigravity Markdown agent (`~/.gemini/config/agents/claude-agy-readonly.md`) with `view_file`, `grep_search`, `list_dir`, `find_by_name`, `commandExecutionPolicy: "off"`, `subagent: false`, and a short 2-sentence system prompt (2x–3x speedup over default `agy` prompt overhead).
- Slash commands: `/agy:consult`, `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`, `/agy:status`, `/agy:result`, `/agy:cancel`, `/agy:setup`.
- Proactive `agy-consult` forwarding subagent and internal skills (`agy-cli-runtime`, `agy-prompting`, `agy-result-handling`).
- Supervised `agy` runner (`lib/agy.mjs`) supporting `agy --output-format stream-json`, stdin prompt delivery (avoiding `ARG_MAX`/`E2BIG`), idle and wall-clock watchdogs, and process-group teardown.
- On-disk job state machine under `~/.claude-agy/companion/` and zero-dependency test suite (`runner.test.mjs`, `state.test.mjs`).
