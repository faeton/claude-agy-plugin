---
description: Hand a question or code review to Google Antigravity (agy) via the agy-consult subagent
argument-hint: '[--wait|--background] [--file <path>]... <question or review request>'
allowed-tools: Agent, Bash(node:*)
---

Forward the user's request to the `agy-consult` subagent (Google Antigravity `agy`).

Raw slash-command arguments:
`$ARGUMENTS`

Routing rules:

- Invoke the `agy-consult` subagent via the `Agent` tool (`subagent_type: "agy:agy-consult"`), forwarding `$ARGUMENTS` as the prompt.
- Do not answer the question or perform the review yourself — the subagent forwards it to `agy`.
- Execution mode:
  - If `$ARGUMENTS` includes `--background`, run the subagent in the background.
  - If it includes `--wait`, run it in the foreground.
  - Otherwise default to foreground for a small, clearly bounded ask; background for a large or open-ended one.
- `--file <path>` and any `--profile` / `--effort` / `--model` flags are for `agy` — leave them in the forwarded text so the subagent passes them through.
- Return the subagent's output verbatim. Do not paraphrase, summarize, or act on `agy`'s findings in this turn.
