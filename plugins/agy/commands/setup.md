---
description: Check whether the local Antigravity (agy) CLI is installed, authenticated, and provisioned with the read-only agent
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json
```

Present the result to the user:
- If `ready` is true, say Antigravity (`agy`) is ready and show the provisioned read-only agent path.
- If the `agy` CLI is missing, tell the user to install it and make sure `agy` is on their PATH.
- If the CLI is present but not authenticated, tell the user to run `!agy` once to sign in.
- Surface the `nextSteps` list verbatim.

Do not attempt to install or log in on the user's behalf.
