import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, beforeEach, describe } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { CLIENT_CREDENTIAL_SCHEMA_VERSION } from "./client-credential-schema.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import {
  UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME,
  resolveUpdateCandidateStatePath,
} from "./update-candidate-paths.js";
import {
  createStateDatabase,
  runStateWorker,
} from "./update-candidate-state-fixtures.test-support.js";
import {
  createUpdateStateInspectionDiagnostics,
  type UpdateStateInspectionProgress,
} from "./update-candidate-state.diagnostics.js";
import {
  UpdateCandidateSnapshotInventorySchema,
  collectStateDatabasePaths,
  readUpdateStateSchemaVersions,
} from "./update-candidate-state.js";
import { runUpdateCandidateSnapshotWorker } from "./update-candidate-state.test-support.js";
import { updateStateSchemaVersionsMatch } from "./update-candidate-state.versions.js";

describe("snapshot inventory", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("queues retained custom shared-state roots for exact capture with plugins disabled", async () => {
    const root = dirs.make("candidate-shared-roots-");
    const stateDir = path.join(root, "selected");
    const external = path.join(root, "external");
    for (const parent of [path.join(stateDir, "voice-calls"), external]) {
      const file = path.join(parent, "state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "");
    }
    const discovered = await collectStateDatabasePaths(
      {
        stateDir,
        config: {
          plugins: {
            enabled: false,
            entries: {
              "voice-call": { enabled: false, config: { store: external } },
              "@openclaw/voice-call": { config: { store: "~/retained-calls" } },
            },
          },
        },
        env: { HOME: root, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      { includeUnconfiguredAgents: false },
    );
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    expect(discovered.get(shared)).toEqual({ spellings: [shared], owners: [{ role: "global" }] });
    for (const parent of [path.join(stateDir, "voice-calls"), external]) {
      const file = path.join(parent, "state", "openclaw.sqlite");
      expect(discovered.get(file)).toEqual({ spellings: [file] });
    }
    expect(discovered.has(path.join(root, "retained-calls", "state", "openclaw.sqlite"))).toBe(
      false,
    );
  });

  it.each([
    "missing plugin dependency",
    "install record",
    "locator symlink",
    "database registration",
    "added file",
    "enlarged file",
  ])("keeps snapshot boundaries and failure attribution after %s changes", async (change) => {
    const root = dirs.make("candidate-inventory-drift-");
    const stateDir = path.join(root, "source");
    const inventoryRoot = path.join(root, "inventory");
    const targetStateDir = path.join(root, "snapshot");
    const candidateRoot = path.join(root, "candidate");
    await fs.mkdir(inventoryRoot);
    await fs.mkdir(candidateRoot);
    await fs.writeFile(path.join(candidateRoot, "package.json"), '{"name":"openclaw"}');
    const writePlugin = async (project: string, size: number) => {
      const relative = path.join("npm", "projects", project, "node_modules", "@example", "demo");
      const directory = path.join(stateDir, relative);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "package.json"), '{"name":"@example/demo"}');
      await fs.writeFile(path.join(directory, "index.js"), "export default {};\n");
      const payload = await fs.open(path.join(directory, "payload.bin"), "w");
      try {
        await payload.truncate(size);
      } finally {
        await payload.close();
      }
      return { directory, relative };
    };
    const initial = await writePlugin("initial", 4096);
    const larger = await writePlugin("larger", 16 * 1024 * 1024);
    const locator = path.join(stateDir, "extensions", "demo");
    if (change === "locator symlink") {
      await fs.mkdir(path.dirname(locator));
      await fs.symlink(initial.directory, locator, "junction");
    }
    const env = { HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    const setRecord = (installPath: string) => {
      const db = openOpenClawStateDatabase({ env }).db;
      db.prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json",
      ).run(
        "plugins.installedIndex",
        JSON.stringify({
          revision: 1,
          index: {
            installRecords: {
              demo: { source: "npm", spec: "@example/demo@1.0.0", installPath },
            },
          },
        }),
      );
      closeOpenClawStateDatabaseByPath(shared);
    };
    setRecord(change === "locator symlink" ? locator : initial.directory);
    let databaseInventory: string[] = [];
    const run = async (mode: "inventory" | "snapshot") => {
      const progress: UpdateStateInspectionProgress[] = [];
      const diagnostics = createUpdateStateInspectionDiagnostics({
        operation: "State snapshot",
        phase: mode,
        paths: [stateDir],
        onProgress: (value) => progress.push(value),
      });
      const result = await runStateWorker({
        mode,
        stateDir,
        targetStateDir: mode === "inventory" ? inventoryRoot : targetStateDir,
        candidateRoot,
        config: {},
        env,
        databaseInventory,
        pluginPlanPath: path.join(inventoryRoot, UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME),
      });
      diagnostics.onOutputChunk(result.stderr, "stderr");
      return { ...result, diagnostics, progress };
    };
    const expectFailurePhase = (
      result: Awaited<ReturnType<typeof run>>,
      phase: string,
      source = stateDir,
    ) => {
      const message = result.diagnostics.failure(
        result.diagnostics.stderr() || result.stderr.toString("utf8"),
        result.termination,
      ).message;
      expect(message).toContain(`during ${phase} for ${source} (scope:`);
      expect(message).toContain("source paths");
      expect(message).toContain("Check access to the reported source");
      expect(message).not.toContain("Check database access");
    };
    if (change === "missing plugin dependency") {
      // An external missing target must fail inventory rather than survive as an internal link.
      await fs.symlink(
        path.join(root, "missing-dependency"),
        path.join(path.dirname(initial.directory), "missing"),
        "junction",
      );
      const sourceDatabase = await fs.readFile(shared);
      const inventoried = await run("inventory");
      expect(inventoried.code).not.toBe(0);
      expect(inventoried.stderr.toString("utf8")).toContain(
        "Cannot privately copy plugin dependency",
      );
      expect(inventoried.progress).toContainEqual(
        expect.objectContaining({
          phase: "shared database snapshot",
          snapshot: expect.objectContaining({ status: "completed" }),
        }),
      );
      expect((await fs.readFile(shared)).equals(sourceDatabase)).toBe(true);
      expectFailurePhase(inventoried, "plugin inventory");
      return;
    }
    const inventoried = await run("inventory");
    expect(inventoried.code, inventoried.stderr.toString("utf8")).toBe(0);
    const inventory = UpdateCandidateSnapshotInventorySchema.parse(
      JSON.parse(inventoried.stdout.toString("utf8")),
    );
    databaseInventory = [...inventory.databases.keys()];
    expect(inventory.pluginBytes).toBeLessThan(16 * 1024 * 1024);
    let largerCopyPath = path.join(targetStateDir, larger.relative);
    if (change === "install record") {
      setRecord(larger.directory);
    } else if (change === "locator symlink") {
      await fs.unlink(locator);
      await fs.symlink(larger.directory, locator, "junction");
    } else if (change === "database registration") {
      const external = path.join(root, "late-agent.sqlite");
      const agentDb = openNodeSqliteDatabase(external);
      agentDb.exec(
        "PRAGMA user_version = 3; CREATE TABLE evidence(value BLOB); INSERT INTO evidence VALUES (zeroblob(16777216));",
      );
      agentDb.close();
      const registry = openOpenClawStateDatabase({ env }).db;
      registry
        .prepare(
          "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
        )
        .run("late", external);
      closeOpenClawStateDatabaseByPath(shared);
      largerCopyPath = path.join(
        resolveUpdateCandidateStatePath(stateDir, targetStateDir, path.dirname(external)),
        path.basename(external),
      );
    } else {
      const name = change === "added file" ? "late.bin" : "payload.bin";
      const payload = await fs.open(path.join(initial.directory, name), "a");
      try {
        await payload.truncate(16 * 1024 * 1024);
      } finally {
        await payload.close();
      }
      largerCopyPath = path.join(targetStateDir, initial.relative, name);
    }
    const sourceDatabase = await fs.readFile(shared);
    const snapshot = await run("snapshot");
    const copiedNewOwner = await fs.access(largerCopyPath).then(
      () => true,
      () => false,
    );
    console.log(
      "Candidate plugin ownership drift",
      JSON.stringify({
        change,
        pluginBytes: inventory.pluginBytes,
        exitCode: snapshot.code,
        copiedNewOwner,
      }),
    );
    expect((await fs.readFile(shared)).equals(sourceDatabase)).toBe(true);
    if (change === "added file" || change === "locator symlink") {
      expect(snapshot.code, snapshot.stderr.toString("utf8")).toBe(0);
    } else {
      expect(snapshot.code, "snapshot must refuse uninventoried bytes").not.toBe(0);
      expect(snapshot.stderr.toString("utf8")).toContain(
        change === "enlarged file"
          ? "file exceeds limit of 4096 bytes (got 16777216)"
          : change === "install record"
            ? "Plugin record locator was not inventoried"
            : "changed after snapshot inventory",
      );
      expectFailurePhase(
        snapshot,
        change === "database registration" ? "database snapshot" : "plugin snapshot",
        change === "database registration" ? shared : stateDir,
      );
    }
    expect(copiedNewOwner).toBe(false);
  });
});

describe("snapshot projections and execution approvals", () => {
  const dirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(dirs.make("candidate-policy-"));
  });
  function runSnapshotWorker(
    input: Omit<Parameters<typeof runUpdateCandidateSnapshotWorker>[0], "candidateRoot">,
  ) {
    return runUpdateCandidateSnapshotWorker({
      ...input,
      candidateRoot: path.join(root, "candidate-host"),
    });
  }

  const createDatabase = (file: string) =>
    createStateDatabase(
      file,
      "PRAGMA user_version = 3; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('preserved');",
    );

  function registerDatabases(stateDir: string, registrations: [string, string][]): void {
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } }).db;
    try {
      const insert = registry.prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
      );
      for (const registration of registrations) {
        insert.run(...registration);
      }
    } finally {
      closeOpenClawStateDatabaseByPath(path.join(stateDir, "state", "openclaw.sqlite"));
    }
  }

  function readRegisteredPath(stateDir: string, agentId: string): string {
    using registry = openNodeSqliteDatabase(path.join(stateDir, "state", "openclaw.sqlite"));
    const row = registry
      .prepare("SELECT path FROM agent_databases WHERE agent_id = ?")
      .get(agentId);
    assert(typeof row?.path === "string", "Expected a registered database path");
    return row.path;
  }

  function expectPreservedEvidence(file: string): void {
    using copied = openNodeSqliteDatabase(file);
    expect(copied.prepare("SELECT value FROM evidence").get()).toMatchObject({
      value: "preserved",
    });
  }

  // Both raw locators require a hashed projection, not in-root rebasing.
  it.skipIf(process.platform !== "win32").each(["namespaced external", "noncanonical in-root"])(
    "keeps a %s registered database on its raw projection identity",
    async (kind) => {
      const source = path.join(root, "source");
      const target = path.join(root, "copy");
      const external = kind === "namespaced external";
      const file = external
        ? path.join(root, "external", "openclaw-agent.sqlite")
        : path.join(source, "agents", "main", "agent", "openclaw-agent.sqlite");
      await createDatabase(file);
      const locator = external
        ? `\\\\?\\${file}`
        : source +
          path.sep +
          ["agents", "main", ".", "agent", "openclaw-agent.sqlite"].join(path.sep);
      const agentId = external ? "external" : "main";
      registerDatabases(source, [[agentId, locator]]);
      await runSnapshotWorker({
        stateDir: source,
        targetStateDir: target,
        config: {},
      });
      const rebound = readRegisteredPath(target, agentId);
      expect(path.isAbsolute(rebound)).toBe(false);
      expect(rebound).toMatch(/^candidate-external/);
      expectPreservedEvidence(path.join(target, rebound));
    },
  );

  // With an extended-length state root, directory discovery queues the
  // namespaced spelling while a relative registration resolves to the same
  // database; both must dedupe to one copy at one projection identity.
  it.skipIf(process.platform !== "win32")(
    "dedupes a relative registration under a namespaced state root",
    async () => {
      const plainState = path.join(root, "source");
      const namespacedState = `\\\\?\\${plainState}`;
      const target = path.join(root, "copy");
      const canonical = path.join(plainState, "agents", "main", "agent", "openclaw-agent.sqlite");
      await createDatabase(canonical);
      registerDatabases(plainState, [
        ["main", path.join("agents", "main", "agent", "openclaw-agent.sqlite")],
      ]);
      const inspected = await readUpdateStateSchemaVersions({
        stateDir: namespacedState,
        config: {},
      });
      // Older updaters captured rollback baselines with the namespaced spelling;
      // versions-mode responses must keep that path identity.
      const namespacedDb =
        namespacedState +
        path.sep +
        ["agents", "main", "agent", "openclaw-agent.sqlite"].join(path.sep);
      expect(inspected.map((entry) => entry.path)).toContain(namespacedDb);
      expect(inspected.map((entry) => entry.path)).not.toContain(canonical);
      const versions = await runSnapshotWorker({
        stateDir: namespacedState,
        targetStateDir: target,
        config: {},
      });
      // Snapshot mode reports the same legacy identities for the deduped copy.
      expect(versions).toEqual(inspected);
      const rebound = readRegisteredPath(target, "main");
      expect(path.isAbsolute(rebound)).toBe(false);
      // The rebound registry entry must name exactly the one copied database.
      expectPreservedEvidence(path.join(target, rebound));
    },
  );

  // Released 2026.9.3/2026.9.4 workers reported every discovered spelling, so a
  // host whose registry carries both a relative row and a \\?\-prefixed row for
  // one database produced a mixed-alias versions baseline. The released Doctor
  // update path compares those exact paths against the candidate's response:
  // the candidate must publish every raw alias while still deduping the physical
  // snapshot copies, or the schema comparison fails on exactly the Windows
  // installs this fix targets.
  it.skipIf(process.platform !== "win32")(
    "keeps every raw alias in the versions response for a released mixed-alias baseline",
    async () => {
      const source = path.join(root, "source");
      const target = path.join(root, "copy");
      const canonical = path.join(source, "agents", "main", "agent", "openclaw-agent.sqlite");
      await createDatabase(canonical);
      const namespaced = `\\\\?\\${canonical}`;
      const shared = path.join(source, "state", "openclaw.sqlite");
      registerDatabases(source, [
        ["main", path.join("agents", "main", "agent", "openclaw-agent.sqlite")],
        ["main", namespaced],
      ]);
      // Retain the released worker's raw aliases alongside this current profile's
      // local credentials; neither comes from the response under test.
      const sharedDb = openNodeSqliteDatabase(shared, { readOnly: true });
      const releasedBaseline = [
        {
          path: shared,
          userVersion: readSqliteUserVersion(sharedDb),
          contentVersion: readStateSchemaContentVersion(sharedDb),
        },
        { path: canonical, userVersion: 3 },
        { path: namespaced, userVersion: 3 },
        {
          path: path.join(source, "client", "credentials.sqlite"),
          userVersion: CLIENT_CREDENTIAL_SCHEMA_VERSION,
        },
      ];
      sharedDb.close();
      const inspected = await readUpdateStateSchemaVersions({
        stateDir: source,
        config: {},
      });
      expect(inspected.map((entry) => entry.path)).toEqual(
        expect.arrayContaining([shared, canonical, namespaced]),
      );
      expect(inspected).toContainEqual({
        path: path.join(source, "control", "services.sqlite"),
        userVersion: null,
      });
      expect(inspected).toContainEqual({
        path: path.join(source, "client", "credentials.sqlite"),
        userVersion: CLIENT_CREDENTIAL_SCHEMA_VERSION,
      });
      expect(inspected).toHaveLength(5);
      expect(
        updateStateSchemaVersionsMatch(releasedBaseline, inspected, { sharedPath: shared }),
      ).toBe(true);
      const versions = await runSnapshotWorker({
        stateDir: source,
        targetStateDir: target,
        config: {},
      });
      // Snapshot mode publishes the same aliases but copies each database once.
      expect(versions).toEqual(inspected);
      const rebound = readRegisteredPath(target, "main");
      expect(path.isAbsolute(rebound)).toBe(false);
      expect(rebound.split(/[\\/]/)).toEqual(["agents", "main", "agent", "openclaw-agent.sqlite"]);
      expectPreservedEvidence(path.join(target, rebound));
    },
  );

  it.each(["", ".doctor-importing"])(
    "rehearses conflicting exec approvals from the copied policy%s without modifying source",
    async (suffix) => {
      const source = path.join(root, "source");
      const target = path.join(root, "copy");
      const env = { OPENCLAW_STATE_DIR: source };
      const { writeExecApprovalsConfigRow, readExecApprovalsConfigRow } =
        await import("./exec-approvals-sqlite.js");
      const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
        await import("./state-migrations.exec-approvals.js");
      const canonical = {
        version: 1 as const,
        defaults: { security: "deny" as const },
        agents: {},
      };
      const db = openOpenClawStateDatabase({ env }).db;
      writeExecApprovalsConfigRow({ db, file: canonical });
      const canonicalBefore = readExecApprovalsConfigRow(db)?.raw_json;
      closeOpenClawStateDatabaseForTest();
      const sourcePath = path.join(source, `exec-approvals.json${suffix}`);
      const raw = JSON.stringify({ version: 1, defaults: { security: "full" }, agents: {} });
      await fs.writeFile(sourcePath, raw);
      await runSnapshotWorker({ stateDir: source, targetStateDir: target, config: {} });
      const copiedPath = path.join(target, `exec-approvals.json${suffix}`);
      expect(await fs.readFile(copiedPath, "utf8")).toBe(raw);
      const copiedEnv = { OPENCLAW_STATE_DIR: target };
      const result = await migrateLegacyExecApprovals({
        stateDir: target,
        env: copiedEnv,
        detected: detectLegacyExecApprovals({ stateDir: target, doctorOnlyStateMigrations: true }),
      });
      expect(result.warnings.join(" ")).toContain("Conflicting legacy exec approvals remain");
      expect(result.changes).toEqual([]);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(raw);
      expect(readExecApprovalsConfigRow(openOpenClawStateDatabase({ env }).db)?.raw_json).toBe(
        canonicalBefore,
      );
    },
  );

  it.each(["reappeared", "interrupted"])(
    "rehearses receipt-authorized legacy policy cleanup (%s)",
    async (sourceState) => {
      const source = path.join(root, "source");
      const target = path.join(root, "copy");
      const env = { OPENCLAW_STATE_DIR: source };
      const { writeExecApprovalsConfigRow } = await import("./exec-approvals-sqlite.js");
      const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
        await import("./state-migrations.exec-approvals.js");
      await fs.mkdir(source);
      const sourcePath = path.join(source, "exec-approvals.json");
      const interrupted = sourceState === "interrupted";
      const raw = JSON.stringify(
        interrupted
          ? {
              version: 1,
              agents: { main: { allowlist: [{ pattern: "/usr/bin/rg", lastUsedAt: null }] } },
            }
          : { version: 1, defaults: { security: "full" }, agents: {} },
      );
      await fs.writeFile(sourcePath, raw);
      const imported = await migrateLegacyExecApprovals({
        stateDir: source,
        env,
        detected: detectLegacyExecApprovals({ stateDir: source, doctorOnlyStateMigrations: true }),
        ...(interrupted
          ? {
              removeSource: () => {
                throw new Error("synthetic interrupted cleanup");
              },
            }
          : {}),
      });
      if (interrupted) {
        expect(imported.warnings.join(" ")).toContain("cleanup failed");
      } else {
        expect(imported.warnings).toEqual([]);
        expect(imported.changes.length).toBeGreaterThan(0);
        writeExecApprovalsConfigRow({
          db: openOpenClawStateDatabase({ env }).db,
          file: { version: 1, defaults: { security: "deny" }, agents: {} },
        });
      }
      closeOpenClawStateDatabaseForTest();
      // A reappearing imported source cannot undo a later policy edit.
      if (!interrupted) {
        await fs.writeFile(sourcePath, raw);
      }
      await runSnapshotWorker({ stateDir: source, targetStateDir: target, config: {} });
      const result = await migrateLegacyExecApprovals({
        stateDir: target,
        env: { OPENCLAW_STATE_DIR: target },
        detected: detectLegacyExecApprovals({ stateDir: target, doctorOnlyStateMigrations: true }),
      });
      expect(result.warnings).toEqual([]);
      if (interrupted) {
        expect(result.changes).toContain(
          "Completed cleanup for previously imported legacy exec approvals.",
        );
        await expect(
          fs.stat(path.join(target, "exec-approvals.json.doctor-importing")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(result.changes.length).toBeGreaterThan(0);
      }
      expect(
        await fs.readFile(`${sourcePath}${interrupted ? ".doctor-importing" : ""}`, "utf8"),
      ).toBe(raw);
    },
  );
});
