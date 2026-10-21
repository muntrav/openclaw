import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { createCanaryProcessFixture } from "./update-candidate-canary.test-support.js";
import * as rehearsals from "./update-candidate-rehearsal.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  [
    "OpenClaw state database schema migration required (audit-events-v2) at /home/private-owner/state.sqlite; run openclaw doctor --fix to migrate it.",
    "schema migration required",
  ],
  [
    "[openclaw] Reason: plugin load failed: discord: private-tenant at /home/private-owner/plugin.ts",
    "plugin load failed: discord",
  ],
  ["plugin load failed: private-tenant: private-host.example", "plugin load failed"],
  [
    "[plugins] discord failed during load from /home/private-owner/plugin.ts: private-tenant",
    "plugin load failed: discord",
  ],
  ["gateway requires offline media migration. private-tenant", "schema migration required"],
  [
    "Gateway refused startup because 1 OpenClaw database schema(s) are newer than this build. private-tenant",
    "database schema newer than candidate",
  ],
  ["another gateway instance is already listening on ws://10.20.30.40:18789", "port in use"],
  ["Cannot find module '/home/private-owner/native.node'", "native module missing"],
  [
    "The module '/home/private-owner/native.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127.",
    "native module ABI mismatch",
  ],
  [
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "startup ran out of memory",
  ],
  ["Invalid config at /home/private-owner/openclaw.json:", "Invalid configuration field"],
  [
    "Invalid config at /home/private-owner/openclaw.json:\n- private-config.json:12 — agents.entries.private-agent.model.primary: Invalid input: expected string, received number",
    "Invalid configuration field; agents.entries.<id>.model.primary: expected string, got number",
  ],
  ["private-tenant startup failed at private-host.example", "[redacted-diagnostic]"],
  ["unterminated", "plugin load failed: discord"],
  ["signal", "startup crash with signal SIGTERM"],
  ["timeout", "readiness timeout"],
] as const)("reports the closed startup cause for %s", async (diagnostic, expected) => {
  const root = await fs.realpath(dirs.make("canary-public-cause-"));
  const rehearsal = await createCanaryProcessFixture(
    root,
    `
const args = process.argv.slice(2);
if (args.includes("--fix")) console.log("Doctor complete.");
else if (args.includes("--lint")) console.log(JSON.stringify({ok:true, checksRun:1, findings:[], warnings:[]}));
else if (args.includes("plugins")) console.log(JSON.stringify({plugins:[], diagnostics:[]}));
else if (args.includes("gateway")) {
  if (${JSON.stringify(diagnostic)} === "unterminated") {
    process.stderr.write("plugin load failed: discord: private-tenant");
    process.exitCode = 1;
  } else if (${JSON.stringify(diagnostic)} === "timeout") {
    console.error("openclaw-update-canary-progress: entry.bootstrap");
    setInterval(() => {}, 1000);
  } else {
  console.error("private-tenant warning token=synthetic-private-token at private-host.example");
  console.error(${JSON.stringify(diagnostic)});
  console.error("private stack frame at /home/private-owner/plugin.ts\\n".repeat(90));
  if (${JSON.stringify(diagnostic)} === "signal") process.stderr.write("", () => process.kill(process.pid, "SIGTERM"));
  else
  process.exitCode = 1;
  }
}
`,
  );
  const { stateDir } = rehearsal;
  vi.spyOn(rehearsals, "prepareUpdateCandidateRehearsal").mockResolvedValueOnce(rehearsal);
  const result = await validateUpdateCandidateCanary({
    root,
    config: {},
    stateDir,
    timeoutMs: diagnostic === "timeout" ? 1000 : 5000,
  });
  expect(result.status).toBe("error");
  const report = await prepareUpdateFailureReport(
    {
      attemptId: "startup-cause",
      result: { ...result, mode: "npm" },
    },
    { env: {}, stateDir },
  );
  if (expected === "[redacted-diagnostic]") {
    expect(report.body).toContain(
      "Failing check startupz (candidate-startup-failed): [redacted-diagnostic]",
    );
  } else {
    expect(report.body).toContain(
      `Failed phase candidate-gateway-startup: ${diagnostic === "signal" || diagnostic === "timeout" ? expected : `exit 1 (${expected})`}`,
    );
  }
  expect(report.body).not.toMatch(
    /private-tenant|private-owner|private-host|private-config|private-agent|10\.20\.30\.40|synthetic-private-token|\/home\//u,
  );
});
