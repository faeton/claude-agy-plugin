---
name: agy-prompting
description: Internal guidance for composing sharp Antigravity (agy) prompts for consultation and review inside the agy plugin
user-invocable: false
---

# Antigravity (agy) Prompting

Use this skill when `agy:agy-consult` needs to tighten the user's request into a better `agy` prompt before the single companion call. Prompt drafting is the only Claude-side work allowed — never solve the task yourself.

Principles:
- One clear ask per run. Split unrelated questions into separate consults.
- State what a good answer looks like (format, length, what to optimize for) instead of assuming `agy` will infer it.
- Give `agy` the grounding it needs as `--file` context rather than pasting huge blobs into the question — the companion attaches files cleanly and caps their size, and `agy`'s read-only agent can also inspect repo files directly with `view_file`, `grep_search`, `list_dir`, and `find_by_name`.
- For a second opinion, frame it adversarially: ask `agy` to find what is *wrong* or *risky*, not to agree. `agy` is most useful as an independent skeptic.

Recipe for a consult:
- Lead with the concrete question in one or two sentences.
- Add the decision or constraint that matters ("must stay zero-dependency", "targeting Node 18", "this is hot-path code").
- Name the output shape: "answer in ≤5 bullets", "give the literal flags", "rank the options".
- Attach relevant files with `--file` instead of describing them.

Recipe for a review:
- Prefer `review` (it builds the diff prompt for you). Use `adversarial-review <focus>` when the user wants a specific hunt (e.g. "concurrency bugs in the new pool", "auth bypass paths").
- Keep focus text specific and falsifiable.

Keep `agy` requests compact and focused. If a request is huge, narrow the scope or split it rather than sending one giant prompt.
