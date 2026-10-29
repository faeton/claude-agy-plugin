---
description: Check whether the local Antigravity (agy) CLI is installed, authenticated, and provisioned with the read-only agent; --web on|off switches web access
argument-hint: '[--web on|off]'
allowed-tools: Bash(node:*)
---

Raw slash-command arguments:
`$ARGUMENTS`

If the arguments contain `--web on` or `--web off` (also `--web=on` / `--web=off`), pass that through; otherwise pass nothing. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup [--web on|off] --json
```

Present the result to the user:
- If `ready` is true, say Antigravity (`agy`) is ready and show the provisioned read-only agent path.
- Say whether web access (`search_web` / `read_url_content`) is on or off, and where that comes from (`web.source`: `default`, `setup`, `AGY_PLUGIN_WEB`). If `--web` was passed, confirm the new default is saved for every workspace; `--web` / `--no-web` on a single run still override it.
- If the `agy` CLI is missing, tell the user to install it and make sure `agy` is on their PATH.
- If the CLI is present but not authenticated, tell the user to run `!agy` once to sign in.
- Surface the `nextSteps` list verbatim.

Do not attempt to install or log in on the user's behalf.
