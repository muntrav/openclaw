import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { CLIENT_CREDENTIAL_SCHEMA_VERSION } from "./client-credential-schema.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";
import { runUpdateCandidateSnapshotWorker } from "./update-candidate-state.test-support.js";
import { updateStateSchemaVersionsMatch } from "./update-candidate-state.versions.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-state-paths-")));
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});

async function createDatabase(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  using db = openNodeSqliteDatabase(file);
  db.exec(
    "PRAGMA user_version = 3; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('preserved');",
  );
}

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
  const row = registry.prepare("SELECT path FROM agent_databases WHERE agent_id = ?").get(agentId);
  assert(typeof row?.path === "string", "Expected a registered database path");
  return row.path;
}

function expectPreservedEvidence(file: string): void {
  using copied = openNodeSqliteDatabase(file);
  expect(copied.prepare("SELECT value FROM evidence").get()).toMatchObject({ value: "preserved" });
}

function runSnapshotWorker(
  input: Omit<Parameters<typeof runUpdateCandidateSnapshotWorker>[0], "candidateRoot">,
) {
  return runUpdateCandidateSnapshotWorker({
    ...input,
    candidateRoot: path.join(root, "candidate-host"),
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
