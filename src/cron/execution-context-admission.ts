/**
 * Collects the live facts one scheduled occurrence needs and mints its
 * execution context. Nothing reads the context yet; consumers switch to it phase
 * by phase. A failure here never fails the run.
 */
import { access } from "node:fs/promises";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import { prepareCommandOwnerAuthority } from "../auto-reply/command-auth.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { prepareSessionGenerationFacts } from "../config/sessions/session-delivery-generation.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCreatorSandbox } from "../gateway/operator-role-policy.js";
import { decodeGatewayOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import {
  buildScheduledExecutionContext,
  resolveScheduledRequester,
  type ScheduledAdmissionFacts,
  type ScheduledExecutionContextResult,
  type ScheduledExecutionFacts,
} from "./execution-context.js";
import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import type { CronParentUnavailable, CronStoredJob } from "./types.js";

type ScheduledExecutionContext = ScheduledExecutionFacts &
  Readonly<{
    /** Throws when the parent incarnation or the admitted run is no longer current. */
    assertCurrent: () => void;
  }>;

type MintParams = {
  cfg: OpenClawConfig;
  job: CronStoredJob;
  trigger: "cron" | "event";
  ingressBoundary?: string;
  runId: string;
  agentId: string;
  runSessionKey: string;
  storePath: string;
  toolsAllow?: readonly string[];
  /** Restored operator source authority, when the occurrence carries one. */
  operatorAuthorityRestored: boolean;
};

export type MintedScheduledExecution = Readonly<{
  result: ScheduledExecutionContextResult;
  /** Binds the context to the admitted run; the admission owner reads it through `current`. */
  bind: (assertAdmitted: () => void) => void;
  current: () => ScheduledExecutionContext | undefined;
  release: () => void;
}>;

function ingressFor(boundary: string | undefined): ScheduledAdmissionFacts["ingress"] {
  if (boundary === "gateway.hooks.plugin") {
    return "plugin-hook";
  }
  return boundary === "gateway.hooks.agent" ? "webhook" : "channel-join";
}

async function checkRequesterOwner(params: MintParams): Promise<boolean> {
  const requester = resolveScheduledRequester(params.job);
  switch (requester.kind) {
    case "operator-source":
      return params.operatorAuthorityRestored;
    case "channel": {
      const prepared = await prepareCommandOwnerAuthority(params.cfg, requester.requester);
      return prepared.source !== undefined && prepared.isCurrent(params.cfg);
    }
    case "profile":
      try {
        captureResidentUserProfileAccess(requester.profileId).assertCurrent();
      } catch {
        return false;
      }
      // Named roles describe team operators; only an untiered install or the
      // Gateway owner profile carries owner authority.
      return !params.cfg.gateway?.roles || requester.profileId === GATEWAY_OWNER_PROFILE_ID;
    case "unknown":
      return false;
  }
  return false;
}

// Same precedence as the builder's principal resolution: the operator source names
// the exact incarnation, then the creating conversation.
function parentSessionKeyOf(job: CronStoredJob): string | undefined {
  if (job.operatorSource) {
    try {
      return decodeGatewayOperatorRecoverySource(job.operatorSource.source).sessionKey;
    } catch {
      return undefined;
    }
  }
  return job.sourceConversation?.sessionKey;
}

async function readParentRow(params: MintParams): Promise<ScheduledAdmissionFacts["parentRow"]> {
  const parentSessionKey = parentSessionKeyOf(params.job);
  if (!parentSessionKey) {
    return undefined;
  }
  const entry = await readSessionEntryInWorker({
    sessionKey: parentSessionKey,
    storePath: params.storePath,
    readConsistency: "latest",
  });
  const worktreePath = entry?.worktree ? entry.spawnedCwd : undefined;
  const worktreeExists = worktreePath
    ? await access(worktreePath).then(
        () => true,
        () => false,
      )
    : false;
  return parentRowFactsFromEntry(entry, worktreeExists);
}

type ParentEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "lifecycleRevision"
  | "archivedAt"
  | "spawnedWorkspaceDir"
  | "spawnedCwd"
  | "worktree"
  | "sandbox"
>;

/** Builder facts for a parent session row; shared with the development replay. */
export function parentRowFactsFromEntry(
  entry: ParentEntry | undefined,
  worktreeExists: boolean,
): NonNullable<ScheduledAdmissionFacts["parentRow"]> {
  if (!entry?.sessionId) {
    return { missing: true };
  }
  const worktreePath = entry.worktree ? entry.spawnedCwd : undefined;
  return {
    sessionId: entry.sessionId,
    ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
    archived: typeof entry.archivedAt === "number",
    ...(entry.spawnedWorkspaceDir ? { workspaceDir: entry.spawnedWorkspaceDir } : {}),
    ...(entry.spawnedCwd ? { cwd: entry.spawnedCwd } : {}),
    ...(worktreePath ? { worktree: { path: worktreePath, exists: worktreeExists } } : {}),
    sandboxRequired: entry.sandbox === "required",
  };
}

/** Admission facts from already-read inputs; shared with the development replay. */
export function assembleScheduledAdmissionFacts(
  params: Omit<MintParams, "storePath" | "operatorAuthorityRestored">,
  parentRow: ScheduledAdmissionFacts["parentRow"],
  owner: boolean | undefined,
): ScheduledAdmissionFacts {
  return {
    trigger: params.trigger,
    ...(params.trigger === "event" ? { ingress: ingressFor(params.ingressBoundary) } : {}),
    occurrence: {
      runId: params.runId,
      executionRevision: params.job.operatorSource?.executionRevision ?? "",
    },
    agentId: params.agentId,
    runSessionKey: params.runSessionKey,
    agentMainSessionKey: resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId }),
    agentSandboxMode: resolveSandboxConfigForAgent(params.cfg, params.agentId).mode,
    ...(resolveCreatorSandbox(params.cfg, { actor: params.job.createdActor })
      ? { creatorRoleSandbox: "required" as const }
      : {}),
    ...(params.toolsAllow ? { resolvedToolsAllow: params.toolsAllow } : {}),
    ...(parentRow ? { parentRow } : {}),
    ...(owner !== undefined ? { requesterCheck: { owner } } : {}),
  };
}

/** Mints the context for one occurrence. Errors become a `fail` result. */
async function mintScheduledExecutionContext(
  params: MintParams,
): Promise<MintedScheduledExecution> {
  let releaseLease = () => {};
  let assertParentCurrent = () => {};
  let result: ScheduledExecutionContextResult;
  try {
    const parentRow = await readParentRow(params);
    // Only parent-linked jobs recheck a requester; other principals keep legacy authority.
    const owner = parentRow ? await checkRequesterOwner(params) : undefined;
    const facts = assembleScheduledAdmissionFacts(params, parentRow, owner);
    result = buildScheduledExecutionContext(params.job, facts);
    if (result.status === "ready" && result.facts.principal.kind === "parent") {
      const { parent } = result.facts.principal;
      const generation = await prepareSessionGenerationFacts({
        agentId: params.agentId,
        storePath: params.storePath,
        sessionKey: parent.sessionKey,
        sessionId: parent.sessionId,
        lifecycleRevision: parent.lifecycleRevision ?? null,
      });
      releaseLease = generation.release;
      assertParentCurrent = () => generation.assertCurrent();
    }
  } catch (error) {
    result = { status: "fail", error: error instanceof Error ? error.message : String(error) };
  }
  let context: ScheduledExecutionContext | undefined;
  return {
    result,
    bind(assertAdmitted) {
      if (result.status !== "ready") {
        return;
      }
      context = {
        ...result.facts,
        assertCurrent: () => {
          assertAdmitted();
          assertParentCurrent();
        },
      };
    },
    current: () => context,
    release() {
      context = undefined;
      releaseLease();
      releaseLease = () => {};
    },
  };
}

/** The prompt executor's scheduled tool policy, from the job's stored authority fields. */
export function resolveCronJobToolPolicyContext(
  job: CronStoredJob,
  toolsAllow: string[] | undefined,
) {
  return resolveScheduledToolPolicyContext({
    toolsAllow,
    scheduledToolPolicy: resolveCronScheduledToolPolicy({
      toolsAllow,
      scheduledToolPolicy: job.scheduledToolPolicy,
      owner: job.owner,
    }),
    callerOrigin: job.toolsAllowProvenance?.callerOrigin,
    execTarget: job.toolsAllowExecTarget,
  });
}

/** Mints the context for one prompt-executor attempt. */
export function mintCronPromptExecutionContext(
  params: {
    cfgWithAgentDefaults: OpenClawConfig;
    job: CronStoredJob;
    agentId: string;
    runSessionKey: string;
    cronSession: { storePath: string };
    agentPayload?: { toolsAllow?: string[] } | null;
    operatorAuthority?: unknown;
    executionIdentity?: { ingress?: { boundary?: string } };
  },
  run: { runId: string; trigger: "cron" | "event" },
) {
  return mintScheduledExecutionContext({
    cfg: params.cfgWithAgentDefaults,
    job: params.job,
    trigger: run.trigger,
    ingressBoundary: params.executionIdentity?.ingress?.boundary,
    runId: run.runId,
    agentId: params.agentId,
    runSessionKey: params.runSessionKey,
    storePath: params.cronSession.storePath,
    toolsAllow: params.agentPayload?.toolsAllow,
    operatorAuthorityRestored: params.operatorAuthority !== undefined,
  });
}

/**
 * Pre-session parent check for jobs linked to an exact parent conversation.
 * Returns the pause reason when the parent is removed or archived, or its bound
 * worktree is gone. A reset parent never pauses, and read failures never pause a job.
 */
export async function resolveScheduledParentPause(params: {
  cfg: OpenClawConfig;
  job: CronStoredJob;
  agentId: string;
  storePath: string;
}): Promise<CronParentUnavailable | undefined> {
  if (!params.job.sourceConversation && !params.job.operatorSource) {
    return undefined;
  }
  const base = {
    cfg: params.cfg,
    job: params.job,
    trigger: "cron" as const,
    runId: "parent-check",
    agentId: params.agentId,
    runSessionKey: `agent:${params.agentId}:cron:${params.job.id}`,
    storePath: params.storePath,
    operatorAuthorityRestored: false,
  };
  let parentRow: ScheduledAdmissionFacts["parentRow"];
  try {
    parentRow = await readParentRow(base);
  } catch {
    return undefined;
  }
  const result = buildScheduledExecutionContext(
    params.job,
    assembleScheduledAdmissionFacts(base, parentRow, false),
  );
  return result.status === "pause"
    ? {
        reason: result.reason,
        parentSessionKey: result.parentSessionKey,
        ...(result.worktreePath ? { worktreePath: result.worktreePath } : {}),
      }
    : undefined;
}

/** The single notice a paused job sends; names the parent and the repair. */
export function buildScheduledParentPauseNotice(params: {
  job: { id: string; name?: string };
  pause: CronParentUnavailable;
}): string {
  const name = (params.job.name || params.job.id).replace(/\s+/g, " ").trim().slice(0, 120);
  const { pause } = params;
  const cause =
    pause.reason === "worktree-missing"
      ? `its worktree \`${pause.worktreePath ?? "unknown"}\` no longer exists`
      : `it was ${pause.reason}`;
  return [
    `⚠️ Automation "${name}" is paused because the conversation that created it, \`${pause.parentSessionKey}\`, is unavailable: ${cause}.`,
    "Its runs used that conversation's access, and no other access is used in its place.",
    `Restore the conversation and run \`openclaw automations enable ${params.job.id}\`, or recreate the automation from another conversation.`,
  ].join("\n");
}
