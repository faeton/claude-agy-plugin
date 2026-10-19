---
description: Cancel an active background Antigravity (agy) job in this workspace
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel '$ARGUMENTS'`

Present the command output verbatim. If no job ID was given, the companion cancels the most recent job for this workspace.
