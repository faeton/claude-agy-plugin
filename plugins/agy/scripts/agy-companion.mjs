#!/usr/bin/env node
// Companion for driving the local Google Antigravity (`agy`) CLI from a Claude Code plugin.
//
// `agy` is used STRICTLY READ-ONLY here: consult and review are second-opinion
// tools, never mutating agents. Every `agy` invocation provisions and selects
// one of our custom Markdown-defined agents in `~/.gemini/config/agents/`:
// `claude-agy-readonly` by default, or `claude-agy-readonly-web` when web
// access is switched on (`--web`, AGY_PLUGIN_WEB, `/agy:setup --web on`). Both restrict `agy` to an explicit
// read-only allowlist (`view_file`, `grep_search`, `list_dir`, `find_by_name`,
// plus `search_web` / `read_url_content` for the web agent), set
// `commandExecutionPolicy: "off"` and `subagent: false`, and trim the system
// prompt down to 2 sentences (~2x-3x faster responses). Runs also pass `--sandbox`, `--disable-slash-commands`,
// and `--output-format stream-json`, bounded by both an idle timer and a
// wall-clock backstop.
//
// Subcommands:
//   setup [--web on|off] [--json]
//   consult [--background] [--web|--no-web] [--file <p>]... [--profile <p>] [--model <id>] [--effort <lvl>]
//           [--timeout-ms <ms>] [--idle-ms <ms>] [--json] -- <question>
//   review  [--background] [--web|--no-web] [--base <ref>] [--scope auto|working-tree|branch]
//           [--profile <p>] [--model <id>] [--effort <lvl>] [--timeout-ms <ms>] [--idle-ms <ms>] [--json]
//   adversarial-review [...same as review...] [focus text]
//   consult-worker --job-id <id>        (internal: detached background worker)
//   status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]
//   result [job-id] [--json]
//   cancel [job-id] [--json]

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildConsultPrompt,
  buildReviewPrompt,
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget,
} from "./lib/git.mjs";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_TIMEOUT_MS,
  RUN_DIR_PREFIX,
  effortArgs,
  ensureReadOnlyAgent,
  getAgyAuthStatus,
  parseWebSetting,
  getAgyAvailability,
  readOnlyArgs,
  resolveModel,
  resolveProfile,
  resolveWeb,
  runAgy,
  sandboxAvailability,
  terminateActiveAgy,
  terminateGroups,
} from "./lib/agy.mjs";
import {
  ACTIVE_STATUSES,
  createJob,
  resolveJob,
  reconcile,
  runTrackedJob,
  sortJobsNewestFirst,
  appendLog,
  currentSessionId,
  nowIso,
  transition,
} from "./lib/jobs.mjs";
import {
  ROOT,
  getGlobalConfig,
  listJobs,
  pidMatches,
  readJobFile,
  resolveWorkspaceRoot,
  setGlobalConfig,
} from "./lib/state.mjs";
import {
  renderCancel,
  renderConsultResult,
  renderJobStatus,
  renderQueuedLaunch,
  renderReviewResult,
  renderSetup,
  renderStatusTable,
  renderStoredResult,
  reasoningTail,
} from "./lib/render.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const LOG_PATH = join(ROOT, "companion.jsonl");

function logEvent(event) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(
      LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...event }) + "\n",
    );
  } catch {
    /* logging must never break a run */
  }
}

function out(value, asJson, rendered) {
  if (asJson) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  } else {
    process.stdout.write(rendered ?? String(value));
  }
}

function normalizeArgv(argv) {
  if (argv.length === 1 && typeof argv[0] === "string") {
    const trimmed = argv[0].trim();
    if (!trimmed) return [];
    return splitRawArgumentString(argv[0]);
  }
  return argv;
}

function resolveCwd(options) {
  return options.cwd ? resolve(process.cwd(), options.cwd) : process.cwd();
}

function shorten(text, limit = 80) {
  const norm = String(text ?? "").replace(/\s+/g, " ").trim();
  return norm.length <= limit ? norm : norm.slice(0, limit - 1) + "…";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseMs(raw, name, fallback, { allowZero = false } = {}) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) {
    throw new Error(
      `--${name} must be a ${allowZero ? "non-negative" : "positive"} number of milliseconds (got "${raw}").`,
    );
  }
  return n;
}

function jobSummary(job) {
  const { request, result, rendered, ...rest } = job;
  return rest;
}

// Map a stream-json event (or ACP event) onto a job-progress update.
// Deliberately selective: only tool activity, errors, and final result phases
// are logged so streaming text_delta tokens do not rewrite the log on every chunk.
function streamPhase(event) {
  if (event?.event === "step_update") {
    const su = event.step_update ?? event;
    const st = su.step_type;
    if (st && st !== "user_input" && st !== "agent_response" && su.state === "ACTIVE") {
      const name = su.tool_name || su.tool_info?.name || su.title || st;
      const params = su.tool_info?.parameters;
      const detail =
        params?.AbsolutePath ||
        params?.Query ||
        params?.DirectoryPath ||
        params?.Pattern ||
        params?.Url ||
        "";
      const label = detail ? `${name} ${detail}` : name;
      return { message: `→ ${shorten(label, 70)}` };
    }
    return {};
  }
  if (event?.event === "result") {
    return { phase: "finishing" };
  }
  if (event?.event === "error") {
    const msg = event.error?.message ?? event.error ?? event.message ?? "unknown error";
    return { message: `agy error: ${shorten(msg, 200)}` };
  }
  switch (event?.type) {
    case "tool_call":
      return { message: `→ ${shorten(event.title || event.toolName || "tool", 60)}` };
    case "error":
      return { message: `agy error: ${shorten(event.message, 200)}` };
    case "end":
      return { phase: "finishing" };
    default:
      return {};
  }
}

// ---------- setup ----------

async function handleSetup(argv) {
  const { options } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd", "web"],
    booleanOptions: ["json"],
  });
  if (options.web !== undefined) {
    setGlobalConfig("web", parseWebSetting(options.web, "--web"));
  }
  const web = resolveWeb(null, getGlobalConfig().web);
  const agy = getAgyAvailability();
  const auth = agy.available ? getAgyAuthStatus() : { loggedIn: false };
  // Provision both agents so a later --web / --no-web run finds its agent ready.
  const other = ensureReadOnlyAgent({ web: !web.web });
  const agent = ensureReadOnlyAgent({ web: web.web });
  const nextSteps = [];
  if (!agy.available) {
    nextSteps.push("Install the Google Antigravity CLI (`agy`) and ensure it is on your PATH (e.g. ~/.local/bin/agy).");
  } else if (!auth.loggedIn) {
    nextSteps.push("Run `!agy` in your terminal to complete initial sign-in.");
  }
  for (const a of [agent, other]) {
    if (!a.provisioned) {
      nextSteps.push(
        `Ensure ~/.gemini/config/agents is writable so the read-only agent (${a.name}) can be provisioned: ${a.error}`,
      );
    }
  }
  const sandbox = sandboxAvailability();
  if (!sandbox.available) {
    nextSteps.push(
      sandbox.required
        ? "Install bubblewrap (`bwrap`) or put a standalone binary on PATH — AGY_COMPANION_REQUIRE_SANDBOX=1 makes runs fail without it."
        : "Optional: install bubblewrap (`bwrap`) so agy runs under its OS sandbox; without it runs proceed unsandboxed with a warning.",
    );
  }
  const ready =
    agy.available &&
    auth.loggedIn &&
    agent.provisioned &&
    (sandbox.available || !sandbox.required);
  const report = { ready, agy, auth, agent, web, sandbox, nextSteps };
  out(report, options.json, renderSetup(report));
}

// ---------- consult ----------

function parseConsultOptions(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: [
      "model",
      "profile",
      "effort",
      "reasoning-effort",
      "timeout-ms",
      "idle-ms",
      "cwd",
      "question",
    ],
    repeatable: ["file"],
    booleanOptions: ["json", "background", "wait", "web", "no-web"],
    aliasMap: { m: "model" },
  });
  const cwd = resolveCwd(options);
  const question = options.question || positionals.join(" ").trim();
  return {
    cwd,
    json: Boolean(options.json),
    background: Boolean(options.background),
    model: options.model || null,
    profile: options.profile || null,
    effort: options.effort || null,
    reasoningEffort: options["reasoning-effort"] || null,
    timeoutMs: parseMs(options["timeout-ms"], "timeout-ms", DEFAULT_TIMEOUT_MS),
    idleMs: parseMs(options["idle-ms"], "idle-ms", DEFAULT_IDLE_MS, { allowZero: true }),
    files: options.file ?? [],
    web: webFlag(options),
    question,
  };
}

async function runConsult(req, progress) {
  const prompt = buildConsultPrompt({ question: req.question, files: req.files, cwd: req.cwd });
  const { web } = resolveWeb(req.web, getGlobalConfig().web);
  const agent = ensureReadOnlyAgent({ web });
  if (!agent.provisioned) {
    throw new Error(`Could not provision read-only agy agent (${agent.name}): ${agent.error}`);
  }
  const eff = effortArgs(req);
  if (eff.dropped) progress?.({ message: eff.dropped });
  const sandbox = sandboxAvailability();
  if (sandbox.warning) progress?.({ message: sandbox.warning });
  const args = [
    "--output-format",
    "stream-json",
    ...readOnlyArgs({ web, sandbox: sandbox.available || sandbox.required, agent: agent.name }),
    ...eff.args,
  ];
  const model = resolveModel(req.model, req.profile);
  if (model) args.push("--model", model);

  progress?.({ phase: "asking", message: `Sending question to agy (web ${web ? "on" : "off"})…` });
  const result = await runAgy(args, {
    prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    idleMs: req.idleMs,
    onProgress: (event) => progress?.(streamPhase(event)),
    onSpawn: ({ pid }) => progress?.({ agyPid: pid }),
  });
  if (sandbox.warning) {
    result.warning = [sandbox.warning, result.warning].filter(Boolean).join(" ");
  }
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    summary: shorten(result.text || result.errorMessage || req.question),
    warning: result.warning,
    timedOut: result.timedOut,
    idledOut: result.idledOut,
    payload: {
      ok: result.ok,
      text: result.text,
      stopReason: result.stopReason,
      sessionId: result.sessionId,
      model,
      profile: resolveProfile(req.profile).name,
      effort: eff.args[1] ?? null,
      web,
      toolCalls: result.toolCalls,
      warning: result.warning,
      timedOut: result.timedOut,
      idledOut: result.idledOut,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      ...(result.ok ? {} : { reasoningTail: reasoningTail(result.thought) || null }),
    },
    rendered: renderConsultResult(result),
  };
}

async function handleConsult(argv) {
  const req = parseConsultOptions(argv);
  resolveProfile(req.profile); // a bad --profile fails now, not in a background worker
  if (!req.question) {
    throw new Error('consult needs a question (positional text after "--" or --question "…").');
  }
  ensureAgyReady();
  const workspaceRoot = resolveWorkspaceRoot(req.cwd);
  const job = createJob({
    workspaceRoot,
    kind: "consult",
    kindLabel: "consult",
    title: "Antigravity Consult",
    summary: shorten(req.question),
    prefix: "consult",
    request: { subcommand: "consult", ...req },
  });

  if (req.background) {
    launchWorker(req.cwd, job.id);
    out({ jobId: job.id, status: "queued", title: job.title }, req.json, renderQueuedLaunch(job));
    return;
  }

  installCancelHandlers(workspaceRoot, job.id);
  const execution = await runTrackedJob(job, (progress) => runConsult(req, progress));
  out(execution.payload, req.json, execution.rendered);
  if (!execution.ok) process.exitCode = execution.exitCode || 1;
}

// ---------- review ----------

function parseReviewOptions(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: [
      "base",
      "scope",
      "model",
      "profile",
      "effort",
      "reasoning-effort",
      "timeout-ms",
      "idle-ms",
      "cwd",
    ],
    booleanOptions: ["json", "background", "wait", "web", "no-web"],
    aliasMap: { m: "model" },
  });
  return {
    cwd: resolveCwd(options),
    json: Boolean(options.json),
    background: Boolean(options.background),
    base: options.base || null,
    scope: options.scope || "auto",
    model: options.model || null,
    profile: options.profile || null,
    effort: options.effort || null,
    reasoningEffort: options["reasoning-effort"] || null,
    timeoutMs: parseMs(options["timeout-ms"], "timeout-ms", DEFAULT_TIMEOUT_MS),
    idleMs: parseMs(options["idle-ms"], "idle-ms", DEFAULT_IDLE_MS, { allowZero: true }),
    web: webFlag(options),
    focusText: positionals.join(" ").trim(),
  };
}

async function runReview(req, kind, progress) {
  ensureGitRepository(req.cwd);
  const target = resolveReviewTarget(req.cwd, { base: req.base, scope: req.scope });
  const context = collectReviewContext(req.cwd, target);
  if (context.empty) {
    return {
      ok: false,
      exitCode: 0,
      errorMessage: "No changes detected to review.",
      summary: "nothing to review",
      payload: { ok: false, errorMessage: "No changes detected to review.", target },
      rendered: "[agy] No changes detected to review.\n",
    };
  }
  const { web } = resolveWeb(req.web, getGlobalConfig().web);
  const agent = ensureReadOnlyAgent({ web });
  if (!agent.provisioned) {
    throw new Error(`Could not provision read-only agy agent (${agent.name}): ${agent.error}`);
  }
  const prompt = buildReviewPrompt(req.cwd, target, context, {
    focusText: kind === "adversarial-review" ? req.focusText : "",
  });
  const eff = effortArgs(req);
  if (eff.dropped) progress?.({ message: eff.dropped });
  const sandbox = sandboxAvailability();
  if (sandbox.warning) progress?.({ message: sandbox.warning });
  const args = [
    "--output-format",
    "stream-json",
    ...readOnlyArgs({ web, sandbox: sandbox.available || sandbox.required, agent: agent.name }),
    ...eff.args,
  ];
  const model = resolveModel(req.model, req.profile);
  if (model) args.push("--model", model);

  progress?.({ phase: "reviewing", message: `Reviewing ${target.label} (web ${web ? "on" : "off"})…` });
  const result = await runAgy(args, {
    prompt,
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    idleMs: req.idleMs,
    onProgress: (event) => progress?.(streamPhase(event)),
    onSpawn: ({ pid }) => progress?.({ agyPid: pid }),
  });
  if (sandbox.warning) {
    result.warning = [sandbox.warning, result.warning].filter(Boolean).join(" ");
  }
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    summary: `${target.label}: ${shorten(result.text || result.errorMessage || "review", 50)}`,
    warning: result.warning,
    timedOut: result.timedOut,
    idledOut: result.idledOut,
    payload: {
      ok: result.ok,
      text: result.text,
      target,
      stopReason: result.stopReason,
      sessionId: result.sessionId,
      model,
      profile: resolveProfile(req.profile).name,
      effort: eff.args[1] ?? null,
      web,
      toolCalls: result.toolCalls,
      warning: result.warning,
      timedOut: result.timedOut,
      idledOut: result.idledOut,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      ...(result.ok ? {} : { reasoningTail: reasoningTail(result.thought) || null }),
    },
    rendered: renderReviewResult(result, { targetLabel: target.label }),
  };
}

async function handleReview(argv, kind = "review") {
  const req = parseReviewOptions(argv);
  resolveProfile(req.profile);
  // Fail on a bad --scope / --base now, before a background job is queued for it.
  ensureGitRepository(req.cwd);
  resolveReviewTarget(req.cwd, { base: req.base, scope: req.scope });
  ensureAgyReady();
  const workspaceRoot = resolveWorkspaceRoot(req.cwd);
  const title =
    kind === "adversarial-review" ? "Antigravity Adversarial Review" : "Antigravity Review";
  const job = createJob({
    workspaceRoot,
    kind,
    kindLabel: kind,
    title,
    summary: req.focusText ? shorten(req.focusText) : kind,
    prefix: "review",
    request: { subcommand: kind, ...req },
  });

  if (req.background) {
    launchWorker(req.cwd, job.id);
    out({ jobId: job.id, status: "queued", title: job.title }, req.json, renderQueuedLaunch(job));
    return;
  }

  installCancelHandlers(workspaceRoot, job.id);
  const execution = await runTrackedJob(job, (progress) => runReview(req, kind, progress));
  out(execution.payload, req.json, execution.rendered);
  if (!execution.ok) process.exitCode = execution.exitCode || 1;
}

// ---------- background worker ----------

const WORKER_MARK = "agy-companion.mjs";

function launchWorker(cwd, jobId) {
  const child = spawn(
    process.execPath,
    [SCRIPT_PATH, "consult-worker", "--job-id", jobId, "--cwd", cwd],
    {
      cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
    },
  );
  transition(resolveWorkspaceRoot(cwd), jobId, ["queued"], (current) =>
    current.pid == null && child.pid ? { pid: child.pid } : null,
  );
  child.unref();
}

function installCancelHandlers(workspaceRoot, jobId) {
  let stopping = false;
  const onSignal = async (signal) => {
    if (stopping) return;
    stopping = true;
    const { changed, job } = transition(workspaceRoot, jobId, ["queued", "running"], {
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      agyPid: null,
      completedAt: nowIso(),
      errorMessage: `Cancelled (${signal}).`,
    });
    if (changed) appendLog(job.logFile, `Cancelled (${signal}).`);
    await terminateActiveAgy();
    process.exit(130);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, onSignal);
}

async function handleWorker(argv) {
  const { options } = parseArgs(normalizeArgv(argv), { valueOptions: ["job-id", "cwd"] });
  if (!options["job-id"]) throw new Error("consult-worker requires --job-id.");
  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stored = readJobFile(workspaceRoot, options["job-id"]);
  if (!stored || !stored.request) {
    throw new Error(`No stored request for job ${options["job-id"]}.`);
  }
  if (stored.status !== "queued") return;
  installCancelHandlers(workspaceRoot, stored.id);

  const req = stored.request;
  const runner = (progress) =>
    req.subcommand === "consult"
      ? runConsult(req, progress)
      : runReview(req, req.subcommand, progress);
  await runTrackedJob({ ...stored, workspaceRoot }, runner);
}

// ---------- status / result / cancel ----------

function visibleJobs(workspaceRoot, { all }) {
  let jobs = sortJobsNewestFirst(listJobs(workspaceRoot))
    .map((j) => reconcile(workspaceRoot, j))
    .map(jobSummary);
  if (!all) {
    const sid = currentSessionId();
    if (sid) {
      const scoped = jobs.filter((j) => j.sessionId === sid);
      if (scoped.length) jobs = scoped;
    }
  }
  return jobs;
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"],
  });
  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const reference = positionals[0];

  if (reference) {
    let job = resolveJob(workspaceRoot, reference);
    if (options.wait) {
      const deadline = Date.now() + parseMs(options["timeout-ms"], "timeout-ms", 240_000);
      const interval = parseMs(options["poll-interval-ms"], "poll-interval-ms", 2_000);
      while (ACTIVE_STATUSES.has(job.status) && Date.now() < deadline) {
        await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
        job = resolveJob(workspaceRoot, reference);
      }
    }
    out(jobSummary(job), options.json, renderJobStatus(job));
    return;
  }
  if (options.wait) throw new Error("`status --wait` requires a job id.");
  const jobs = visibleJobs(workspaceRoot, { all: options.all });
  out({ jobs }, options.json, renderStatusTable(jobs));
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const job = resolveJob(workspaceRoot, positionals[0]);
  out(job, options.json, renderStoredResult(job));
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const job = resolveJob(workspaceRoot, positionals[0], { preferActive: true });
  // Record the cancellation first, and only for a job that is still active: a
  // finished job is left alone (cancel with no id picks the newest job, which
  // used to rewrite a completed review as cancelled and hide its output).
  const { changed, job: latest } = transition(workspaceRoot, job.id, ["queued", "running"], {
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    agyPid: null,
    completedAt: nowIso(),
    errorMessage: "Cancelled by user.",
  });
  if (!changed) {
    out(
      { jobId: job.id, status: latest?.status ?? job.status, cancelled: false },
      options.json,
      renderCancel(latest ?? job, { cancelled: false }),
    );
    return;
  }
  appendLog(latest.logFile, "Cancelled by user.");
  const pids = [];
  if (pidMatches(job.pid, WORKER_MARK)) pids.push(job.pid);
  if (pidMatches(job.agyPid, RUN_DIR_PREFIX)) pids.push(job.agyPid);
  await terminateGroups(pids);
  out({ jobId: job.id, status: "cancelled", cancelled: true }, options.json, renderCancel(latest));
}

// ---------- shared ----------

// --web / --no-web, or null to fall through to AGY_PLUGIN_WEB / the saved setting.
function webFlag(options) {
  if (options.web !== undefined && options["no-web"] !== undefined) {
    throw new Error("Pass either --web or --no-web, not both.");
  }
  if (options["no-web"] !== undefined) return !options["no-web"];
  if (options.web !== undefined) return options.web;
  return null;
}

function ensureAgyReady() {
  const agy = getAgyAvailability();
  if (!agy.available) {
    throw new Error("agy CLI not found on PATH. Run `/agy:setup` for guidance.");
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  logEvent({ event: "start", run_id: runId, sub: subcommand, cwd: process.cwd() });
  const startedAt = Date.now();

  try {
    switch (subcommand) {
      case "setup":
        await handleSetup(argv);
        break;
      case "consult":
        await handleConsult(argv);
        break;
      case "review":
        await handleReview(argv, "review");
        break;
      case "adversarial-review":
        await handleReview(argv, "adversarial-review");
        break;
      case "consult-worker":
        await handleWorker(argv);
        break;
      case "status":
        await handleStatus(argv);
        break;
      case "result":
        handleResult(argv);
        break;
      case "cancel":
        await handleCancel(argv);
        break;
      case undefined:
      case "help":
      case "--help":
        process.stdout.write(usage());
        break;
      default:
        throw new Error(`Unknown subcommand: ${subcommand}`);
    }
    // A handler reports a failed run through process.exitCode, not by throwing.
    logEvent({ event: "exit", run_id: runId, ok: !process.exitCode, duration_ms: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[agy-companion] ${message}\n`);
    logEvent({ event: "exit", run_id: runId, ok: false, error: message, duration_ms: Date.now() - startedAt });
    process.exitCode = 1;
  }
}

function usage() {
  return [
    "Usage:",
    "  agy-companion.mjs setup [--web on|off] [--json]",
    "  agy-companion.mjs consult [--background] [--web|--no-web] [--file <p>]... [--profile <p>] [--model <id>] [--effort <lvl>] [--timeout-ms <ms>] [--idle-ms <ms>] [--json] -- <question>",
    "  agy-companion.mjs review [--background] [--web|--no-web] [--base <ref>] [--scope auto|working-tree|branch] [--profile <p>] [--model <id>] [--effort <lvl>] [--timeout-ms <ms>] [--idle-ms <ms>] [--json]",
    "  agy-companion.mjs adversarial-review [...review flags...] [focus text]",
    "  agy-companion.mjs status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
    "  agy-companion.mjs result [job-id] [--json]",
    "  agy-companion.mjs cancel [job-id] [--json]",
    "",
    "  --profile     balanced (gemini-4-argon-low; default), fast (gemini-3.8-flash-low) or deep",
    "                (gemini-4-argon-medium). Default $AGY_PLUGIN_PROFILE or balanced.",
    "  --model       agy model id, overrides the profile ($AGY_PLUGIN_MODEL; 'default' = CLI's own).",
    "  --effort      reasoning effort, overrides the profile ($AGY_PLUGIN_EFFORT; 'default' = CLI's own).",
    "  --web         let agy use search_web / read_url_content (default off). --no-web turns it off",
    "                for one run; setup --web on|off saves the default; $AGY_PLUGIN_WEB overrides that.",
    "  --timeout-ms  wall-clock backstop (default 8m).",
    "  --idle-ms     kill after this long with no output at all (default 3m, 0 disables).",
    "",
  ].join("\n");
}

main();
