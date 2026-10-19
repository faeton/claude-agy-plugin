// Human-readable renderers for command output (used when --json is absent).

function elapsed(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? "");
  const end = Date.parse(job.completedAt ?? "") || Date.now();
  if (Number.isNaN(start)) return "—";
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// The tail of agy's reasoning stream, for a run that ended without an answer.
// It is the only record of what an unfinished run had found (a timed-out review
// had its whole investigation there, and only a one-line preamble as text). The
// head is mostly orientation, so the end is kept.
export function reasoningTail(thought, max = 4_000) {
  const t = String(thought ?? "").trim();
  if (!t) return "";
  return t.length <= max ? t : "…" + t.slice(t.length - max);
}

function renderFailure(headline, result) {
  const lines = [headline];
  if (result.errorMessage) lines.push(result.errorMessage);
  if (result.stopReason) lines.push(`stopReason: ${result.stopReason}`);
  if (result.text) lines.push("", "Partial output:", result.text.trim());
  const notes = reasoningTail(result.thought);
  if (notes) {
    lines.push("", "agy's working notes when it stopped (unfinished reasoning, unverified):", notes);
  }
  return lines.join("\n") + "\n";
}

export function renderConsultResult(result) {
  if (result.ok) {
    const head = result.warning ? `[agy] ${result.warning}\n\n` : "";
    return head + result.text.trimEnd() + "\n";
  }
  return renderFailure("[agy] Consultation did not complete.", result);
}

export function renderReviewResult(result, { targetLabel } = {}) {
  if (result.ok) {
    const head = targetLabel ? `Antigravity (agy) review — ${targetLabel}\n\n` : "";
    const warn = result.warning ? `[agy] ${result.warning}\n\n` : "";
    return head + warn + result.text.trimEnd() + "\n";
  }
  return renderFailure("[agy] Review did not complete.", result);
}

export function renderQueuedLaunch(job) {
  return `${job.title} started in the background as ${job.id}. Check \`/agy:status ${job.id}\` for progress.\n`;
}

export function renderStatusTable(jobs) {
  if (jobs.length === 0) return "No Antigravity (agy) jobs for this workspace.\n";
  const rows = jobs.map((j) => ({
    id: j.id,
    kind: j.kindLabel ?? j.kind ?? "—",
    status: j.status ?? "—",
    phase: j.phase ?? "—",
    elapsed: elapsed(j),
    summary: (j.summary ?? "").replace(/\s+/g, " ").slice(0, 60),
  }));
  const header = "| Job | Kind | Status | Phase | Elapsed | Summary |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map(
    (r) => `| ${r.id} | ${r.kind} | ${r.status} | ${r.phase} | ${r.elapsed} | ${r.summary} |`,
  );
  return [header, sep, ...body].join("\n") + "\n";
}

export function renderJobStatus(job) {
  const lines = [
    `Job:     ${job.id}`,
    `Kind:    ${job.kindLabel ?? job.kind}`,
    `Status:  ${job.status}${job.phase ? ` (${job.phase})` : ""}`,
    `Elapsed: ${elapsed(job)}`,
  ];
  if (job.summary) lines.push(`Summary: ${job.summary}`);
  if (job.stopReason) lines.push(`stopReason: ${job.stopReason}`);
  if (job.errorMessage) lines.push(`Error:   ${job.errorMessage}`);
  if (job.status === "completed") lines.push(`\nRun \`/agy:result ${job.id}\` for the full output.`);
  if (job.status === "running") lines.push(`\nRun \`/agy:cancel ${job.id}\` to stop it.`);
  return lines.join("\n") + "\n";
}

export function renderStoredResult(job) {
  if (!job) return "Job not found.\n";
  if (job.status === "queued" || job.status === "running") {
    return `Job ${job.id} is ${job.status} — no final output yet. Check \`/agy:status ${job.id}\`.\n`;
  }
  // A cancelled job can still hold output that arrived before the cancel.
  if (job.rendered) return job.rendered;
  if (job.status === "cancelled") return `[agy] ${job.title} was cancelled before it produced output.\n`;
  if (job.errorMessage) return `[agy] ${job.title} failed: ${job.errorMessage}\n`;
  return "No stored output.\n";
}

export function renderCancel(job, { cancelled = true } = {}) {
  if (!cancelled) return `Job ${job.id} is already ${job.status}; nothing to cancel.\n`;
  return `Cancelled ${job.id} (${job.title}).\n`;
}

export function renderSetup(report) {
  const lines = ["Antigravity (agy) companion setup:"];
  lines.push(`  agy CLI:  ${report.agy.available ? `✓ ${report.agy.version}` : "✗ not found"}`);
  lines.push(`  auth:     ${report.auth.loggedIn ? "✓ logged in" : "✗ not logged in"}`);
  if (report.agent) {
    lines.push(
      `  agent:    ${report.agent.provisioned ? `✓ ${report.agent.name} (${report.agent.tools.join(", ")})` : `⚠ ${report.agent.error || "not provisioned"}`}`,
    );
  }
  if (report.sandbox) {
    lines.push(
      `  sandbox:  ${report.sandbox.available ? "✓ enabled" : "⚠ disabled"}`,
    );
  }
  lines.push(`  ready:    ${report.ready ? "✓" : "✗"}`);
  if (report.nextSteps.length) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) lines.push(`  - ${step}`);
  }
  return lines.join("\n") + "\n";
}
