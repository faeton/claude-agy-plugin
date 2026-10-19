# Changelog

All notable changes to this plugin are documented here.

## [0.1.0] — 2026-10-19

### Added

- Initial release of `claude-agy-plugin` (`agy@claude-agy-plugin`) for Claude Code, mirroring `claude-grok-plugin`.
- Automatic provisioning of the 4-tool read-only Antigravity Markdown agent (`~/.gemini/config/agents/claude-agy-readonly.md`) with `view_file`, `grep_search`, `list_dir`, `find_by_name`, `commandExecutionPolicy: "off"`, `subagent: false`, and a short 2-sentence system prompt (2x–3x speedup over default `agy` prompt overhead).
- Slash commands: `/agy:consult`, `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`, `/agy:status`, `/agy:result`, `/agy:cancel`, `/agy:setup`.
- Proactive `agy-consult` forwarding subagent and internal skills (`agy-cli-runtime`, `agy-prompting`, `agy-result-handling`).
- Supervised `agy` runner (`lib/agy.mjs`) supporting `agy --output-format stream-json`, stdin prompt delivery (avoiding `ARG_MAX`/`E2BIG`), idle and wall-clock watchdogs, and process-group teardown.
- On-disk job state machine under `~/.claude-agy/companion/` and zero-dependency test suite (`runner.test.mjs`, `state.test.mjs`).
