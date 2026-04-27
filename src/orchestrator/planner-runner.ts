import crypto from "node:crypto";

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
import { runPlannerTurn, runTaskWorker } from "./codex-worker.js";
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
  if (!draft.summary.trim()) {
    missing.push("Plan summary is required.");
  }
  if (draft.tasks.length === 0) {
    missing.push("At least one task is required.");
  }

  const taskIds = new Set<string>();
  for (const task of draft.tasks) {
    if (!task.id.trim()) {
      missing.push("Task id is required.");
    }
    if (taskIds.has(task.id)) {
      missing.push(`Task id must be unique: ${task.id}`);
    }
    taskIds.add(task.id);
    if (!task.title.trim()) {
      missing.push(`Task ${task.id} title is required.`);
    }
    if (!task.workerPrompt.trim()) {
      missing.push(`Task ${task.id} worker prompt is required.`);
    }
    if (task.waitPolicy.minMs > task.waitPolicy.maxMs) {
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

function convertDraft(version: number, source: NonNullable<Awaited<ReturnType<typeof runPlannerTurn>>["envelope"]["plan_update"]>): PlanDraft {
  return {
    version,
    summary: source.summary,
    tasks: source.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      dependsOn: task.depends_on,
      workerPrompt: task.worker_prompt,
      taskMode: task.task_mode ?? "default",
      waitPolicy: {
        minMs: task.wait_range_ms.min,
        maxMs: task.wait_range_ms.max,
      },
    })),
  };
}

function formatConversation(turns: PlannerTurnRecord[], userMessage: string): string {
  const lines: string[] = [];
  for (const turn of turns) {
    lines.push(`user: ${turn.userMessage}`);
    lines.push(`assistant: ${turn.assistantMessage}`);
  }
  lines.push(`user: ${userMessage}`);
  return lines.join("\n");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

export async function submitPlannerMessage(run: RunRecord, userMessage: string): Promise<RunRecord> {
  const currentRun = isExecutionLive(run)
    ? run
    : await reopenRunForPlanning(run, "Planner resumed after previous execution state ended.");
  const turns = await listPlannerTurns(run.repoPath, run.runId);
  const conversationText = formatConversation(turns, userMessage);
  await setPlannerStreamingState(currentRun, true);

  try {
    const { envelope, worker } = await runPlannerTurn(currentRun, conversationText);
    const runTitle = currentRun.title ?? (turns.length === 0 ? summarizeRunTitle(userMessage) : null);

    let draftVersion = currentRun.planner.activeDraftVersion ?? 0;
    let activeDraft = await readActiveDraft(currentRun.repoPath, currentRun.runId);

    if (envelope.plan_update) {
      draftVersion += 1;
      activeDraft = convertDraft(draftVersion, envelope.plan_update);
      await writeDraft(currentRun.repoPath, currentRun.runId, activeDraft);
    }

    const missingFields = validateDraft(activeDraft);
    const canExecute = missingFields.length === 0;
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

    const next = await updateRunState(currentRun.repoPath, currentRun.runId, {
      title: runTitle,
      planner: {
        turnCount: turns.length + 1,
        activeDraftVersion: activeDraft?.version ?? null,
        latestAssistantMessage: envelope.assistant_response,
        canExecute,
        missingFields,
        isStreaming: false,
      },
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
  const conversationText = formatConversation(turns, userMessage);
  await setPlannerStreamingState(currentRun, true);
  onEvent({ type: "planner_started", payload: { message: "Planner started." } });

  try {
    const { envelope, worker } = await runPlannerTurn(currentRun, conversationText, (jsonEvent) => {
      onEvent({ type: "planner_event", payload: jsonEvent });
    });
    const runTitle = currentRun.title ?? (turns.length === 0 ? summarizeRunTitle(userMessage) : null);

    let draftVersion = currentRun.planner.activeDraftVersion ?? 0;
    let activeDraft = await readActiveDraft(currentRun.repoPath, currentRun.runId);

    if (envelope.plan_update) {
      draftVersion += 1;
      activeDraft = convertDraft(draftVersion, envelope.plan_update);
      await writeDraft(currentRun.repoPath, currentRun.runId, activeDraft);
      onEvent({ type: "planner_draft_updated", payload: activeDraft });
    }

    const missingFields = validateDraft(activeDraft);
    const canExecute = missingFields.length === 0;
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

    const next = await updateRunState(currentRun.repoPath, currentRun.runId, {
      title: runTitle,
      planner: {
        turnCount: turns.length + 1,
        activeDraftVersion: activeDraft?.version ?? null,
        latestAssistantMessage: envelope.assistant_response,
        canExecute,
        missingFields,
        isStreaming: false,
      },
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
        canExecute,
        missingFields,
        worker,
      },
    });

    return next;
  } finally {
    await setPlannerStreamingState(currentRun, false);
  }
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
): Promise<void> {
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
  await sleep(remainingMs);
}

async function executeDefaultTask(run: RunRecord, task: PlanTask, execution: ExecutionState): Promise<ExecutionState> {
  execution.tasks[task.id] = {
    ...execution.tasks[task.id],
    status: "running",
    model: run.settings.taskWorkerModel,
    currentAction: "calling worker",
    startedAt: execution.tasks[task.id].startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await updateRunState(run.repoPath, run.runId, { execution });

  const { response } = await runTaskWorker(run, task, execution.tasks[task.id]);

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
      summary: response.summary,
      updatedAt: new Date().toISOString(),
    };
    await updateRunState(run.repoPath, run.runId, { execution, phase: "waiting" });
    await appendRunEvent(run.repoPath, run.runId, {
      timestamp: new Date().toISOString(),
      type: "task_wait_started",
      detail: `Task ${task.id} waiting ${response.wait_ms} ms.`,
    });
    await sleep(response.wait_ms);
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
    summary: response.summary,
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  await updateRunState(run.repoPath, run.runId, { execution, phase: "executing" });
  await appendRunNote(run.repoPath, run.runId, `Task ${task.id} completed: ${response.summary}`);
  return execution;
}

async function executeLongRunningTask(run: RunRecord, task: PlanTask, execution: ExecutionState): Promise<ExecutionState> {
  const checkIntervalMs = getLongRunningCheckIntervalMs(run, task);
  const originalState = execution.tasks[task.id];

  if (originalState.nextCheckAt) {
    await waitForScheduledCheck(run, task, execution, originalState);
  }

  while (true) {
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

    const { response } = await runTaskWorker(run, task, execution.tasks[task.id]);
    const checkedAt = new Date().toISOString();

    if (response.completed) {
      execution.tasks[task.id] = {
        ...execution.tasks[task.id],
        status: "completed",
        currentAction: "completed",
        waitDecisionMs: checkIntervalMs,
        checkIntervalMs,
        lastCheckAt: checkedAt,
        summary: response.summary,
        updatedAt: checkedAt,
        completedAt: checkedAt,
        nextCheckAt: undefined,
        waitUntil: undefined,
      };
      await updateRunState(run.repoPath, run.runId, { execution, phase: "executing" });
      await appendRunNote(run.repoPath, run.runId, `Task ${task.id} completed: ${response.summary}`);
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
      summary: response.summary,
      updatedAt: checkedAt,
    };
    await updateRunState(run.repoPath, run.runId, { execution, phase: "waiting" });
    await appendRunEvent(run.repoPath, run.runId, {
      timestamp: checkedAt,
      type: "task_check_scheduled",
      detail: `Task ${task.id} scheduled check iteration ${nextIteration} in ${checkIntervalMs} ms.`,
    });
    await sleep(checkIntervalMs);
  }
}

async function executeTask(run: RunRecord, task: PlanTask, execution: ExecutionState): Promise<ExecutionState> {
  if (task.taskMode === "long-running") {
    return executeLongRunningTask(run, task, execution);
  }
  return executeDefaultTask(run, task, execution);
}

export async function executeFrozenPlan(run: RunRecord): Promise<RunRecord> {
  const plan = await readExecutionPlan(run.repoPath, run.runId);
  const executionOwnerId = crypto.randomUUID();
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

  try {
    let execution = resumedExecution;
    let current = await readRunState(run.repoPath, run.runId);

    const completed = new Set<string>(
      Object.values(execution.tasks)
        .filter((task) => task.status === "completed")
        .map((task) => task.taskId),
    );
    const started = new Set<string>();
    const runningTasks = new Map<string, Promise<{ taskId: string; execution: ExecutionState }>>();
    const concurrency = Math.max(1, run.settings.maxAgentCount);

    while (completed.size < plan.tasks.length) {
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
        const promise = executeTask(current, task, executionRef).then((nextExecution) => ({
          taskId: task.id,
          execution: nextExecution,
        }));
        runningTasks.set(task.id, promise);
      }

      if (runningTasks.size === 0) {
        throw new Error("No executable task found. Check task dependencies.");
      }

      const result = await Promise.race(
        [...runningTasks.values()].map((promise) => promise.then((value) => value)),
      );
      runningTasks.delete(result.taskId);
      completed.add(result.taskId);
      execution = result.execution;
      current = await readRunState(run.repoPath, run.runId);
    }

    await setRunStatus(run.repoPath, run.runId, "completed", "done", "Run completed successfully.");
    return await updateRunState(run.repoPath, run.runId, {
      runtime: {
        executionOwnerId: null,
        executionHeartbeatAt: null,
      },
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function freezeCurrentDraft(run: RunRecord): Promise<RunRecord> {
  const draft = await readActiveDraft(run.repoPath, run.runId);
  const missingFields = validateDraft(draft);
  if (!draft || missingFields.length > 0) {
    throw new Error(`Draft cannot execute: ${missingFields.join(" ")}`);
  }
  await freezeExecutionPlan(run.repoPath, run.runId, draft);
  const execution = buildInitialExecutionState(draft.tasks);
  const next = await updateRunState(run.repoPath, run.runId, {
    phase: "awaiting_execute_confirmation",
    planner: {
      ...run.planner,
      canExecute: true,
      missingFields: [],
      isStreaming: false,
    },
    execution,
  });
  await appendRunEvent(run.repoPath, run.runId, {
    timestamp: new Date().toISOString(),
    type: "execution_plan_frozen",
    detail: `Frozen execution plan from draft v${draft.version}.`,
  });
  return next;
}
