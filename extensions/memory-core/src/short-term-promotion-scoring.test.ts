// Memory Core tests calibrate deterministic short-term promotion scoring.
import { describe, expect, it } from "vitest";
import {
  rankShortTermPromotionCandidates,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";
import {
  createMemoryCoreTestHarness,
  createRecallEntryForTest,
  shortTermTestState,
} from "./test-helpers.js";

const NOW_ISO = "2026-04-03T10:01:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const RECALL_DAYS = ["2026-04-01", "2026-04-02", "2026-04-03"];
const THREE_QUERY_HASHES = ["query-a", "query-b", "query-c"];

const { createTempWorkspace } = createMemoryCoreTestHarness();

function createRecallEntry(
  key: string,
  signalCount: number,
  avgScore: number,
  overrides: Partial<ShortTermRecallEntry> = {},
): ShortTermRecallEntry {
  return createRecallEntryForTest({
    key,
    snippet: `${key} durable note`,
    recallCount: 0,
    dailyCount: signalCount,
    totalScore: avgScore * signalCount,
    maxScore: avgScore,
    firstRecalledAt: "2026-04-01T10:00:00.000Z",
    lastRecalledAt: NOW_ISO,
    queryHashes: THREE_QUERY_HASHES,
    userQueryHashes: overrides.queryHashes ?? THREE_QUERY_HASHES,
    recallDays: RECALL_DAYS,
    conceptTags: ["backup", "glacier"],
    ...overrides,
  });
}

function writeRecallEntries(workspaceDir: string, entries: Record<string, ShortTermRecallEntry>) {
  return shortTermTestState.writeRawRecallStore(workspaceDir, {
    version: 1,
    updatedAt: NOW_ISO,
    entries,
  });
}

function rankCandidates(
  workspaceDir: string,
  options: Partial<Parameters<typeof rankShortTermPromotionCandidates>[0]> = {},
) {
  return rankShortTermPromotionCandidates({
    workspaceDir,
    minScore: 0,
    minRecallCount: 0,
    minUniqueQueries: 0,
    nowMs: NOW_MS,
    ...options,
  });
}

async function writeCalibrationStore(workspaceDir: string): Promise<void> {
  const entries = [
    createRecallEntry("genuine", 3, 0.6, { conceptTags: ["backup", "backups", "glacier", "s3"] }),
    createRecallEntry("filler", 3, 0.3, {
      snippet: "Routine heartbeat completed successfully.",
      conceptTags: [],
    }),
    createRecallEntry("oneoff", 1, 0.9, {
      queryHashes: ["query-a"],
      recallDays: ["2026-04-03"],
      conceptTags: ["novel", "signal", "single"],
    }),
  ];
  await writeRecallEntries(
    workspaceDir,
    Object.fromEntries(entries.map((entry) => [entry.key, entry])),
  );
  await shortTermTestState.writeRawPhaseSignalStore(workspaceDir, {
    version: 1,
    updatedAt: NOW_ISO,
    entries: Object.fromEntries(
      entries
        .filter((entry) => entry.key === "genuine")
        .map((entry) => [
          entry.key,
          { key: entry.key, lightHits: 3, remHits: 3, lastLightAt: NOW_ISO, lastRemAt: NOW_ISO },
        ]),
    ),
  });
}

describe("short-term promotion score calibration", () => {
  it("separates repeated durable facts from filler and high-signal one-offs", async () => {
    const workspaceDir = await createTempWorkspace("promotion-score-distribution-");
    await writeCalibrationStore(workspaceDir);

    const measured = await rankCandidates(workspaceDir);
    expect(
      Object.fromEntries(measured.map(({ key, score }) => [key, Number(score.toFixed(6))])),
    ).toEqual({
      genuine: 0.756014,
      filler: 0.519152,
      oneoff: 0.569376,
    });

    const promoted = await rankShortTermPromotionCandidates({ workspaceDir, nowMs: NOW_MS });
    expect(promoted.map((candidate) => candidate.key)).toEqual(["genuine"]);
  });

  it("keeps the minimum score boundary inclusive", async () => {
    const workspaceDir = await createTempWorkspace("promotion-score-boundary-");
    const boundary = createRecallEntry("boundary", 10, 0, {
      queryHashes: ["query-a", "query-b", "query-c", "query-d", "query-e"],
      recallDays: [],
      conceptTags: [],
    });
    await writeRecallEntries(workspaceDir, { boundary });
    await expect(rankCandidates(workspaceDir, { minScore: 0.54 })).resolves.toHaveLength(1);
    await expect(rankCandidates(workspaceDir, { minScore: 0.540001 })).resolves.toHaveLength(0);
  });

  it.each([
    { name: "recall-only", recallCount: 3, dailyCount: 0, minUniqueQueries: 3, retained: 1 },
    { name: "mixed", recallCount: 1, dailyCount: 2, minUniqueQueries: 1, retained: 0 },
  ])("preserves only unambiguous $name legacy query diversity", async (entry) => {
    const workspaceDir = await createTempWorkspace("promotion-legacy-upgrade-");
    const legacy = createRecallEntry(`legacy-${entry.name}`, 3, 1, {
      recallCount: entry.recallCount,
      dailyCount: entry.dailyCount,
    });
    delete legacy.userQueryHashes;
    await writeRecallEntries(workspaceDir, { legacy });
    const ranked = await rankCandidates(workspaceDir, { minUniqueQueries: entry.minUniqueQueries });
    expect(ranked).toHaveLength(entry.retained);
    if (entry.retained) {
      expect(ranked[0]?.uniqueQueries).toBe(3);
    }
  });
});
