#!/usr/bin/env node
// Tests for the agy runner: status/stop-reason classification, stream-json
// parsing, read-only agent provisioning (with and without web tools), prompt delivery via stdin,
// watchdogs, process-group teardown, read-only argv, and effort selection.
//
// No dependencies and no network: a shell script stands in for the `agy` binary
// via AGY_BIN, so the real wire format can be replayed deterministically.
//
//   node plugins/agy/scripts/test/runner.test.mjs

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "agy.mjs");
const DIR = mkdtempSync(join(tmpdir(), "agy-runner-test-"));

let failures = 0;
function check(label, cond, got) {
  if (cond) {
    console.log(`  pass  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}\n        got: ${JSON.stringify(got)}`);
  }
}

async function runFake(name, body, options = {}) {
  const path = join(DIR, `${name}.sh`);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  process.env.AGY_BIN = path;
  const mod = await import(`${LIB}?case=${name}`);
  return mod.runAgy([], { timeoutMs: 20_000, idleMs: 0, ...options });
}

const emit = (lines) =>
  `#!/bin/sh\ncat <<'JSONEOF'\n${lines.map((l) => JSON.stringify(l)).join("\n")}\nJSONEOF\n`;

const { classifyStopReason } = await import(LIB);

// ---------------------------------------------------------------- classifier

console.log("\nstatus / stop-reason classification");
const TEXT = "x".repeat(500);
for (const [reason, text, expected, label] of [
  ["SUCCESS", TEXT, true, "SUCCESS (agy stream-json result status)"],
  ["success", TEXT, true, "success normalizes"],
  ["end_turn", TEXT, true, "end_turn normalizes"],
  ["EndTurn", TEXT, true, "EndTurn normalizes"],
  ["SUCCESS", "OK", true, "two-character answer is still an answer"],
  ["SUCCESS", "", false, "empty text fails even on SUCCESS"],
  [null, TEXT, true, "absent stopReason with text"],
  [null, "", false, "absent stopReason without text"],
  ["cancelled", TEXT, false, "cancelled fails"],
  ["CANCELLED", TEXT, false, "CANCELLED normalizes and fails"],
  ["ERROR", TEXT, false, "ERROR status fails"],
  ["refusal", TEXT, false, "refusal fails even with text"],
  ["max_tokens", TEXT, true, "max_tokens kept as truncated"],
  ["max_turns", TEXT, false, "max_turns before an answer fails (text kept as partial)"],
  ["max_tokens", "", false, "truncated with no text fails"],
  ["a_future_reason", TEXT, true, "unknown reason with text fails OPEN"],
  ["tool_use", TEXT, false, "tool_use turn before an answer fails"],
  ["pause_turn", "", false, "pause_turn with no text fails"],
  ["a_future_reason", "hi", false, "unknown reason without real text fails"],
]) {
  const verdict = classifyStopReason(reason, text);
  check(label, verdict.ok === expected, verdict);
}

// ------------------------------------------------------------------ streaming

console.log("\nstream-json parsing (native agy wire format)");

let r = await runFake(
  "agy-stream",
  emit([
    {
      event: "init",
      conversation_id: "fbe045d7-c166-44d3-87a8-580e37f4c400",
      init: {
        cwd: "/tmp/repo",
        agent: "claude-agy-readonly",
        tools: ["view_file", "grep_search", "list_dir", "find_by_name"],
        permission_mode: "request-review",
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "fbe045d7-c166-44d3-87a8-580e37f4c400",
        step_index: 0,
        state: "DONE",
        step_type: "user_input",
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "fbe045d7-c166-44d3-87a8-580e37f4c400",
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        thinking_delta: "Checking cache logic...",
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "fbe045d7-c166-44d3-87a8-580e37f4c400",
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Here's a ",
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "fbe045d7-c166-44d3-87a8-580e37f4c400",
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "summary.",
      },
    },
    {
      event: "result",
      result: {
        conversation_id: "fbe045d7-c166-44d3-87a8-580e37f4c400",
        status: "SUCCESS",
        response: "Here's a summary.",
        duration_seconds: 3.71,
        num_turns: 1,
      },
    },
  ]),
);
check("text_delta chunks are concatenated", r.text === "Here's a summary.", r.text);
check("stopReason comes from result.status", r.stopReason === "SUCCESS", r.stopReason);
check("classified ok", r.ok === true, r.errorMessage);
check("conversation_id extracted as sessionId", r.sessionId === "fbe045d7-c166-44d3-87a8-580e37f4c400", r.sessionId);
check("thinking_delta captured", r.thought === "Checking cache logic...", r.thought);

r = await runFake(
  "single-json",
  emit([
    {
      conversation_id: "8e865fda-952b-4675-996b-c347a4cacf66",
      status: "SUCCESS",
      response: "single object answer",
      duration_seconds: 3.1,
    },
  ]),
);
check("single-object --output-format json parses", r.ok === true && r.text === "single object answer", r);
check("single-object path raises no truncation warning", !r.warning, r.warning);

r = await runFake(
  "cancelled",
  emit([
    {
      event: "step_update",
      step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "partial work" },
    },
    {
      event: "result",
      result: { status: "CANCELLED", conversation_id: "c1" },
    },
  ]),
);
check("cancelled turn fails", r.ok === false, r.ok);
check("cancelled turn keeps its partial text", r.text === "partial work", r.text);

r = await runFake(
  "noend",
  emit([
    {
      event: "step_update",
      step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "half an answer" },
    },
  ]),
);
check("missing `result` event still yields the text", r.text === "half an answer", r.text);
check("missing `result` event is a failure, not a completed answer", r.ok === false, r);
check("missing `result` event says the answer is incomplete", /incomplete/.test(r.errorMessage || ""), r.errorMessage);

r = await runFake(
  "errafter",
  emit([
    {
      event: "step_update",
      step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "some commentary" },
    },
    { event: "error", error: { message: "backend exploded" } },
  ]),
);
check("error event after text still fails", r.ok === false, r);
check("error event after text keeps the message", /backend exploded/.test(r.errorMessage || ""), r.errorMessage);
check("error event after text keeps the partial text", r.text === "some commentary", r.text);

r = await runFake(
  "crash",
  `#!/bin/sh\nprintf '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"partial"}}\\n'\nexit 3\n`,
);
check("nonzero exit (e.g. exit 3 on partial stream error) fails", r.ok === false && r.exitCode === 3, r);
check("nonzero exit keeps partial text", r.text === "partial", r.text);

// onProgress must survive a JSON object split across two socket reads.
const seen = [];
r = await runFake(
  "split",
  `#!/bin/sh\nprintf '{"event":"step_update","step_update":{"step_type":"agent_response","text_del'\nsleep 0.3\nprintf 'ta":"split ok"}}\\n'\n` +
    `printf '{"event":"result","result":{"status":"SUCCESS","response":"split ok"}}\\n'\n`,
  { onProgress: (e) => seen.push(e) },
);
check("split line is reassembled", r.text === "split ok", r.text);
check(
  "onProgress sees the split event",
  seen.some((e) => e.event === "step_update" && e.step_update?.text_delta === "split ok"),
  seen,
);

// --------------------------------------------------------------- prompt delivery

console.log("\nprompt delivery (-p for <=128KB, stdin for >128KB, --print-timeout, run-dir cleanup)");

r = await runFake(
  "argvprompt",
  `#!/bin/sh\nwhile [ "$1" != "--log-file" ]; do shift; done\nLOGPATH="$2"\nshift 2\n` +
    `while [ "$1" != "--print-timeout" ]; do shift; done\nPT="$2"\nshift 2\n` +
    `while [ "$1" != "-p" ]; do shift; done\nBODY="$2"\n` +
    `printf '{"event":"result","result":{"status":"SUCCESS","response":"%s|%s|%s"}}\\n' "$BODY" "$LOGPATH" "$PT"\n`,
  { prompt: "the prompt body", timeoutMs: 20_000 },
);
const [body, logPath, printTimeout] = r.text.split("|");
check("small prompt arrives via -p", body === "the prompt body", r.text);
check("--print-timeout is passed explicitly", printTimeout === "20s", r.text);
check("run temp dir is removed afterwards", logPath && !existsSync(dirname(logPath)), logPath);

// A 1MB prompt (>128KB) would fail with E2BIG if passed via -p on argv, so it goes over stdin.
r = await runFake(
  "bigprompt",
  `#!/bin/sh\nBYTES="$(wc -c | tr -d ' ')"\n` +
    `printf '{"event":"result","result":{"status":"SUCCESS","response":"%s"}}\\n' "$BYTES"\n`,
  { prompt: "y".repeat(1_000_000) },
);
check("prompt larger than ARG_MAX is delivered over stdin", r.ok && r.text === "1000000", r.text);

r = await runFake(
  "denied",
  emit([
    {
      event: "result",
      result: {
        status: "SUCCESS",
        response: "",
        denied_actions: ["run_command"],
      },
    },
  ]),
);
check("empty response with denied_actions fails and names the denied tool", r.ok === false && /run_command/.test(r.errorMessage || ""), r);

// ------------------------------------------------ read-only agents & argv

console.log("\nread-only custom agents & flags");

const configHome = join(DIR, "gemini-config");
process.env.AGY_CONFIG_HOME = configHome;
delete process.env.AGY_PLUGIN_AGENT;
const agyMod = await import(`${LIB}?agent=provision`);
const agentReport = agyMod.ensureReadOnlyAgent();
check("ensureReadOnlyAgent provisions ~/.gemini/config/agents/claude-agy-readonly.md", agentReport.provisioned === true, agentReport);
const agentContent = readFileSync(agentReport.path, "utf8");
check(
  "provisioned agent has the exact 4 read-only tools",
  ["view_file", "grep_search", "list_dir", "find_by_name"].every((t) => agentContent.includes(`- ${t}`)),
  agentContent,
);
check("provisioned agent disables commands and subagents", agentContent.includes('commandExecutionPolicy: "off"') && agentContent.includes("subagent: false"), agentContent);
check("provisioned agent has a short trimmed system prompt (<600 chars)", agentContent.length < 600, agentContent.length);
check("offline agent has no web tools", !/search_web|read_url_content/.test(agentContent), agentContent);

const webReport = agyMod.ensureReadOnlyAgent({ web: true });
check("web run provisions claude-agy-readonly-web", webReport.provisioned && webReport.name === "claude-agy-readonly-web", webReport);
const webContent = readFileSync(webReport.path, "utf8");
check(
  "web agent adds only search_web and read_url_content",
  /- search_web\n {2}- read_url_content\n/.test(webContent) && agyMod.readOnlyAgentProblem(webContent, { web: true }) === null,
  webContent,
);
check("web agent still disables commands and subagents", webContent.includes('commandExecutionPolicy: "off"') && webContent.includes("subagent: false"), webContent);
check("web agent prompt stays short (<700 chars)", webContent.length < 700, webContent.length);

const webArgs = agyMod.readOnlyArgs({ web: true });
const offlineArgs = agyMod.readOnlyArgs({ web: false });
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
check("web run selects claude-agy-readonly-web", valueOf(webArgs, "--agent") === "claude-agy-readonly-web", webArgs);
check("offline run selects claude-agy-readonly", valueOf(offlineArgs, "--agent") === "claude-agy-readonly", offlineArgs);
check(
  "web run allows read_url for this session only",
  JSON.parse(valueOf(webArgs, "--settings")).permissions.allow.join() === "read_url(*)",
  webArgs,
);
check("offline run passes no --settings", !offlineArgs.includes("--settings"), offlineArgs);
check("readOnlyArgs disables slash commands", webArgs.includes("--disable-slash-commands"), webArgs);
check("readOnlyArgs enables --sandbox by default", offlineArgs.includes("--sandbox"), offlineArgs);
check("unsandboxed fallback omits --sandbox", !agyMod.readOnlyArgs({ sandbox: false }).includes("--sandbox"));

// -------------------------------------------------------------------- effort

console.log("\neffort");

const home = join(DIR, "agyhome");
mkdirSync(home);
writeFileSync(
  join(home, "models_cache.json"),
  JSON.stringify({
    models: {
      "m-yes": { info: { supports_reasoning_effort: true } },
      "m-no": { info: { supports_reasoning_effort: false } },
    },
  }),
);
async function effortFor(name, req, env = {}) {
  const fakeModels = join(DIR, `${name}-models.sh`);
  writeFileSync(fakeModels, `#!/bin/sh\necho "Default model: ${env.defaultModel ?? "m-yes"}"\n`);
  chmodSync(fakeModels, 0o755);
  process.env.AGY_BIN = fakeModels;
  process.env.AGY_HOME = home;
  if (env.effort === undefined) delete process.env.AGY_PLUGIN_EFFORT;
  else process.env.AGY_PLUGIN_EFFORT = env.effort;
  const mod = await import(`${LIB}?effort=${name}`);
  return mod.effortArgs(req);
}
let e = await effortFor("default", {});
check("default profile (argon-low) sends no --effort", e.args.length === 0, e);
e = await effortFor("explicit", { effort: "high" });
check("explicit effort wins", e.args.join(" ") === "--effort high", e);
e = await effortFor("bakedmodel", { model: "gemini-4-argon-low" });
check("model with baked-in effort suffix (-low) omits implicit --effort", e.args.length === 0, e);
e = await effortFor("envset", { model: "default" }, { effort: "low" });
check("AGY_PLUGIN_EFFORT applies when no suffixed model is chosen", e.args.join(" ") === "--effort low", e);
e = await effortFor("envdefault", {}, { effort: "default" });
check("AGY_PLUGIN_EFFORT=default sends no flag", e.args.length === 0 && !e.dropped, e);
e = await effortFor("alias", { reasoningEffort: "low" });
check("--reasoning-effort is sent once, as --effort", e.args.join(" ") === "--effort low", e);
delete process.env.AGY_PLUGIN_EFFORT;

// -------------------------------------------------------------------- timers

console.log("\nwatchdogs & process-group teardown");

r = await runFake("stall", "#!/bin/sh\nsleep 30\n", { timeoutMs: 25_000, idleMs: 1_500 });
check("idle timer fires on silence", r.idledOut === true, r);
check("idle failure names the stall", /No output from agy/.test(r.errorMessage || ""), r.errorMessage);

const slowDrip =
  `#!/bin/sh\ni=0\nwhile [ $i -lt 50 ]; do printf '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"."}}\\n'; sleep 0.2; i=$((i+1)); done\n`;
r = await runFake("race", slowDrip, { timeoutMs: 1_500, idleMs: 1_000 });
check(
  "wall-clock timeout is not misreported as a stall",
  r.timedOut === true && r.idledOut === false,
  { timedOut: r.timedOut, idledOut: r.idledOut, error: r.errorMessage },
);

r = await runFake(
  "hangafterend",
  `#!/bin/sh\nprintf '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"complete answer"}}\\n'\n` +
    `printf '{"event":"result","result":{"status":"SUCCESS","response":"complete answer"}}\\n'\nsleep 30\n`,
  { timeoutMs: 25_000, idleMs: 3_000 },
);
check("completed answer survives a post-answer hang", r.ok === true, r);
check("completed-then-killed run is flagged", Boolean(r.warning), r.warning);

const pidFile = join(DIR, "stubborn.pid");
const stubborn = join(DIR, "stubborn.sh");
writeFileSync(
  stubborn,
  `#!/bin/sh\n( trap '' TERM; exec sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' ) >/dev/null 2>&1 &\n` +
    `sleep 30\n`,
);
chmodSync(stubborn, 0o755);
const driver = join(DIR, "driver.mjs");
writeFileSync(
  driver,
  `process.env.AGY_BIN = ${JSON.stringify(stubborn)};\n` +
    `const { runAgy } = await import(${JSON.stringify(LIB)});\n` +
    `await runAgy([], { timeoutMs: 800, idleMs: 0, graceMs: 700 });\n`,
);
spawnSync(process.execPath, [driver], { timeout: 20_000 });
const stubbornPid = Number(readFileSync(pidFile, "utf8").trim());
await new Promise((r) => setTimeout(r, 200));
let survived = true;
try {
  process.kill(stubbornPid, 0);
} catch {
  survived = false;
}
if (survived) process.kill(stubbornPid, "SIGKILL");
check("SIGTERM-ignoring descendant is killed before the companion exits", !survived, stubbornPid);

// ------------------------------------------------- profiles, timeouts, agents

console.log("\nprofiles, effort, timeout message, custom-agent validation");
{
  const m = await import(`${LIB}?case=profiles`);
  for (const k of ["AGY_PLUGIN_PROFILE", "AGY_PLUGIN_MODEL", "AGY_PLUGIN_EFFORT"]) delete process.env[k];
  check("default profile is balanced (argon low)", m.resolveModel(null, null) === "gemini-4-argon-low", m.resolveModel(null, null));
  check("--profile fast picks flash low", m.resolveModel(null, "fast") === "gemini-3.8-flash-low");
  check("--profile deep picks argon medium", m.resolveModel(null, "deep") === "gemini-4-argon-medium");
  check("--model overrides the profile", m.resolveModel("x-model", "deep") === "x-model");
  let threw = false;
  try { m.resolveProfile("nope"); } catch { threw = true; }
  check("unknown --profile throws", threw);
  process.env.AGY_PLUGIN_MODEL = "env-model";
  check("AGY_PLUGIN_MODEL beats the default profile", m.resolveModel(null, null) === "env-model");
  check("an explicit --profile beats AGY_PLUGIN_MODEL", m.resolveModel(null, "fast") === "gemini-3.8-flash-low");
  delete process.env.AGY_PLUGIN_MODEL;
  const e = m.effortArgs({ effort: null, reasoningEffort: null, model: null, profile: null });
  check("suffixed profile model sends no --effort", e.args.length === 0, e);
  const e2 = m.effortArgs({ effort: "high", model: "gemini-4-argon-low" });
  check("explicit --effort is still sent", e2.args.join(" ") === "--effort high", e2);
  const t0 = m.timeoutMessage(480_000, { toolCalls: 0, lastEventAt: null });
  check("timeout with no events says so", /no output from agy/.test(t0), t0);
  const t1 = m.timeoutMessage(480_000, { toolCalls: 7, lastEventAt: 1_000 }, 31_000);
  check("timeout reports tool calls and last activity", /7 tool calls, last activity 30s ago/.test(t1), t1);
  const p = m.readOnlyAgentProblem;
  check("built-in agent passes validation", p(m.READONLY_AGENT_MARKDOWN) === null);
  check("agent with a write tool is refused", /write_to_file/.test(p(m.READONLY_AGENT_MARKDOWN.replace("  - find_by_name", "  - find_by_name\n  - write_to_file")) ?? ""));
  check("agent with commands on is refused", p(m.READONLY_AGENT_MARKDOWN.replace('"off"', '"auto"')) !== null);
  check("agent without a tools list is refused", p("---\nname: x\n---\nhi") !== null);
  check("web agent is refused with web off", /web tool/.test(p(m.WEB_AGENT_MARKDOWN) ?? ""));

  delete process.env.AGY_PLUGIN_WEB;
  check("web is off by default", m.resolveWeb(null, undefined).web === false);
  check("saved setup setting turns web on", m.resolveWeb(null, true).web === true);
  check("saved setup setting turns web off", m.resolveWeb(null, false).web === false);
  process.env.AGY_PLUGIN_WEB = "off";
  check("AGY_PLUGIN_WEB beats the saved setting", m.resolveWeb(null, true).web === false);
  check("--web beats AGY_PLUGIN_WEB", m.resolveWeb(true, true).web === true);
  process.env.AGY_PLUGIN_WEB = "maybe";
  let badWebThrew = false;
  try {
    m.resolveWeb(null, undefined);
  } catch {
    badWebThrew = true;
  }
  check("a bad AGY_PLUGIN_WEB is an error", badWebThrew);
  delete process.env.AGY_PLUGIN_WEB;
}

r = await runFake(
  "agy-toolcount",
  emit([
    { event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "view_file" } },
    { event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "view_file" } },
    { event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "grep_search" } },
    { event: "step_update", step_update: { text_delta: "done" } },
    { event: "result", result: { status: "SUCCESS" } },
  ]),
);
check("DONE tool steps are counted", r.toolCalls === 2, r.toolCalls);

r = await runFake(
  "agy-retried-stream",
  emit([
    { event: "step_update", step_update: { text_delta: "### Summ" } },
    { event: "step_update", step_update: { text_delta: "### Summary\nfull answer" } },
    { event: "result", result: { status: "SUCCESS", response: "### Summary\nfull answer" } },
  ]),
);
check("result.response wins over deltas re-streamed after a retry", r.text === "### Summary\nfull answer", r.text);


// ---------------------------------------------------------------------------

console.log(
  failures ? `\n${failures} check(s) failed\n` : `\nall checks passed\n`,
);
process.exit(failures ? 1 : 0);
