// Everything that talks to the `agy` CLI: availability/auth, 4-tool read-only
// custom agent provisioning, read-only flag construction, and the supervised
// runner (watchdogs + stream-json envelope parsing).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

// Wall-clock watchdog (8 minutes). Under 9 minutes so a foreground run finishes,
// and saves its result, inside Claude Code's 10-minute Bash cap instead of being
// moved to the background mid-run. With the default profile a review takes 1-3
// minutes; stalls are caught much earlier by the idle timer below.
export const DEFAULT_TIMEOUT_MS = 8 * 60_000;

// Kill a run that has produced NO output at all for this long (3 minutes).
export const DEFAULT_IDLE_MS = 3 * 60_000;

// Prompts up to 128KB are passed via `-p <prompt>` with stdin closed (matching
// the benchmark harness used to tune this plugin). Prompts larger than
// 128KB are piped via stdin to avoid OS argv limits (E2BIG at ~256KB on macOS).
const MAX_ARGV_PROMPT_BYTES = 128_000;

function resolveAgyBin() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  const candidates = [
    resolve(homedir(), ".local", "bin", "agy"),
    resolve(homedir(), ".gemini", "antigravity-cli", "bin", "agy"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "agy";
}

export const AGY_BIN = resolveAgyBin();

// Antigravity's application data directory (~/.gemini/antigravity-cli) and
// shared customization config directory (~/.gemini/config).
const AGY_HOME = process.env.AGY_HOME
  ? resolve(process.env.AGY_HOME)
  : resolve(homedir(), ".gemini", "antigravity-cli");

const AGY_CONFIG_HOME = process.env.AGY_CONFIG_HOME
  ? resolve(process.env.AGY_CONFIG_HOME)
  : resolve(homedir(), ".gemini", "config");

// Per-run temp directory prefix for `--log-file`. Doubles as the unique process
// marker in `ps` so `/agy:cancel` only signals our own `agy` process groups.
export const RUN_DIR_PREFIX = "agy-companion-run-";

// Upper bound on synchronous `agy` probes.
const MODEL_PROBE_TIMEOUT_MS = 10_000;

// Model IDs in agy often bake the effort level into the suffix (e.g.
// `gemini-4-argon-low`, `gemini-4-argon-medium`, `gemini-3.8-flash-low`).
const MODEL_EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/i;

// The model, chosen as a named profile; effort is baked into agy model ids.
// Measured on the same planted-bug review prompts as the grok plugin
// (2026-10-19, agy 1.4.2, with the read-only agent and working-method prompt):
// argon low found every planted bug in 50-65s and ~2.5 min on a large consult;
// flash low was about twice as fast but missed or invented bugs on the harder
// diffs; argon medium took 2-10 minutes for the same recall. With no model
// default the run inherited agy's own default (and its `--effort medium`), the
// slow configuration.
export const PROFILES = {
  balanced: { model: "gemini-4-argon-low" },
  fast: { model: "gemini-3.8-flash-low" },
  deep: { model: "gemini-4-argon-medium" },
};
export const DEFAULT_PROFILE = "balanced";

// Precedence, highest first: --model / --effort, --profile, AGY_PLUGIN_MODEL /
// AGY_PLUGIN_EFFORT, AGY_PLUGIN_PROFILE, then `balanced`. The env vars are read
// at call time (set them in ~/.claude/settings.json "env"). `default` for a
// model or effort sends no flag and lets agy pick.
export function resolveProfile(name) {
  const n = name || process.env.AGY_PLUGIN_PROFILE || DEFAULT_PROFILE;
  const p = Object.hasOwn(PROFILES, n) ? PROFILES[n] : null;
  if (!p) {
    const src = name ? "--profile" : "AGY_PLUGIN_PROFILE";
    throw new Error(`Unknown ${src} "${n}" (expected ${Object.keys(PROFILES).join(", ")}).`);
  }
  return { name: n, ...p, explicit: Boolean(name) };
}

// Resolve the model a run uses, or null for "send no --model flag".
export function resolveModel(model, profile) {
  const p = resolveProfile(profile);
  const m = model || (p.explicit ? p.model : process.env.AGY_PLUGIN_MODEL || p.model);
  return m === "default" ? null : m;
}

function resolveEffort(effort, profile) {
  const p = resolveProfile(profile);
  return effort || (p.explicit ? null : process.env.AGY_PLUGIN_EFFORT || null);
}

// The custom Markdown-defined read-only agent provisioned into
// ~/.gemini/config/agents/claude-agy-readonly.md.
// Trimming agy down to these 4 read-only tools and a short 2-sentence system
// prompt cuts prompt overhead from ~12.6k+ to ~4.0k input tokens per call
// (2x-3x faster in tool loops) while enforcing strict read-only behavior
// (`commandExecutionPolicy: "off"`, `subagent: false`).
export const DEFAULT_READONLY_AGENT = "claude-agy-readonly";
export const READONLY_AGENT_NAME = process.env.AGY_PLUGIN_AGENT || DEFAULT_READONLY_AGENT;
export const READONLY_TOOLS = ["view_file", "grep_search", "list_dir", "find_by_name"];

export const READONLY_AGENT_MARKDOWN = `---
name: ${DEFAULT_READONLY_AGENT}
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
`;

// Check a custom agent's frontmatter: an explicit tool list that is a subset of
// READONLY_TOOLS, commands off, no subagents. Returns a reason string or null.
export function readOnlyAgentProblem(markdown) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  if (!fm) return "no YAML frontmatter.";
  const block = /^tools:\s*\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m.exec(fm)?.[1];
  if (!block) return "no explicit `tools:` list.";
  const tools = block
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*-\s*/, "").replace(/["']/g, "").trim())
    .filter(Boolean);
  const extra = tools.filter((t) => !READONLY_TOOLS.includes(t));
  if (extra.length) return `non-read-only tool(s): ${extra.join(", ")}.`;
  if (!/^commandExecutionPolicy:\s*["']?off["']?\s*$/m.test(fm)) {
    return '`commandExecutionPolicy` is not "off".';
  }
  if (!/^subagent:\s*false\s*$/m.test(fm)) return "`subagent` is not false.";
  return null;
}

// Ensure the 4-tool read-only agent exists in ~/.gemini/config/agents/.
// Lives outside the user's repository so it never dirties git status.
export function ensureReadOnlyAgent() {
  const agentsDir = resolve(AGY_CONFIG_HOME, "agents");
  const agentPath = resolve(agentsDir, `${READONLY_AGENT_NAME}.md`);
  try {
    mkdirSync(agentsDir, { recursive: true });
    if (READONLY_AGENT_NAME === DEFAULT_READONLY_AGENT) {
      let current = null;
      try {
        current = readFileSync(agentPath, "utf8");
      } catch {
        /* does not exist yet */
      }
      if (current !== READONLY_AGENT_MARKDOWN) {
        writeFileSync(agentPath, READONLY_AGENT_MARKDOWN, "utf8");
      }
    } else if (!existsSync(agentPath)) {
      return {
        provisioned: false,
        name: READONLY_AGENT_NAME,
        path: agentPath,
        tools: READONLY_TOOLS,
        error: `Custom agent "${READONLY_AGENT_NAME}" not found at ${agentPath}.`,
      };
    } else {
      // A custom agent replaces our tool list, so it must be no less restrictive.
      const problem = readOnlyAgentProblem(readFileSync(agentPath, "utf8"));
      if (problem) {
        return {
          provisioned: false,
          name: READONLY_AGENT_NAME,
          path: agentPath,
          tools: READONLY_TOOLS,
          error: `Custom agent "${READONLY_AGENT_NAME}" is not read-only: ${problem}`,
        };
      }
    }
    return {
      provisioned: true,
      name: READONLY_AGENT_NAME,
      path: agentPath,
      tools: READONLY_TOOLS,
      error: null,
    };
  } catch (err) {
    return {
      provisioned: false,
      name: READONLY_AGENT_NAME,
      path: agentPath,
      tools: READONLY_TOOLS,
      error: err.message,
    };
  }
}

// Compare stopReasons / result statuses case- and separator-insensitively.
const normReason = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, "");

// agy produced its answer and stopped cleanly (`status: "SUCCESS"` in
// stream-json, or ACP `end_turn` / `EndTurn`).
const GOOD_STOP_REASONS = new Set(["success", "ok", "endturn", "stop", "completed", "done"]);

// The run genuinely failed and any text is not a usable answer.
const BAD_STOP_REASONS = new Set(["cancelled", "canceled", "refusal", "error", "failed", "aborted"]);

// The answer was being written and got cut by the output-token limit: the text
// is real but incomplete, so it is returned with a warning.
const TRUNCATED_STOP_REASONS = new Set(["maxtokens"]);

// The model ran out of turns or time, or stopped to call a tool, before it wrote
// its answer. What text exists is preamble ("I'll review the catch code…"), not
// a result, so the run fails with the text kept as partial output.
const UNFINISHED_STOP_REASONS = new Set([
  "maxturns",
  "maxturnrequests",
  "maxturnsreached",
  "tooluse",
  "pauseturn",
  "timeout",
]);

const UNKNOWN_REASON_MIN_TEXT = 16;

// Decide run outcome from the envelope. Single source of truth: callers must not
// re-derive `ok` from text/exit code separately.
export function classifyStopReason(stopReason, text, { deniedActions } = {}) {
  const body = (text ?? "").trim();
  const n = stopReason ? normReason(stopReason) : "";

  if (n === "cancelled" || n === "canceled") {
    return {
      ok: false,
      errorMessage:
        "agy stopped early (status=cancelled) — the request was cancelled. Retry, or lower the request size.",
    };
  }
  if (BAD_STOP_REASONS.has(n)) {
    return { ok: false, errorMessage: `agy stopped early (stopReason=${stopReason}).` };
  }
  if (UNFINISHED_STOP_REASONS.has(n)) {
    return {
      ok: false,
      errorMessage: `agy stopped before writing its answer (stopReason=${stopReason}).`,
    };
  }
  if (TRUNCATED_STOP_REASONS.has(n)) {
    return body
      ? { ok: true, warning: `Answer is truncated (stopReason=${stopReason}).` }
      : { ok: false, errorMessage: `agy truncated with no text (stopReason=${stopReason}).` };
  }
  if (!n || GOOD_STOP_REASONS.has(n)) {
    if (body) return { ok: true };
    if (Array.isArray(deniedActions) && deniedActions.length > 0) {
      return {
        ok: false,
        errorMessage: `agy aborted the turn with an empty response after denying tool action(s): ${deniedActions.join(", ")}.`,
      };
    }
    return {
      ok: false,
      errorMessage: "agy returned an empty response (possible backend cancellation).",
    };
  }
  return body.length >= UNKNOWN_REASON_MIN_TEXT
    ? { ok: true, warning: `Unrecognized stopReason=${stopReason}; answer returned as-is.` }
    : { ok: false, errorMessage: `Unrecognized stopReason=${stopReason} with no usable text.` };
}

export const SANDBOX_PROFILE = "sandbox";
const SANDBOX_FAILED = /sandbox could not be applied|failed to apply sandbox|refusing to start with denied paths/i;
const SANDBOX_REFUSED = /bwrap|bubblewrap|could not enforce its deny list/i;
const BWRAP_HINT =
  "agy could not start its terminal sandbox on this host (on Linux it may need " +
  "bubblewrap, `bwrap`, on PATH).";

// `--sandbox` is agy's own terminal sandbox with a native per-platform
// implementation, so it is always requested. Probing for grok's `bwrap`
// dependency here silently dropped it on Linux hosts that could sandbox fine. A
// failure to apply it is caught at run time (SANDBOX_FAILED / SANDBOX_REFUSED).
export function sandboxAvailability() {
  return { available: true, required: true, warning: null };
}

// Read-only argv shared by consult and review:
// - `--agent claude-agy-readonly` restricts agy to 4 read-only tools
//   (`view_file`, `grep_search`, `list_dir`, `find_by_name`) with
//   `commandExecutionPolicy: "off"`, `subagent: false`, and a short prompt.
// - `--disable-slash-commands` prevents `/skill` or `/command` expansion in
//   arbitrary prompt text.
// - `--sandbox` enables agy's OS sandbox restrictions.
export function readOnlyArgs({ web = true, sandbox = true, agent = READONLY_AGENT_NAME } = {}) {
  void web;
  return [
    "--agent",
    agent,
    "--disable-slash-commands",
    ...(sandbox ? ["--sandbox"] : []),
  ];
}

export function getAgyAvailability() {
  const res = spawnSync(AGY_BIN, ["--version"], { encoding: "utf8", timeout: MODEL_PROBE_TIMEOUT_MS });
  if (res.error || res.status !== 0) {
    return { available: false, version: null, bin: AGY_BIN };
  }
  return { available: true, version: res.stdout.trim(), bin: AGY_BIN };
}

// Auth heuristic: API key env var, or ~/.gemini/antigravity-cli state files
// (`auth.json`, `installation_id`, or `state.vscdb`).
export function getAgyAuthStatus() {
  if (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  ) {
    return { loggedIn: true };
  }
  for (const file of ["auth.json", "oauth_creds.json"]) {
    try {
      const raw = readFileSync(resolve(AGY_HOME, file), "utf8");
      const json = JSON.parse(raw);
      if (json && Object.keys(json).length > 0) return { loggedIn: true };
    } catch {
      /* try next */
    }
  }
  for (const marker of ["installation_id", "state.vscdb"]) {
    try {
      if (existsSync(resolve(AGY_HOME, marker))) return { loggedIn: true };
    } catch {
      /* ignore */
    }
  }
  return { loggedIn: false };
}

export function detectDefaultModel() {
  const res = spawnSync(AGY_BIN, ["models"], {
    encoding: "utf8",
    timeout: MODEL_PROBE_TIMEOUT_MS,
  });
  if (res.error || res.status !== 0) return null;
  const m =
    res.stdout.match(/Default model:\s*(\S+)/i) ||
    res.stdout.match(/\*\s+(\S+)/);
  return m ? m[1] : null;
}

export function modelSupportsReasoningEffort(modelId) {
  try {
    const cachePath = resolve(AGY_HOME, "models_cache.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    // An advertised `reasoning_efforts` menu is support; only an explicit
    // `supports_reasoning_effort: false` is "unsupported".
    const info = cache.models?.[modelId]?.info;
    if (!info) return null;
    if (Array.isArray(info.reasoning_efforts) && info.reasoning_efforts.length) return true;
    if (typeof info.supports_reasoning_effort === "boolean") return info.supports_reasoning_effort;
    return null;
  } catch {
    return null;
  }
}

// Build the effort-related argv. Returns { args, dropped } where dropped is a
// message or null. Profiles carry no effort (it is in the model id), so the flag
// is only sent for an explicit --effort or AGY_PLUGIN_EFFORT, and never when the
// model id already bakes one in unless --effort was passed explicitly.
export function effortArgs({ effort, reasoningEffort, model, profile }) {
  const explicit = Boolean(effort || reasoningEffort);
  const resolvedModel = resolveModel(model, profile);
  if (!explicit && resolvedModel && MODEL_EFFORT_SUFFIX.test(resolvedModel)) {
    return { args: [], dropped: null };
  }
  let level = resolveEffort(effort || reasoningEffort, profile);
  if (level === "default") level = null;
  if (!level) return { args: [], dropped: null };
  const targetModel =
    resolvedModel ||
    (existsSync(resolve(AGY_HOME, "models_cache.json")) ? detectDefaultModel() : null);
  const supported = targetModel ? modelSupportsReasoningEffort(targetModel) : null;
  if (supported !== false) return { args: ["--effort", level], dropped: null };
  if (!explicit) return { args: [], dropped: null };
  return {
    args: [],
    dropped: `${targetModel} does not support reasoning effort — dropped --effort ${level}.`,
  };
}

// agy is spawned detached, so it leads its own process group and every signal
// goes to the group: a descendant (such as its language_server child) is never
// left behind holding the repo.
export function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

function probe(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return probe(-pid) || probe(pid);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function terminateGroups(pids, { graceMs = 5_000 } = {}) {
  const live = pids.filter((pid) => groupAlive(pid));
  for (const pid of live) signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (live.some(groupAlive) && Date.now() < deadline) await sleep(100);
  for (const pid of live) if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
}

const activeChildren = new Set();

export function terminateActiveAgy(options) {
  return terminateGroups(
    [...activeChildren].map((child) => child.pid),
    options,
  );
}

// Create a private per-run directory holding the CLI log file.
// Passing `--log-file <dir>/agy.log` puts RUN_DIR_PREFIX in agy's command line
// so `/agy:cancel` can verify the PID via `ps`.
function createRunDir() {
  const dir = mkdtempSync(join(tmpdir(), RUN_DIR_PREFIX));
  const logPath = join(dir, "agy.log");
  return { dir, logPath };
}

// Parse agy's output envelope: { text, stopReason, sessionId, thought, ... }.
//
// Supports both wire formats:
// 1. `agy --output-format stream-json` (NDJSON with `event`: "init" | "step_update" | "result" | "error")
// 2. `agy --output-format json` (single JSON object: { conversation_id, status, response, ... })
// 3. ACP-compatible streaming events (`type`: "text" | "thought" | "end" | "error")
export function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const single = JSON.parse(trimmed);
    if (
      single &&
      typeof single === "object" &&
      single.event === undefined &&
      single.type === undefined
    ) {
      return {
        ...single,
        text: single.response ?? single.text ?? "",
        stopReason: single.status ?? single.stopReason ?? null,
        sessionId: single.conversation_id ?? single.sessionId ?? null,
        deniedActions: single.denied_actions ?? null,
      };
    }
  } catch {
    /* not a single object — fall through to the NDJSON stream reader */
  }

  const text = [];
  const thought = [];
  const meta = {};
  let sawEvent = false;
  let resultResponse = null;
  let legacy = null;

  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj == null || typeof obj !== "object") continue;

    // Native `agy --output-format stream-json` event stream
    if (obj.event !== undefined) {
      sawEvent = true;
      switch (obj.event) {
        case "init":
          if (obj.conversation_id) meta.sessionId = obj.conversation_id;
          else if (obj.init?.conversation_id) meta.sessionId = obj.init.conversation_id;
          break;
        case "step_update": {
          const su = obj.step_update ?? obj;
          if (su.conversation_id) meta.sessionId = su.conversation_id;
          if (typeof su.text_delta === "string") text.push(su.text_delta);
          if (typeof su.thinking_delta === "string") thought.push(su.thinking_delta);
          break;
        }
        case "result": {
          const res = obj.result ?? obj;
          meta.sawEnd = true;
          if (res.status !== undefined) meta.stopReason = res.status;
          else if (res.stopReason !== undefined) meta.stopReason = res.stopReason;
          if (res.conversation_id !== undefined) meta.sessionId = res.conversation_id;
          else if (obj.conversation_id !== undefined) meta.sessionId = obj.conversation_id;
          if (typeof res.response === "string") resultResponse = res.response;
          if (Array.isArray(res.denied_actions) && res.denied_actions.length > 0) {
            meta.deniedActions = res.denied_actions;
          }
          if (res.error) meta.errorEvent = String(res.error?.message ?? res.error);
          break;
        }
        case "error": {
          const msg = obj.error?.message ?? obj.error ?? obj.message;
          if (msg) meta.errorEvent = String(msg);
          break;
        }
        default:
          break;
      }
      continue;
    }

    // ACP-style `type`-tagged events (for compatibility)
    switch (obj.type) {
      case "text":
        sawEvent = true;
        if (typeof obj.data === "string") text.push(obj.data);
        break;
      case "thought":
        sawEvent = true;
        if (typeof obj.data === "string") thought.push(obj.data);
        break;
      case "end":
        sawEvent = true;
        if (obj.stopReason !== undefined) meta.stopReason = obj.stopReason;
        if (obj.sessionId !== undefined) meta.sessionId = obj.sessionId;
        meta.sawEnd = true;
        break;
      case "error":
        sawEvent = true;
        if (obj.message) meta.errorEvent = String(obj.message);
        break;
      case undefined:
        if (obj.text !== undefined || obj.response !== undefined) {
          legacy = {
            ...(legacy ?? {}),
            ...obj,
            text: obj.response ?? obj.text,
            stopReason: obj.status ?? obj.stopReason,
            sessionId: obj.conversation_id ?? obj.sessionId,
          };
        }
        for (const key of ["stopReason", "sessionId", "thought"]) {
          if (obj[key] !== undefined) meta[key] = obj[key];
        }
        break;
      default:
        sawEvent = true;
        break;
    }
  }

  if (legacy && !text.length && resultResponse === null) return { ...meta, ...legacy };
  if (sawEvent || text.length || resultResponse !== null) {
    // The result event's response is the final answer. After agy recovers from an
    // interrupted stream it re-streams the answer, so the joined deltas would hold
    // the aborted attempt followed by the full one.
    const combinedText = resultResponse || text.join("");
    return {
      ...meta,
      streamed: true,
      text: combinedText,
      thought: thought.join("") || null,
    };
  }
  return Object.keys(meta).length ? meta : null;
}

// Run `agy` under supervision. Resolves (never rejects) with a normalized
// result so callers can record a clean failure instead of hanging.
//
// Notes from benchmarking agy:
// - `--print-timeout <sec>s` is always passed
//   explicitly matching `timeoutMs` so agy and the watchdog agree on the limit.
// - Prompts <= 128KB are passed via `-p <prompt>` with stdin closed (matching
//   the benchmark); larger prompts (>128KB) are piped over stdin to avoid E2BIG.
export function runAgy(args, options = {}) {
  const {
    prompt,
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    idleMs = DEFAULT_IDLE_MS,
    graceMs = 5_000,
    onProgress,
    onSpawn,
  } = options;

  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    let runDir = null;
    let child;
    try {
      runDir = createRunDir();
      const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
      const useStdin =
        prompt !== undefined && Buffer.byteLength(prompt, "utf8") > MAX_ARGV_PROMPT_BYTES;
      const fullArgs = [
        "--log-file",
        runDir.logPath,
        "--print-timeout",
        `${timeoutSec}s`,
        ...(prompt !== undefined && !useStdin ? ["-p", prompt] : []),
        ...args,
      ];
      const childEnv = { ...process.env };
      delete childEnv.CLAUDECODE;
      for (const k of Object.keys(childEnv)) {
        if (k.startsWith("CLAUDE_CODE")) delete childEnv[k];
      }
      child = spawn(AGY_BIN, fullArgs, {
        cwd,
        env: childEnv,
        detached: true,
        stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (useStdin && child.stdin) {
        child.stdin.on("error", () => {
          /* child may exit before draining stdin */
        });
        child.stdin.end(prompt, "utf8");
      }
    } catch (err) {
      resolveRun({
        ok: false,
        exitCode: 127,
        signal: null,
        timedOut: false,
        text: "",
        stopReason: null,
        sessionId: null,
        thought: null,
        stderr: "",
        errorMessage: `Failed to spawn agy: ${err.message}`,
        durationMs: 0,
        raw: null,
      });
      if (runDir) rmSync(runDir.dir, { recursive: true, force: true });
    }
    if (!child) return;
    activeChildren.add(child);
    onSpawn?.({ pid: child.pid });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let idledOut = false;
    let sandboxFailed = false;
    let killTimer = null;
    let idleTimer = null;

    const abort = () => {
      if (killTimer) return;
      signalGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), graceMs);
    };

    const watchdog = setTimeout(() => {
      timedOut = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      abort();
    }, timeoutMs);

    const touch = () => {
      if (!idleMs || timedOut || idledOut) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (timedOut) return;
        idledOut = true;
        timedOut = true;
        clearTimeout(watchdog);
        abort();
      }, idleMs);
    };
    touch();

    let pending = "";
    // What the run was doing, so a timeout can say so instead of "no response".
    const activity = { toolCalls: 0, lastEventAt: null };

    // Stateful decoding: a multibyte character split across chunks stays intact.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (buf) => {
      touch();
      const chunk = buf.toString("utf8");
      stdout += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let event;
        try {
          event = JSON.parse(t);
        } catch {
          continue; /* not a json line */
        }
        activity.lastEventAt = Date.now();
        const su = event?.event === "step_update" ? (event.step_update ?? event) : null;
        if ((su?.step_type === "tool" && su.state === "DONE") || event?.type === "tool_call") {
          activity.toolCalls++;
        }
        onProgress?.(event);
      }
    });

    child.stderr.on("data", (buf) => {
      touch();
      stderr += buf.toString("utf8");
      if (!sandboxFailed && SANDBOX_FAILED.test(stderr)) {
        sandboxFailed = true;
        clearTimeout(watchdog);
        if (idleTimer) clearTimeout(idleTimer);
        abort();
      }
    });

    let finished = false;
    const finish = async (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      if (idleTimer) clearTimeout(idleTimer);
      if (runDir) rmSync(runDir.dir, { recursive: true, force: true });
      if (killTimer) clearTimeout(killTimer);
      // Also after a clean exit: a descendant that closed its pipes can outlive
      // the leader. No-op when the group is already gone.
      await terminateGroups([child.pid], { graceMs });
      activeChildren.delete(child);
      resolveRun({ ...result, durationMs: Date.now() - startedAt });
    };

    child.on("error", (err) => {
      finish({
        ok: false,
        exitCode: 127,
        signal: null,
        timedOut,
        text: "",
        stopReason: null,
        sessionId: null,
        thought: null,
        stderr,
        errorMessage: `Failed to spawn agy: ${err.message}`,
        raw: null,
      });
    });

    child.on("close", (code, signal) => {
      const envelope = parseEnvelope(stdout);
      const text = (envelope?.text ?? (envelope ? "" : stdout)).trim();
      const stopReason = envelope?.stopReason ?? null;
      const deniedActions = envelope?.deniedActions ?? null;

      let ok;
      let errorMessage = null;
      let warning = null;
      const completeTurn = Boolean(envelope?.streamed && envelope.sawEnd && text);

      if (sandboxFailed) {
        ok = false;
        errorMessage =
          `agy could not apply the ${SANDBOX_PROFILE} sandbox, so the run was stopped ` +
          `rather than continue unsandboxed: ${firstStderrLine(stderr)}`;
      } else if (!completeTurn && code !== 0 && SANDBOX_REFUSED.test(stderr)) {
        ok = false;
        sandboxFailed = true;
        errorMessage = `${firstStderrLine(stderr)} ${BWRAP_HINT}`;
      } else if (completeTurn) {
        const verdict = classifyStopReason(stopReason, text, { deniedActions });
        ok = verdict.ok;
        warning = verdict.warning ?? null;
        errorMessage = verdict.ok
          ? null
          : envelope?.errorEvent || firstStderrLine(stderr) || verdict.errorMessage;
        if (ok && (idledOut || timedOut)) {
          warning = warning
            ? `${warning} (Process was killed after the answer completed.)`
            : "Answer completed, but the process had to be killed afterwards.";
        }
      } else if (idledOut) {
        ok = false;
        errorMessage =
          `No output from agy for ${Math.round(idleMs / 1000)}s — the model connection stalled. ` +
          `Retry, or lower the request size.`;
      } else if (timedOut) {
        ok = false;
        errorMessage = timeoutMessage(timeoutMs, activity);
      } else if (code !== 0) {
        ok = false;
        errorMessage =
          envelope?.errorEvent ||
          firstStderrLine(stderr) ||
          `agy exited with code ${code}.`;
      } else if (envelope?.errorEvent) {
        ok = false;
        errorMessage = envelope.errorEvent;
      } else if (envelope?.streamed && envelope.sawEnd) {
        const verdict = classifyStopReason(stopReason, text, { deniedActions });
        ok = verdict.ok;
        warning = verdict.warning ?? null;
        errorMessage = verdict.ok
          ? null
          : firstStderrLine(stderr) || verdict.errorMessage;
      } else if (envelope?.streamed && !envelope.sawEnd) {
        ok = false;
        errorMessage = text
          ? "Stream ended without a final result event — the answer is incomplete."
          : firstStderrLine(stderr) ||
            "agy produced no output and the stream ended without a final result event.";
      } else {
        const verdict = classifyStopReason(stopReason, text, { deniedActions });
        ok = verdict.ok;
        warning = verdict.warning ?? null;
        errorMessage = verdict.ok
          ? null
          : firstStderrLine(stderr) || verdict.errorMessage;
      }

      finish({
        ok,
        warning,
        exitCode: timedOut ? 124 : code ?? 1,
        signal,
        timedOut,
        idledOut,
        sandboxFailed,
        text,
        stopReason,
        sessionId: envelope?.sessionId ?? null,
        thought: envelope?.thought ?? null,
        stderr,
        errorMessage,
        toolCalls: activity.toolCalls,
        raw: envelope,
      });
    });
  });
}

// The wall-clock deadline fired. Say what agy was doing: "no response" was wrong
// for the common case of a run busy reading files right up to the deadline.
export function timeoutMessage(timeoutMs, { toolCalls = 0, lastEventAt = null } = {}, now = Date.now()) {
  const secs = Math.round(timeoutMs / 1000);
  if (!lastEventAt) {
    return `Timed out after ${secs}s with no output from agy.`;
  }
  const ago = Math.max(0, Math.round((now - lastEventAt) / 1000));
  return (
    `Timed out after ${secs}s before agy wrote its answer. It was still working ` +
    `(${toolCalls} tool call${toolCalls === 1 ? "" : "s"}, last activity ${ago}s ago). ` +
    `Narrow the question or diff, or raise --timeout-ms.`
  );
}

function firstStderrLine(stderr) {
  const line = String(stderr ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .find((s) => !s.startsWith("[agy-companion]") && !s.startsWith("ERROR: logging before google.Init"));
  return line ?? "";
}
