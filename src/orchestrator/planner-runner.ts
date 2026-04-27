import crypto from "node:crypto";

import { buildRunContextState } from "./context-assembler.js";
import {
  appendPlannerTurn,
  appendRunEvent,
  appendRunNote,
  freezeExecutionPlan,
  listPlannerTurns,
  readActiveDraft,
  readExecutionPlan,
  readRunState,
  setRunStatus,
  summarizeRunTitle,
  updateRunState,
  writeDraft,
} from "./run-store.js";
import { runContextMaintenanceWorker, runPlannerTurn, runTaskWorker } from "./codex-worker.js";
import type {
  ExecutionState,
  PlanDraft,
  PlanTask,
  PlannerTurnRecord,
  RunRecord,
  TaskExecutionRecord,
} from "./types.js";

const EXECUTION_HEARTBEAT_INTERVAL_MS = 2_000;
const EXECUTION_HEARTBEAT_TTL_MS = 15_000;
const activeExecutionControllers = new Map<string, AbortController>();
const activePlannerControllers = new Map<string, AbortController>();
const PLANNER_INTERRUPTED_BY_OPERATOR = "Planner interrupted by operator.";
const PLANNER_INTERRUPTED_BY_DISCONNECT = "Planner stream ended because the browser connection closed.";

function isPlannerAbortMessage(message: string): boolean {
  return message === PLANNER_INTERRUPTED_BY_OPERATOR || message === PLANNER_INTERRUPTED_BY_DISCONNECT;
}

export function isPlannerAbortError(error: unknown): boolean {
  return error instanceof Error && isPlannerAbortMessage(error.message);
}

interface TerminateTaskReason {
  type: "task-terminated";
  runId: string;
  taskId: string;
  message: string;
}

function isTerminateTaskReason(value: unknown): value is TerminateTaskReason {
  return Boolean(
    value
    && typeof value === "object"
    && "type" in value
    && "runId" in value
    && "taskId" in value
    && "message" in value
    && (value as { type?: string }).type === "task-terminated",
  );
}

function toExecutionAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (isTerminateTaskReason(reason)) {
    return new Error(reason.message);
  }
  return new Error(typeof reason === "string" ? reason : "Execution aborted.");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw toExecutionAbortError(signal.reason);
  }
}

export function isExecutionLive(run: RunRecord, now = Date.now()): boolean {
  if (!run.runtime.executionOwnerId || !run.runtime.executionHeartbeatAt) {
    return false;
  }
  const heartbeatAt = Date.parse(run.runtime.executionHeartbeatAt);
  if (Number.isNaN(heartbeatAt)) {
    return false;
  }
  return now - heartbeatAt <= EXECUTION_HEARTBEAT_TTL_MS;
}

export async function terminateTaskExecution(run: RunRecord, taskId: string): Promise<RunRecord> {
  const task = run.execution.tasks[taskId];
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (task.status !== "running" && task.status !== "waiting") {
    throw new Error(`Task ${taskId} cannot be terminated from status ${task.status}.`);
  }
  const controller = activeExecutionControllers.get(run.runId);
  if (!controller || !isExecutionLive(run)) {
    throw new Error(`Run ${run.runId} does not have a live execution to terminate.`);
  }
  controller.abort({
    type: "task-terminated",
    runId: run.runId,
    taskId,
    message: `Task ${taskId} terminated by operator.`,
  } satisfies TerminateTaskReason);
  await appendRunEvent(run.repoPath, run.runId, {
    timestamp: new Date().toISOString(),
    type: "task_termination_requested",
    detail: `Operator requested termination for task ${taskId}.`,
  });
  return await readRunState(run.repoPath, run.runId);
}

export async function terminatePlannerStreaming(
  run: RunRecord,
  reason = PLANNER_INTERRUPTED_BY_OPERATOR,
): Promise<RunRecord> {
  if (!run.planner.isStreaming) {
    throw new Error(`Run ${run.runId} does not have a planner turn in progress.`);
  }
  const controller = activePlannerControllers.get(run.runId);
  const timestamp = new Date().toISOString();

  if (controller) {
    controller.abort(new Error(reason));
    await appendRunEvent(run.repoPath, run.runId, {
      timestamp,
      type: reason === PLANNER_INTERRUPTED_BY_DISCONNECT ? "planner_stream_disconnected" : "planner_termination_requested",
      detail: reason,
    });
    return await waitForPlannerStreamingToStop(run.repoPath, run.runId);
  }

  await updateRunState(run.repoPath, run.runId, {
    planner: {
      ...run.planner,
      isStreaming: false,
    },
  });
  await appendRunEvent(run.repoPath, run.runId, {
    timestamp,
    type: "planner_stream_cleared",
    detail: `${reason} Cleared stale planner streaming state without a live planner process.`,
  });
  return await readRunState(run.repoPath, run.runId);
}

async function reopenRunForPlanning(run: RunRecord, reason: string): Promise<RunRecord> {
  if (run.phase === "planning" && run.status === "active") {
    return run;
  }
  const next = await updateRunState(run.repoPath, run.runId, {
    phase: "planning",
    status: "active",
    runtime: {
      executionOwnerId: null,
      executionHeartbeatAt: null,
    },
  });
  await appendRunEvent(run.repoPath, run.runId, {
    timestamp: new Date().toISOString(),
    type: "planning_reopened",
    detail: reason,
  });
  return next;
}

async function refreshExecutionHeartbeat(repoPath: string, runId: string, ownerId: string): Promise<void> {
  const current = await readRunState(repoPath, runId);
  if (current.runtime.executionOwnerId !== ownerId) {
    return;
  }
  await updateRunState(repoPath, runId, {
    runtime: {
      executionOwnerId: ownerId,
      executionHeartbeatAt: new Date().toISOString(),
    },
  });
}

function validateDraft(draft: PlanDraft | null): string[] {
  if (!draft) {
    return ["No plan draft yet."];
  }

  const missing: string[] = [];
  if (draft.tasks.length === 0) {
    missing.push("At least one task is required.");
  }

  const taskIds = new Set<string>();
  for (const task of draft.tasks) {
    if (typeof task.id !== "string" || !task.id.trim()) {
      missing.push("Task id is required.");
    }
    if (typeof task.id === "string" && taskIds.has(task.id)) {
      missing.push(`Task id must be unique: ${task.id}`);
    }
    if (typeof task.id === "string") {
      taskIds.add(task.id);
    }
    if (typeof task.title !== "string" || !task.title.trim()) {
      missing.push(`Task ${task.id} title is required.`);
    }
    if (typeof task.workerPrompt !== "string" || !task.workerPrompt.trim()) {
      missing.push(`Task ${task.id} worker prompt is required.`);
    }
    if (!Number.isFinite(task.waitPolicy.minMs) || !Number.isFinite(task.waitPolicy.maxMs)) {
      missing.push(`Task ${task.id} wait range is required.`);
    } else if (task.waitPolicy.minMs > task.waitPolicy.maxMs) {
      missing.push(`Task ${task.id} wait range is invalid.`);
    }
  }

  for (const task of draft.tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        missing.push(`Task ${task.id} depends on missing task ${dependency}.`);
      }
    }
  }

  return missing;
}

function evaluatePlannerReadiness(draft: PlanDraft | null, planComplete: boolean): { canExecute: boolean; missingFields: string[] } {
  const missingFields = validateDraft(draft);
  if (draft && missingFields.length === 0 && !planComplete) {
    missingFields.push("Planner has not marked the plan complete yet.");
  }
  return {
    canExecute: missingFields.length === 0,
    missingFields,
  };
}

function deriveDraftSummary(
  source: NonNullable<Awaited<ReturnType<typeof runPlannerTurn>>["envelope"]["plan_update"]>,
  assistantResponse: string,
): string {
  if (typeof source.summary === "string" && source.summary.trim()) {
    return source.summary;
  }
  const titles = source.tasks
    .map((task) => (typeof task.title === "string" ? task.title.trim() : ""))
    .filter((title) => title.length > 0);
  if (titles.length === 0) {
    return assistantResponse.trim();
  }
  if (titles.length === 1) {
    return titles[0];
  }
  return `${titles[0]} (+${titles.length - 1} more tasks)`;
}

function convertDraft(
  version: number,
  source: NonNullable<Awaited<ReturnType<typeof runPlannerTurn>>["envelope"]["plan_update"]>,
  assistantResponse: string,
): PlanDraft {
  return {
    version,
    summary: deriveDraftSummary(source, assistantResponse),
    tasks: source.tasks.map((task) => ({
      id: typeof task.id === "string" ? task.id : "",
      title: typeof task.title === "string" ? task.title : "",
      dependsOn: Array.isArray(task.depends_on)
        ? task.depends_on.filter((dependency): dependency is string => typeof dependency === "string")
        : [],
      workerPrompt: typeof task.worker_prompt === "string" ? task.worker_prompt : "",
      taskMode: task.task_mode ?? "default",
      waitPolicy: {
        minMs: Number.isFinite(task.wait_range_ms?.min) ? task.wait_range_ms.min : Number.NaN,
        maxMs: Number.isFinite(task.wait_range_ms?.max) ? task.wait_range_ms.max : Number.NaN,
      },
    })),
  };
}

function buildInitialExecutionState(tasks: PlanTask[]): ExecutionState {
  const state: ExecutionState = {
    taskOrder: tasks.map((task) => task.id),
    tasks: {},
  };

  for (const task of tasks) {
    state.tasks[task.id] = {
      taskId: task.id,
      title: task.title,
      taskMode: task.taskMode,
      status: "pending",
      checkIteration: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  return state;
}

function buildResumableExecutionState(tasks: PlanTask[], previous: ExecutionState | null): ExecutionState {
  const next = buildInitialExecutionState(tasks);
  if (!previous) {
    return next;
  }

  for (const task of tasks) {
    const previousTask = previous.tasks[task.id];
    if (!previousTask) {
      continue;
    }
    if (previousTask.status === "completed") {
      next.tasks[task.id] = {
        ...next.tasks[task.id],
        ...previousTask,
        status: "completed",
        currentAction: previousTask.currentAction || "completed",
      };
      continue;
    }
    next.tasks[task.id] = {
      ...next.tasks[task.id],
      ...previousTask,
      status: "pending",
      currentAction: previousTask.status === "running"
        ? "interrupted before completion"
        : previousTask.status === "waiting" && task.taskMode === "long-running"
          ? "interrupted before next scheduled check"
          : previousTask.status === "waiting"
            ? "interrupted before completion"
        : previousTask.currentAction,
      waitUntil: undefined,
    };
  }

  return next;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", abortListener);
      }
      resolve();
    }, ms);
    if (!signal) {
      return;
    }
    const abortListener = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortListener);
      reject(toExecutionAbortError(signal.reason));
    };
    if (signal.aborted) {
      abortListener();
      return;
    }
    signal.addEventListener("abort", abortListener, { once: true });
  });
}

async function waitForPlannerStreamingToStop(repoPath: string, runId: string, timeoutMs = 2_000): Promise<RunRecord> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const current = await readRunState(repoPath, runId);
    if (!current.planner.isStreaming && !activePlannerControllers.has(runId)) {
      return current;
    }
    await sleep(25);
  }
  return await readRunState(repoPath, runId);
}

async function setPlannerStreamingState(run: RunRecord, isStreaming: boolean): Promise<void> {
  const current = await readRunState(run.repoPath, run.runId);
  await updateRunState(run.repoPath, run.runId, {
    planner: {
      ...current.planner,
      isStreaming,
    },
  });
}

async function refreshRunContext(
  repoPath: string,
  runId: string,
  overrides?: {
    turns?: PlannerTurnRecord[];
    draft?: PlanDraft | null;
    plannerPrompt?: RunRecord["context"]["plannerPrompt"];
  },
): Promise<RunRecord> {
  const current = await readRunState(repoPath, runId);
  const turns = overrides?.turns ?? await listPlannerTurns(repoPath, runId);
  const draft = overrides?.draft !== undefined ? overrides.draft : await readActiveDraft(repoPath, runId);
  const context = buildRunContextState(current, turns, draft, overrides?.plannerPrompt ?? current.context.plannerPrompt);
  return await updateRunState(repoPath, runId, { context });
}

export async function submitPlannerMessage(run: RunRecord, userMessage: string): Promise<RunRecord> {
  const currentRun = isExecutionLive(run)
    ? run
    : await reopenRunForPlanning(run, "Planner resumed after previous execution state ended.");
  const turns = await listPlannerTurns(run.repoPath, run.runId);
  await setPlannerStreamingState(currentRun, true);

  try {
    const { envelope, worker, context: plannerContext, sessionId } = await runPlannerTurn(currentRun, turns, userMessage);
    const runTitle = currentRun.title ?? (turns.length === 0 ? summarizeRunTitle(userMessage) : null);

    let draftVersion = currentRun.planner.activeDraftVersion ?? 0;
    let activeDraft = await readActiveDraft(currentRun.repoPath, currentRun.runId);

    if (envelope.plan_update) {
      draftVersion += 1;
      activeDraft = convertDraft(draftVersion, envelope.plan_update, envelope.assistant_response);
      await writeDraft(currentRun.repoPath, currentRun.runId, activeDraft);
    }

    const planComplete = isExecutionLive(currentRun)
      ? false
      : envelope.plan_update
        ? envelope.plan_complete
        : (envelope.plan_complete || currentRun.planner.planComplete);
    const readiness = evaluatePlannerReadiness(activeDraft, planComplete);
    const timestamp = new Date().toISOString();

    const turn: PlannerTurnRecord = {
      turnId: crypto.randomUUID(),
      timestamp,
      userMessage,
      assistantMessage: envelope.assistant_response,
      planUpdated: envelope.plan_update !== null,
      draftVersion: envelope.plan_update ? draftVersion : undefined,
      worker,
    };
    await appendPlannerTurn(currentRun.repoPath, currentRun.runId, turn);

    await updateRunState(currentRun.repoPath, currentRun.runId, {
      title: runTitle,
      planner: {
        turnCount: turns.length + 1,
        activeDraftVersion: activeDraft?.version ?? null,
        latestAssistantMessage: envelope.assistant_response,
        sessionId: sessionId ?? currentRun.planner.sessionId,
        planComplete,
        canExecute: readiness.canExecute,
        missingFields: readiness.missingFields,
        isStreaming: false,
      },
    });
    const next = await refreshRunContext(currentRun.repoPath, currentRun.runId, {
      turns: [...turns, turn],
      draft: activeDraft,
      plannerPrompt: plannerContext.plannerPrompt,
    });

    await appendRunEvent(currentRun.repoPath, currentRun.runId, {
      timestamp,
      type: "planner_turn",
      detail: envelope.plan_update
        ? `Planner updated draft v${draftVersion}.`
        : "Planner replied without changing the plan.",
    });

    return next;
  } finally {
    await setPlannerStreamingState(currentRun, false);
  }
}

export async function submitPlannerMessageWithEvents(
  run: RunRecord,
  userMessage: string,
  onEvent: (event: { type: string; payload: unknown }) => void,
): Promise<RunRecord> {
  const currentRun = isExecutionLive(run)
    ? run
    : await reopenRunForPlanning(run, "Planner resumed after previous execution state ended.");
  const turns = await listPlannerTurns(run.repoPath, run.runId);
  if (activePlannerControllers.has(currentRun.runId)) {
    throw new Error(`Planner is already running for run ${currentRun.runId}.`);
  }
  const plannerController = new AbortController();
  activePlannerControllers.set(currentRun.runId, plannerController);
  await setPlannerStreamingState(currentRun, true);
  onEvent({ type: "planner_started", payload: { message: "Planner started." } });

  try {
    const { envelope, worker, context: plannerContext, sessionId } = await runPlannerTurn(
      currentRun,
      turns,
      userMessage,
      plannerController.signal,
      (jsonEvent) => {
        onEvent({ type: "planner_event", payload: jsonEvent });
      },
    );
    const runTitle = currentRun.title ?? (turns.length === 0 ? summarizeRunTitle(userMessage) : null);

    let draftVersion = currentRun.planner.activeDraftVersion ?? 0;
    let activeDraft = await readActiveDraft(currentRun.repoPath, currentRun.runId);

    if (envelope.plan_update) {
      draftVersion += 1;
      activeDraft = convertDraft(draftVersion, envelope.plan_update, envelope.assistant_response);
      await writeDraft(currentRun.repoPath, currentRun.runId, activeDraft);
      onEvent({ type: "planner_draft_updated", payload: activeDraft });
    }

    const planComplete = isExecutionLive(currentRun)
      ? false
      : envelope.plan_update
        ? envelope.plan_complete
        : (envelope.plan_complete || currentRun.planner.planComplete);
    const readiness = evaluatePlannerReadiness(activeDraft, planComplete);
    const timestamp = new Date().toISOString();

    const turn: PlannerTurnRecord = {
      turnId: crypto.randomUUID(),
      timestamp,
      userMessage,
      assistantMessage: envelope.assistant_response,
      planUpdated: envelope.plan_update !== null,
      draftVersion: envelope.plan_update ? draftVersion : undefined,
      worker,
    };
    await appendPlannerTurn(currentRun.repoPath, currentRun.runId, turn);

    await updateRunState(currentRun.repoPath, currentRun.runId, {
      title: runTitle,
      planner: {
        turnCount: turns.length + 1,
        activeDraftVersion: activeDraft?.version ?? null,
        latestAssistantMessage: envelope.assistant_response,
        sessionId: sessionId ?? currentRun.planner.sessionId,
        planComplete,
        canExecute: readiness.canExecute,
        missingFields: readiness.missingFields,
        isStreaming: false,
      },
    });
    const next = await refreshRunContext(currentRun.repoPath, currentRun.runId, {
      turns: [...turns, turn],
      draft: activeDraft,
      plannerPrompt: plannerContext.plannerPrompt,
    });

    await appendRunEvent(currentRun.repoPath, currentRun.runId, {
      timestamp,
      type: "planner_turn",
      detail: envelope.plan_update
        ? `Planner updated draft v${draftVersion}.`
        : "Planner replied without changing the plan.",
    });

    onEvent({
      type: "planner_completed",
      payload: {
        assistantMessage: envelope.assistant_response,
        planComplete,
        canExecute: readiness.canExecute,
        missingFields: readiness.missingFields,
        worker,
      },
    });

    return next;
  } finally {
    activePlannerControllers.delete(currentRun.runId);
    await setPlannerStreamingState(currentRun, false);
  }
}

export async function maintainCompressedContext(run: RunRecord): Promise<RunRecord> {
  const currentRun = await readRunState(run.repoPath, run.runId);
  const turns = await listPlannerTurns(run.repoPath, run.runId);
  const { maintainedSummary, worker } = await runContextMaintenanceWorker(currentRun, turns);
  const next = await updateRunState(run.repoPath, run.runId, {
    context: {
      ...currentRun.context,
      maintainedSummary,
      maintainedAt: new Date().toISOString(),
      maintainedByModel: worker.model,
    },
  });
  await appendRunEvent(run.repoPath, run.runId, {
    timestamp: new Date().toISOString(),
    type: "context_maintained",
    detail: `Maintained compressed context with ${worker.model}.`,
  });
  return await refreshRunContext(run.repoPath, run.runId);
}

function getLongRunningCheckIntervalMs(run: RunRecord, task: PlanTask): number {
  const interval = run.settings.checkIntervalMs;
  if (interval < task.waitPolicy.minMs || interval > task.waitPolicy.maxMs) {
    throw new Error(
      `Task ${task.id} requires check interval inside ${task.waitPolicy.minMs}-${task.waitPolicy.maxMs} ms, got ${interval}.`,
    );
  }
  return interval;
}

async function waitForScheduledCheck(
  run: RunRecord,
  task: PlanTask,
  execution: ExecutionState,
  taskState: TaskExecutionRecord,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!taskState.nextCheckAt) {
    return;
  }
  const nextCheckAt = Date.parse(taskState.nextCheckAt);
  if (Number.isNaN(nextCheckAt)) {
    return;
  }
  const remainingMs = nextCheckAt - Date.now();
  if (remainingMs <= 0) {
    return;
  }
  execution.tasks[task.id] = {
    ...taskState,
    status: "waiting",
    currentAction: "waiting for resumed scheduled check",
    waitUntil: new Date(nextCheckAt).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await updateRunState(run.repoPath, run.runId, {
    execution,
    phase: "waiting",
  });
  await appendRunEvent(run.repoPath, run.runId, {
    timestamp: new Date().toISOString(),
    type: "task_check_wait_resumed",
    detail: `Task ${task.id} resumed waiting ${remainingMs} ms until its next scheduled check.`,
  });
  await sleep(remainingMs, signal);
}

async function executeDefaultTask(run: RunRecord, task: PlanTask, execution: ExecutionState, signal: AbortSignal): Promise<ExecutionState> {
  throwIfAborted(signal);
  execution.tasks[task.id] = {
    ...execution.tasks[task.id],
    status: "running",
    model: run.settings.taskWorkerModel,
    currentAction: "calling worker",
    startedAt: execution.tasks[task.id].startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await updateRunState(run.repoPath, run.runId, { execution });

  const workerRun = await readRunState(run.repoPath, run.runId);
  const { response, sessionId, contextPatch } = await runTaskWorker(workerRun, task, execution.tasks[task.id], signal);

  if (response.should_wait) {
    if (response.wait_ms < task.waitPolicy.minMs || response.wait_ms > task.waitPolicy.maxMs) {
      throw new Error(`Task ${task.id} requested wait ${response.wait_ms} outside range ${task.waitPolicy.minMs}-${task.waitPolicy.maxMs}.`);
    }
    execution.tasks[task.id] = {
      ...execution.tasks[task.id],
      status: "waiting",
      currentAction: "waiting",
      waitDecisionMs: response.wait_ms,
      waitStartedAt: new Date().toISOString(),
      waitUntil: new Date(Date.now() + response.wait_ms).toISOString(),
      sessionId,
      summary: response.summary,
      checkpointSummary: contextPatch.checkpointSummary,
      wakeDeltaSummary: contextPatch.wakeDeltaSummary,
      lastWakeEventCount: contextPatch.lastWakeEventCount,
      lastWakeNoteCount: contextPatch.lastWakeNoteCount,
      updatedAt: new Date().toISOString(),
    };
    await updateRunState(run.repoPath, run.runId, { execution, phase: "waiting" });
    await refreshRunContext(run.repoPath, run.runId);
    await appendRunEvent(run.repoPath, run.runId, {
      timestamp: new Date().toISOString(),
      type: "task_wait_started",
      detail: `Task ${task.id} waiting ${response.wait_ms} ms.`,
    });
    await sleep(response.wait_ms, signal);
    await appendRunEvent(run.repoPath, run.runId, {
      timestamp: new Date().toISOString(),
      type: "task_wait_finished",
      detail: `Task ${task.id} finished waiting after ${response.wait_ms} ms.`,
    });
  }

  if (!response.completed) {
    throw new Error(`Task ${task.id} did not complete.`);
  }

  execution.tasks[task.id] = {
    ...execution.tasks[task.id],
    status: "completed",
    currentAction: "completed",
    waitDecisionMs: response.wait_ms,
    sessionId,
    summary: response.summary,
    checkpointSummary: contextPatch.checkpointSummary,
    wakeDeltaSummary: contextPatch.wakeDeltaSummary,
    lastWakeEventCount: contextPatch.lastWakeEventCount,
    lastWakeNoteCount: contextPatch.lastWakeNoteCount,
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  await updateRunState(run.repoPath, run.runId, { execution, phase: "executing" });
  await appendRunNote(run.repoPath, run.runId, `Task ${task.id} completed: ${response.summary}`);
  await refreshRunContext(run.repoPath, run.runId);
  return execution;
}

async function executeLongRunningTask(run: RunRecord, task: PlanTask, execution: ExecutionState, signal: AbortSignal): Promise<ExecutionState> {
  throwIfAborted(signal);
  const checkIntervalMs = getLongRunningCheckIntervalMs(run, task);
  const originalState = execution.tasks[task.id];

  if (originalState.nextCheckAt) {
    await waitForScheduledCheck(run, task, execution, originalState, signal);
  }

  while (true) {
    throwIfAborted(signal);
    const currentTaskState = execution.tasks[task.id];
    execution.tasks[task.id] = {
      ...currentTaskState,
      taskMode: task.taskMode,
      status: "running",
      model: run.settings.taskWorkerModel,
      currentAction: currentTaskState.checkIteration ? "checking long-running task progress" : "starting long-running task",
      startedAt: currentTaskState.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await updateRunState(run.repoPath, run.runId, { execution, phase: "executing" });
    await appendRunEvent(run.repoPath, run.runId, {
      timestamp: new Date().toISOString(),
      type: "task_check_started",
      detail: `Task ${task.id} check iteration ${execution.tasks[task.id].checkIteration ?? 0} started.`,
    });

    const workerRun = await readRunState(run.repoPath, run.runId);
    const { response, sessionId, contextPatch } = await runTaskWorker(workerRun, task, execution.tasks[task.id], signal);
    const checkedAt = new Date().toISOString();

    if (response.completed) {
      execution.tasks[task.id] = {
        ...execution.tasks[task.id],
        status: "completed",
        currentAction: "completed",
        waitDecisionMs: checkIntervalMs,
        checkIntervalMs,
        lastCheckAt: checkedAt,
        sessionId,
        summary: response.summary,
        checkpointSummary: contextPatch.checkpointSummary,
        wakeDeltaSummary: contextPatch.wakeDeltaSummary,
        lastWakeEventCount: contextPatch.lastWakeEventCount,
        lastWakeNoteCount: contextPatch.lastWakeNoteCount,
        updatedAt: checkedAt,
        completedAt: checkedAt,
        nextCheckAt: undefined,
        waitUntil: undefined,
      };
      await updateRunState(run.repoPath, run.runId, { execution, phase: "executing" });
      await appendRunNote(run.repoPath, run.runId, `Task ${task.id} completed: ${response.summary}`);
      await refreshRunContext(run.repoPath, run.runId);
      return execution;
    }

    if (!response.should_wait) {
      throw new Error(`Task ${task.id} did not complete and did not request another scheduled check.`);
    }

    const nextCheckAt = new Date(Date.now() + checkIntervalMs).toISOString();
    const nextIteration = (execution.tasks[task.id].checkIteration ?? 0) + 1;
    execution.tasks[task.id] = {
      ...execution.tasks[task.id],
      status: "waiting",
      currentAction: "waiting for next scheduled check",
      waitDecisionMs: checkIntervalMs,
      waitStartedAt: checkedAt,
      waitUntil: nextCheckAt,
      checkIntervalMs,
      checkIteration: nextIteration,
      lastCheckAt: checkedAt,
      nextCheckAt,
      sessionId,
      summary: response.summary,
      checkpointSummary: contextPatch.checkpointSummary,
      wakeDeltaSummary: contextPatch.wakeDeltaSummary,
      lastWakeEventCount: contextPatch.lastWakeEventCount,
      lastWakeNoteCount: contextPatch.lastWakeNoteCount,
      updatedAt: checkedAt,
    };
    await updateRunState(run.repoPath, run.runId, { execution, phase: "waiting" });
    await refreshRunContext(run.repoPath, run.runId);
    await appendRunEvent(run.repoPath, run.runId, {
      timestamp: checkedAt,
      type: "task_check_scheduled",
      detail: `Task ${task.id} scheduled check iteration ${nextIteration} in ${checkIntervalMs} ms.`,
    });
    await sleep(checkIntervalMs, signal);
  }
}

async function executeTask(run: RunRecord, task: PlanTask, execution: ExecutionState, signal: AbortSignal): Promise<ExecutionState> {
  if (task.taskMode === "long-running") {
    return executeLongRunningTask(run, task, execution, signal);
  }
  return executeDefaultTask(run, task, execution, signal);
}

export async function executeFrozenPlan(run: RunRecord): Promise<RunRecord> {
  const plan = await readExecutionPlan(run.repoPath, run.runId);
  const executionOwnerId = crypto.randomUUID();
  const executionController = new AbortController();
  activeExecutionControllers.set(run.runId, executionController);
  const previousExecution = run.execution.taskOrder.length > 0 ? run.execution : null;
  const resumedExecution = buildResumableExecutionState(plan.tasks, previousExecution);
  const resumedTaskIds = Object.values(resumedExecution.tasks)
    .filter((task) => task.status === "completed")
    .map((task) => task.taskId);
  await updateRunState(run.repoPath, run.runId, {
    phase: "executing",
    status: "active",
    execution: resumedExecution,
    runtime: {
      executionOwnerId,
      executionHeartbeatAt: new Date().toISOString(),
    },
  });
  await refreshRunContext(run.repoPath, run.runId);
  await appendRunEvent(run.repoPath, run.runId, {
    timestamp: new Date().toISOString(),
    type: "status_changed",
    detail: resumedTaskIds.length > 0
      ? `Execution resumed from frozen plan. Skipping completed tasks: ${resumedTaskIds.join(", ")}.`
      : "Execution started from frozen plan.",
  });

  const heartbeatTimer = setInterval(() => {
    void refreshExecutionHeartbeat(run.repoPath, run.runId, executionOwnerId);
  }, EXECUTION_HEARTBEAT_INTERVAL_MS);

  let execution = resumedExecution;
  let current = await readRunState(run.repoPath, run.runId);

  try {
    const completed = new Set<string>(
      Object.values(execution.tasks)
        .filter((task) => task.status === "completed")
        .map((task) => task.taskId),
    );
    const started = new Set<string>();
    const runningTasks = new Map<string, Promise<
      | { ok: true; taskId: string; execution: ExecutionState }
      | { ok: false; taskId: string; error: unknown }
    >>();
    const concurrency = Math.max(1, run.settings.maxAgentCount);

    while (completed.size < plan.tasks.length) {
      throwIfAborted(executionController.signal);
      const readyTasks = plan.tasks.filter((task) => {
        if (completed.has(task.id) || started.has(task.id)) {
          return false;
        }
        return task.dependsOn.every((dependency) => completed.has(dependency));
      });

      while (runningTasks.size < concurrency && readyTasks.length > 0) {
        const task = readyTasks.shift();
        if (!task) {
          break;
        }
        started.add(task.id);
        const executionRef = execution;
        const promise = executeTask(current, task, executionRef, executionController.signal)
          .then((nextExecution) => ({
            ok: true as const,
            taskId: task.id,
            execution: nextExecution,
          }))
          .catch((error) => ({
            ok: false as const,
            taskId: task.id,
            error,
          }));
        runningTasks.set(task.id, promise);
      }

      if (runningTasks.size === 0) {
        throw new Error("No executable task found. Check task dependencies.");
      }

      const result = await Promise.race(
        [...runningTasks.values()].map((promise) => promise.then((value) => value)),
      );
      if (!result.ok) {
        throw result.error;
      }
      runningTasks.delete(result.taskId);
      completed.add(result.taskId);
      execution = result.execution;
      current = await readRunState(run.repoPath, run.runId);
    }

    await setRunStatus(run.repoPath, run.runId, "completed", "done", "Run completed successfully.");
    await updateRunState(run.repoPath, run.runId, {
      runtime: {
        executionOwnerId: null,
        executionHeartbeatAt: null,
      },
    });
    return await refreshRunContext(run.repoPath, run.runId);
  } catch (error) {
    if (isTerminateTaskReason(executionController.signal.reason)) {
      const reason = executionController.signal.reason;
      const now = new Date().toISOString();
      for (const taskState of Object.values(execution.tasks)) {
        if (taskState.status === "running" || taskState.status === "waiting") {
          const isTargetTask = taskState.taskId === reason.taskId;
          execution.tasks[taskState.taskId] = {
            ...taskState,
            status: "failed",
            currentAction: isTargetTask ? "terminated by operator" : `stopped after ${reason.taskId} was terminated`,
            summary: isTargetTask ? reason.message : `Execution stopped after ${reason.taskId} was terminated by operator.`,
            updatedAt: now,
            waitUntil: undefined,
            nextCheckAt: undefined,
          };
        }
      }
      await updateRunState(run.repoPath, run.runId, {
        phase: "failed",
        status: "error",
        execution,
      });
      await refreshRunContext(run.repoPath, run.runId);
      await appendRunEvent(run.repoPath, run.runId, {
        timestamp: now,
        type: "task_terminated",
        detail: reason.message,
      });
      await appendRunNote(run.repoPath, run.runId, reason.message);
    }
    throw error;
  } finally {
    activeExecutionControllers.delete(run.runId);
    clearInterval(heartbeatTimer);
  }
}

export async function freezeCurrentDraft(run: RunRecord): Promise<RunRecord> {
  const currentRun = await readRunState(run.repoPath, run.runId);
  const draft = await readActiveDraft(run.repoPath, run.runId);
  const readiness = evaluatePlannerReadiness(draft, currentRun.planner.planComplete);
  const missingFields = readiness.missingFields;
  if (!draft || missingFields.length > 0) {
    throw new Error(`Draft cannot execute: ${missingFields.join(" ")}`);
  }
  await freezeExecutionPlan(run.repoPath, run.runId, draft);
  const execution = buildInitialExecutionState(draft.tasks);
  const next = await updateRunState(run.repoPath, run.runId, {
    phase: "awaiting_execute_confirmation",
      planner: {
        ...currentRun.planner,
        canExecute: true,
        missingFields: [],
      isStreaming: false,
    },
    execution,
  });
  const refreshed = await refreshRunContext(run.repoPath, run.runId, { draft });
  await appendRunEvent(run.repoPath, run.runId, {
    timestamp: new Date().toISOString(),
    type: "execution_plan_frozen",
    detail: `Frozen execution plan from draft v${draft.version}.`,
  });
  return refreshed;
}
