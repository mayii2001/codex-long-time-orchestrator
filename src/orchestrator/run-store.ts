import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CHECK_INTERVAL_MS,
  type PlanDraft,
  PlannerTurnRecord,
  ProjectIndex,
  ProjectRecord,
  ProjectRunSummary,
  RunEvent,
  RunRecord,
  RunPhase,
  RunStatus,
  WorkerResult,
} from "./types.js";

const ORCHESTRATOR_ROOT = ".orchestrator";
const RUNS_DIR = "runs";
const TASK_PROCESS_TEXT_LIMIT = 20_000;

function toRunTitle(message: string | null | undefined): string | null {
  const compact = (message ?? "").replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }
  if (compact.length <= 72) {
    return compact;
  }
  return `${compact.slice(0, 69).trimEnd()}...`;
}

export function getGlobalOrchestratorHome(): string {
  return process.env.ORCH_HOME || path.join(os.homedir(), ".codex", "codex-agent-orchestrator");
}

export function getProjectsIndexPath(): string {
  return path.join(getGlobalOrchestratorHome(), "projects.json");
}

export function getRunsRoot(repoPath: string): string {
  return path.join(repoPath, ORCHESTRATOR_ROOT, RUNS_DIR);
}

export function getRunRoot(repoPath: string, runId: string): string {
  return path.join(getRunsRoot(repoPath), runId);
}

export function getStatePath(repoPath: string, runId: string): string {
  return path.join(getRunRoot(repoPath, runId), "state.json");
}

export function getEventsPath(repoPath: string, runId: string): string {
  return path.join(getRunRoot(repoPath, runId), "events.jsonl");
}

export function getPlannerRoot(repoPath: string, runId: string): string {
  return path.join(getRunRoot(repoPath, runId), "planner");
}

export function getPlannerTurnsPath(repoPath: string, runId: string): string {
  return path.join(getPlannerRoot(repoPath, runId), "turns.jsonl");
}

export function getPlannerDraftsRoot(repoPath: string, runId: string): string {
  return path.join(getPlannerRoot(repoPath, runId), "drafts");
}

export function getActiveDraftPath(repoPath: string, runId: string): string {
  return path.join(getPlannerRoot(repoPath, runId), "active-draft.json");
}

export function getExecutionPlanPath(repoPath: string, runId: string): string {
  return path.join(getPlannerRoot(repoPath, runId), "execution-plan.json");
}

export function getTasksRoot(repoPath: string, runId: string): string {
  return path.join(getRunRoot(repoPath, runId), "tasks");
}

export function getTaskRoot(repoPath: string, runId: string, taskId: string): string {
  return path.join(getTasksRoot(repoPath, runId), taskId);
}

export async function ensureProjectIndex(): Promise<void> {
  const indexPath = getProjectsIndexPath();
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  try {
    await fs.access(indexPath);
  } catch {
    const empty: ProjectIndex = { projects: [] };
    await fs.writeFile(indexPath, JSON.stringify(empty, null, 2), "utf8");
  }
}

export async function readProjectIndex(): Promise<ProjectIndex> {
  await ensureProjectIndex();
  const content = await fs.readFile(getProjectsIndexPath(), "utf8");
  return JSON.parse(content) as ProjectIndex;
}

export async function writeProjectIndex(index: ProjectIndex): Promise<void> {
  await ensureProjectIndex();
  await fs.writeFile(getProjectsIndexPath(), JSON.stringify(index, null, 2), "utf8");
}

export async function ensureProjectRegistered(repoPath: string): Promise<ProjectRecord> {
  const normalizedRepoPath = path.resolve(repoPath);
  const now = new Date().toISOString();
  const index = await readProjectIndex();
  const existing = index.projects.find((project) => project.repoPath === normalizedRepoPath);
  if (existing) {
    if (existing.displayName !== path.basename(normalizedRepoPath)) {
      existing.displayName = path.basename(normalizedRepoPath);
      existing.updatedAt = now;
      await writeProjectIndex(index);
    }
    return existing;
  }

  const project: ProjectRecord = {
    projectId: normalizedRepoPath.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    repoPath: normalizedRepoPath,
    displayName: path.basename(normalizedRepoPath),
    createdAt: now,
    updatedAt: now,
    runIds: [],
  };
  index.projects.push(project);
  await writeProjectIndex(index);
  return project;
}

export async function attachRunToProject(projectId: string, runId: string): Promise<void> {
  const index = await readProjectIndex();
  const project = index.projects.find((entry) => entry.projectId === projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  if (!project.runIds.includes(runId)) {
    project.runIds.push(runId);
    project.updatedAt = new Date().toISOString();
    await writeProjectIndex(index);
  }
}

export async function deleteRun(repoPath: string, runId: string): Promise<void> {
  const normalizedRepoPath = path.resolve(repoPath);
  const index = await readProjectIndex();
  const project = index.projects.find((entry) => entry.repoPath === normalizedRepoPath && entry.runIds.includes(runId));
  if (!project) {
    throw new Error(`Run not found: ${runId}`);
  }

  project.runIds = project.runIds.filter((entry) => entry !== runId);
  project.updatedAt = new Date().toISOString();
  await writeProjectIndex(index);

  await fs.rm(getRunRoot(normalizedRepoPath, runId), {
    recursive: true,
    force: false,
  });
}

export async function ensureRunLayout(repoPath: string, runId: string): Promise<void> {
  const runRoot = getRunRoot(repoPath, runId);
  await fs.mkdir(path.join(runRoot, "artifacts"), { recursive: true });
  await fs.mkdir(getPlannerDraftsRoot(repoPath, runId), { recursive: true });
  await fs.mkdir(getTasksRoot(repoPath, runId), { recursive: true });
}

export async function writeRunState(record: RunRecord): Promise<void> {
  const statePath = getStatePath(record.repoPath, record.runId);
  await fs.writeFile(statePath, JSON.stringify(record, null, 2), "utf8");
}

export async function readRunState(repoPath: string, runId: string): Promise<RunRecord> {
  const statePath = getStatePath(repoPath, runId);
  const content = await fs.readFile(statePath, "utf8");
  const parsed = JSON.parse(content) as Partial<RunRecord>;
  return {
    ...parsed,
    title: parsed.title ?? null,
    eventCount: parsed.eventCount ?? 0,
    settings: {
      plannerModel: parsed.settings?.plannerModel ?? "gpt-5.4-mini",
      taskWorkerModel: parsed.settings?.taskWorkerModel ?? "gpt-5.4-mini",
      maxAgentCount: parsed.settings?.maxAgentCount ?? 1,
      checkIntervalMs: parsed.settings?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    },
    planner: {
      turnCount: parsed.planner?.turnCount ?? 0,
      activeDraftVersion: parsed.planner?.activeDraftVersion ?? null,
      latestAssistantMessage: parsed.planner?.latestAssistantMessage ?? null,
      sessionId: parsed.planner?.sessionId ?? null,
      planComplete: parsed.planner?.planComplete ?? false,
      canExecute: parsed.planner?.canExecute ?? false,
      missingFields: parsed.planner?.missingFields ?? ["No plan draft yet."],
      isStreaming: parsed.planner?.isStreaming ?? false,
    },
    context: {
      goalSummary: parsed.context?.goalSummary ?? null,
      planSummary: parsed.context?.planSummary ?? null,
      executionSummary: parsed.context?.executionSummary ?? null,
      conversationSummary: parsed.context?.conversationSummary ?? null,
      maintainedSummary: parsed.context?.maintainedSummary ?? null,
      maintainedAt: parsed.context?.maintainedAt ?? null,
      maintainedByModel: parsed.context?.maintainedByModel ?? null,
      plannerPrompt: parsed.context?.plannerPrompt ?? null,
    },
    execution: parsed.execution ?? {
      taskOrder: [],
      tasks: {},
    },
    runtime: {
      executionOwnerId: parsed.runtime?.executionOwnerId ?? null,
      executionHeartbeatAt: parsed.runtime?.executionHeartbeatAt ?? null,
    },
  } as RunRecord;
}

export async function readProjectRunSummary(repoPath: string, runId: string): Promise<ProjectRunSummary> {
  const run = await readRunState(repoPath, runId);
  let title = run.title;
  if (!title) {
    const turns = await listPlannerTurns(repoPath, runId);
    title = toRunTitle(turns[0]?.userMessage);
  }
  return {
    runId,
    title,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    phase: run.phase,
    status: run.status,
  };
}

export function summarizeRunTitle(message: string): string | null {
  return toRunTitle(message);
}

export async function appendRunEvent(repoPath: string, runId: string, event: RunEvent): Promise<void> {
  const eventPath = getEventsPath(repoPath, runId);
  await fs.appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");
  const current = await readRunState(repoPath, runId);
  await writeRunState({
    ...current,
    eventCount: current.eventCount + 1,
    updatedAt: new Date().toISOString(),
  });
}

export async function listRunEvents(repoPath: string, runId: string): Promise<RunEvent[]> {
  const eventPath = getEventsPath(repoPath, runId);
  const content = await fs.readFile(eventPath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunEvent);
}

export async function updateRunState(
  repoPath: string,
  runId: string,
  patch: Partial<RunRecord>,
): Promise<RunRecord> {
  const current = await readRunState(repoPath, runId);
  const next: RunRecord = {
    ...current,
    ...patch,
    planner: patch.planner ?? current.planner,
    context: patch.context ?? current.context,
    execution: patch.execution ?? current.execution,
    runtime: patch.runtime ?? current.runtime,
    updatedAt: new Date().toISOString(),
  };
  await writeRunState(next);
  return next;
}

export async function setRunStatus(
  repoPath: string,
  runId: string,
  phase: RunPhase,
  status: RunStatus,
  detail: string,
): Promise<RunRecord> {
  const next = await updateRunState(repoPath, runId, { phase, status });
  await appendRunEvent(repoPath, runId, {
    timestamp: next.updatedAt,
    type: "status_changed",
    detail,
  });
  return next;
}

export async function appendRunNote(repoPath: string, runId: string, note: string): Promise<RunRecord> {
  const current = await readRunState(repoPath, runId);
  const notes = [...current.notes, note];
  const next = await updateRunState(repoPath, runId, { notes });
  await appendRunEvent(repoPath, runId, {
    timestamp: next.updatedAt,
    type: "note_added",
    detail: note,
  });
  return next;
}

export async function appendPlannerTurn(repoPath: string, runId: string, turn: PlannerTurnRecord): Promise<void> {
  await fs.appendFile(getPlannerTurnsPath(repoPath, runId), `${JSON.stringify(turn)}\n`, "utf8");
}

export async function listPlannerTurns(repoPath: string, runId: string): Promise<PlannerTurnRecord[]> {
  const turnsPath = getPlannerTurnsPath(repoPath, runId);
  try {
    const content = await fs.readFile(turnsPath, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PlannerTurnRecord);
  } catch {
    return [];
  }
}

export async function writeDraft(repoPath: string, runId: string, draft: PlanDraft): Promise<void> {
  const draftPath = path.join(getPlannerDraftsRoot(repoPath, runId), `draft-${String(draft.version).padStart(3, "0")}.json`);
  await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), "utf8");
  await fs.writeFile(getActiveDraftPath(repoPath, runId), JSON.stringify(draft, null, 2), "utf8");
}

export async function readActiveDraft(repoPath: string, runId: string): Promise<PlanDraft | null> {
  try {
    const content = await fs.readFile(getActiveDraftPath(repoPath, runId), "utf8");
    return JSON.parse(content) as PlanDraft;
  } catch {
    return null;
  }
}

export async function freezeExecutionPlan(repoPath: string, runId: string, draft: PlanDraft): Promise<void> {
  await fs.writeFile(getExecutionPlanPath(repoPath, runId), JSON.stringify(draft, null, 2), "utf8");
}

export async function readExecutionPlan(repoPath: string, runId: string): Promise<PlanDraft> {
  const content = await fs.readFile(getExecutionPlanPath(repoPath, runId), "utf8");
  return JSON.parse(content) as PlanDraft;
}

export async function writeWorkerResult(
  repoPath: string,
  runId: string,
  taskId: string,
  worker: WorkerResult,
): Promise<void> {
  const workerStatePath = path.join(getTaskRoot(repoPath, runId, taskId), "worker-result.json");
  await fs.mkdir(path.dirname(workerStatePath), { recursive: true });
  await fs.writeFile(workerStatePath, JSON.stringify(worker, null, 2), "utf8");
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function tailText(content: string | null, limit: number): string | null {
  if (content === null || content.length <= limit) {
    return content;
  }
  const omitted = content.length - limit;
  return `[truncated ${omitted} chars]\n${content.slice(-limit)}`;
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  const content = await readOptionalText(filePath);
  if (!content) {
    return null;
  }
  return JSON.parse(content) as T;
}

export async function readTaskProcessDetails(repoPath: string, runId: string, taskId: string): Promise<{
  taskId: string;
  workerResult: WorkerResult | null;
  prompt: string | null;
  response: unknown | null;
  stdout: string | null;
  stderr: string | null;
}> {
  const workerRoot = path.join(getTaskRoot(repoPath, runId, taskId), "worker");
  const workerResultPath = path.join(getTaskRoot(repoPath, runId, taskId), "worker-result.json");
  const promptPath = path.join(workerRoot, "prompt.txt");
  const responsePath = path.join(workerRoot, "response.json");
  const stdoutPath = path.join(workerRoot, "stdout.log");
  const stderrPath = path.join(workerRoot, "stderr.log");

  return {
    taskId,
    workerResult: await readOptionalJson<WorkerResult>(workerResultPath),
    prompt: tailText(await readOptionalText(promptPath), TASK_PROCESS_TEXT_LIMIT),
    response: await readOptionalJson<unknown>(responsePath),
    stdout: tailText(await readOptionalText(stdoutPath), TASK_PROCESS_TEXT_LIMIT),
    stderr: tailText(await readOptionalText(stderrPath), TASK_PROCESS_TEXT_LIMIT),
  };
}
