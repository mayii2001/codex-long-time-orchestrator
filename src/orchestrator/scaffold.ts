import crypto from "node:crypto";
import path from "node:path";

import {
  appendRunEvent,
  attachRunToProject,
  ensureProjectRegistered,
  ensureRunLayout,
  writeRunState,
} from "./run-store.js";
import { DEFAULT_CHECK_INTERVAL_MS, type RunRecord } from "./types.js";

export interface CreateRunInput {
  repoPath: string;
}

export async function createRunScaffold(input: CreateRunInput): Promise<RunRecord> {
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  const repoPath = path.resolve(input.repoPath);
  const project = await ensureProjectRegistered(repoPath);

  await ensureRunLayout(repoPath, runId);

  const record: RunRecord = {
    runId,
    projectId: project.projectId,
    repoPath,
    title: null,
    createdAt: now,
    updatedAt: now,
    eventCount: 0,
    phase: "planning",
    status: "active",
    settings: {
      plannerModel: "gpt-5.4-mini",
      taskWorkerModel: "gpt-5.4-mini",
      maxAgentCount: 1,
      checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
    },
    notes: ["Run scaffold created."],
    context: {
      goalSummary: null,
      planSummary: null,
      executionSummary: null,
      conversationSummary: null,
      plannerPrompt: null,
    },
    planner: {
      turnCount: 0,
      activeDraftVersion: null,
      latestAssistantMessage: null,
      canExecute: false,
      missingFields: ["No plan draft yet."],
      isStreaming: false,
    },
    execution: {
      taskOrder: [],
      tasks: {},
    },
    runtime: {
      executionOwnerId: null,
      executionHeartbeatAt: null,
    },
  };

  await writeRunState(record);
  await attachRunToProject(project.projectId, runId);
  await appendRunEvent(repoPath, runId, {
    timestamp: now,
    type: "run_created",
    detail: "Initialized planner run.",
  });

  return record;
}
