import type {
  PlanDraft,
  PlanTask,
  PlannerTurnRecord,
  RunEvent,
  RunRecord,
  RunContextState,
  TaskExecutionRecord,
} from "./types.js";

const PLANNER_CONTEXT_SOFT_LIMIT_TOKENS = 6_000;
const PLANNER_COMPRESSION_TRIGGER_RATIO = 0.65;
const PLANNER_RECENT_TURN_LIMIT = 6;
const SUMMARY_ITEM_LIMIT = 6;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function clipText(value: string | null | undefined, maxLength: number): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function summarizeGoal(run: RunRecord, turns: PlannerTurnRecord[]): string | null {
  return clipText(run.title || turns[0]?.userMessage || null, 140);
}

function summarizePlan(draft: PlanDraft | null): string | null {
  if (!draft) {
    return null;
  }
  const taskLines = draft.tasks.slice(0, SUMMARY_ITEM_LIMIT).map((task) => {
    const dependencies = task.dependsOn.length ? task.dependsOn.join(",") : "-";
    return `${task.id}=${clipText(task.title, 48)} [${task.taskMode}] deps:${dependencies}`;
  });
  const extra = draft.tasks.length > SUMMARY_ITEM_LIMIT
    ? ` (+${draft.tasks.length - SUMMARY_ITEM_LIMIT} more)`
    : "";
  return `${clipText(draft.summary, 120)} Tasks: ${taskLines.join("; ")}${extra}`;
}

function summarizeExecution(run: RunRecord): string | null {
  const tasks = Object.values(run.execution.tasks);
  if (tasks.length === 0) {
    return "No execution has started.";
  }
  const counts = {
    pending: tasks.filter((task) => task.status === "pending").length,
    running: tasks.filter((task) => task.status === "running").length,
    waiting: tasks.filter((task) => task.status === "waiting").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
  };
  const activeTasks = tasks
    .filter((task) => task.status !== "completed" && task.status !== "pending")
    .slice(0, SUMMARY_ITEM_LIMIT)
    .map((task) => `${task.taskId}:${task.status}:${clipText(task.currentAction || task.summary || "-", 60)}`);
  const recentNotes = run.notes.slice(-3).map((note) => clipText(note, 80));
  return [
    `phase=${run.phase}, status=${run.status}`,
    `pending=${counts.pending}, running=${counts.running}, waiting=${counts.waiting}, completed=${counts.completed}, failed=${counts.failed}`,
    `active=${activeTasks.length ? activeTasks.join(" | ") : "-"}`,
    `recent_notes=${recentNotes.length ? recentNotes.join(" | ") : "-"}`,
  ].join("; ");
}

function summarizeConversation(turns: PlannerTurnRecord[]): string | null {
  if (turns.length === 0) {
    return null;
  }
  const selected = turns.slice(-SUMMARY_ITEM_LIMIT);
  return selected
    .map((turn) => `user=${clipText(turn.userMessage, 72)} | assistant=${clipText(turn.assistantMessage, 96)}`)
    .join("\n");
}

function formatTranscript(turns: PlannerTurnRecord[], userMessage: string): string {
  const lines: string[] = [];
  for (const turn of turns) {
    lines.push(`user: ${turn.userMessage}`);
    lines.push(`assistant: ${turn.assistantMessage}`);
  }
  lines.push(`user: ${userMessage}`);
  return lines.join("\n");
}

function formatRecentTurns(turns: PlannerTurnRecord[], userMessage: string): string {
  const lines: string[] = [];
  for (const turn of turns.slice(-PLANNER_RECENT_TURN_LIMIT)) {
    lines.push(`user: ${turn.userMessage}`);
    lines.push(`assistant: ${turn.assistantMessage}`);
  }
  lines.push(`user: ${userMessage}`);
  return lines.join("\n");
}

function buildPlannerHeader(run: RunRecord, projectInstructions: string | null, context: RunContextState): string[] {
  const taskLines = run.execution.taskOrder.slice(0, SUMMARY_ITEM_LIMIT).map((taskId) => {
    const task = run.execution.tasks[taskId];
    const waitUntil = task.waitUntil ? `, waitUntil=${task.waitUntil}` : "";
    const nextCheckAt = task.nextCheckAt ? `, nextCheckAt=${task.nextCheckAt}` : "";
    const iteration = task.checkIteration !== undefined ? `, checkIteration=${task.checkIteration}` : "";
    return `- ${task.taskId}: mode=${task.taskMode || "default"}, status=${task.status}, action=${task.currentAction || "-"}, summary=${clipText(task.summary || "-", 80)}${waitUntil}${nextCheckAt}${iteration}`;
  });
  const executionLive = Boolean(run.runtime.executionOwnerId && run.runtime.executionHeartbeatAt);
  return [
    "You are the planner model inside Codex Agent Orchestrator.",
    "Behave like a normal helpful Codex planner in tone.",
    "Respond to the user naturally in assistant_response.",
    executionLive
      ? "The main execution is currently active. Act as the main agent for this run: answer progress, blockers, next steps, and current task status."
      : "You can answer progress questions and also act as planner for this run.",
    executionLive
      ? "While execution is active, always set plan_update to null and do not attempt to revise the plan."
      : "Only set plan_update when the current plan materially changed.",
    "If nothing changed in the plan, set plan_update to null.",
    "When you emit plan_update, it must be a complete plan snapshot, not a partial diff.",
    "A valid task must include: id, title, depends_on, worker_prompt, wait_range_ms.min, wait_range_ms.max.",
    "You may optionally set task_mode to long-running when the task launches or supervises a long-running external job.",
    "wait_range_ms defines the allowed wait range.",
    "For long-running tasks, the run-level check interval controls how often the orchestrator wakes the model again and that interval must stay inside wait_range_ms.",
    "Keep the plan practical and executable.",
    "",
    `Run ID: ${run.runId}`,
    `Project path: ${run.repoPath}`,
    `Run phase: ${run.phase}`,
    `Run status: ${run.status}`,
    `Execution live: ${executionLive ? "yes" : "no"}`,
    `Configured check interval: ${run.settings.checkIntervalMs} ms`,
    `Goal checkpoint: ${context.goalSummary || "-"}`,
    `Plan checkpoint: ${context.planSummary || "-"}`,
    `Execution checkpoint: ${context.executionSummary || "-"}`,
    "Project instructions:",
    projectInstructions || "- none",
    "Execution task snapshot:",
    ...(taskLines.length ? taskLines : ["- no frozen tasks yet"]),
  ];
}

export function buildRunContextState(
  run: RunRecord,
  turns: PlannerTurnRecord[],
  draft: PlanDraft | null,
  plannerPrompt: RunContextState["plannerPrompt"] = run.context?.plannerPrompt ?? null,
): RunContextState {
  return {
    goalSummary: summarizeGoal(run, turns),
    planSummary: summarizePlan(draft),
    executionSummary: summarizeExecution(run),
    conversationSummary: summarizeConversation(turns),
    plannerPrompt,
  };
}

export function assemblePlannerPrompt(args: {
  run: RunRecord;
  turns: PlannerTurnRecord[];
  userMessage: string;
  draft: PlanDraft | null;
  projectInstructions: string | null;
}): { prompt: string; context: RunContextState } {
  const baseContext = buildRunContextState(args.run, args.turns, args.draft, null);
  const header = buildPlannerHeader(args.run, args.projectInstructions, baseContext);
  const fullConversation = formatTranscript(args.turns, args.userMessage);
  const fullPrompt = [...header, "", "Conversation history follows:", fullConversation].join("\n");
  const shouldCompress = estimateTokens(fullPrompt) > Math.floor(PLANNER_CONTEXT_SOFT_LIMIT_TOKENS * PLANNER_COMPRESSION_TRIGGER_RATIO);

  let conversationBlock = fullConversation;
  let retainedTurnCount = args.turns.length;
  let summarizedTurnCount = 0;

  if (shouldCompress) {
    const olderTurns = args.turns.slice(0, -PLANNER_RECENT_TURN_LIMIT);
    const recentTurns = args.turns.slice(-PLANNER_RECENT_TURN_LIMIT);
    retainedTurnCount = recentTurns.length;
    summarizedTurnCount = olderTurns.length;
    conversationBlock = [
      "Compressed conversation checkpoint:",
      olderTurns.length ? summarizeConversation(olderTurns) || "-" : "- none",
      "",
      "Recent conversation:",
      formatRecentTurns(args.turns, args.userMessage),
    ].join("\n");
  }

  const prompt = [...header, "", "Conversation context follows:", conversationBlock].join("\n");
  const context = buildRunContextState(args.run, args.turns, args.draft, {
    estimatedTokens: estimateTokens(prompt),
    compressed: shouldCompress,
    retainedTurnCount,
    summarizedTurnCount,
  });
  return { prompt, context };
}

function buildRelevantEventDelta(task: PlanTask, events: RunEvent[], taskState: TaskExecutionRecord | undefined): string | null {
  if (taskState?.lastWakeEventCount === undefined) {
    return null;
  }
  const startIndex = taskState.lastWakeEventCount;
  const newEvents = events
    .slice(startIndex)
    .filter((event) => event.detail.includes(task.id) || event.type.startsWith("execution_") || event.type === "status_changed")
    .slice(-SUMMARY_ITEM_LIMIT);
  if (newEvents.length === 0) {
    return null;
  }
  return newEvents.map((event) => `${event.type}: ${clipText(event.detail, 120)}`).join("\n");
}

function buildRelevantNoteDelta(run: RunRecord, taskState: TaskExecutionRecord | undefined): string | null {
  if (taskState?.lastWakeNoteCount === undefined) {
    return null;
  }
  const startIndex = taskState.lastWakeNoteCount;
  const newNotes = run.notes.slice(startIndex).slice(-SUMMARY_ITEM_LIMIT);
  if (newNotes.length === 0) {
    return null;
  }
  return newNotes.map((note) => clipText(note, 120)).join("\n");
}

export function assembleTaskPrompt(args: {
  run: RunRecord;
  draft: PlanDraft | null;
  task: PlanTask;
  taskState: TaskExecutionRecord | undefined;
  projectInstructions: string | null;
  events: RunEvent[];
}): {
  prompt: string;
  checkpointSummary: string | null;
  wakeDeltaSummary: string | null;
  wakeEventCount: number;
  wakeNoteCount: number;
} {
  const context = buildRunContextState(args.run, [], args.draft, args.run.context?.plannerPrompt ?? null);
  const eventDelta = buildRelevantEventDelta(args.task, args.events, args.taskState);
  const noteDelta = buildRelevantNoteDelta(args.run, args.taskState);
  const wakeDeltaSummary = [eventDelta, noteDelta].filter(Boolean).join("\n") || null;
  const checkpointSummary = clipText(args.taskState?.checkpointSummary || args.taskState?.summary || null, 140);

  const lines = [
    "You are an execution worker inside Codex Agent Orchestrator.",
    "Return JSON only.",
    "This worker gets exactly one task.",
    "If you choose should_wait true, the wait_ms value must stay inside the allowed wait range.",
    args.task.taskMode === "long-running"
      ? "This is a long-running supervision task. Use this turn to inspect progress, read logs, fix bugs, restart commands if needed, and decide whether another scheduled check is required."
      : "For default tasks, a task that waits must also complete after that wait.",
    "",
    `Task ID: ${args.task.id}`,
    `Task title: ${args.task.title}`,
    `Task mode: ${args.task.taskMode}`,
    `Allowed wait range: ${args.task.waitPolicy.minMs} to ${args.task.waitPolicy.maxMs} ms`,
    `Configured check interval: ${args.run.settings.checkIntervalMs} ms`,
    `Goal checkpoint: ${context.goalSummary || "-"}`,
    `Plan checkpoint: ${context.planSummary || "-"}`,
    `Execution checkpoint: ${context.executionSummary || "-"}`,
    "Project instructions:",
    args.projectInstructions || "- none",
  ];
  if (args.taskState) {
    lines.push(
      `Current status: ${args.taskState.status}`,
      `Current action: ${args.taskState.currentAction || "-"}`,
      `Check iteration: ${args.taskState.checkIteration ?? 0}`,
      `Last check at: ${args.taskState.lastCheckAt || "-"}`,
      `Next scheduled check: ${args.taskState.nextCheckAt || "-"}`,
      `Last task checkpoint: ${checkpointSummary || "-"}`,
      `Wake delta since previous check: ${wakeDeltaSummary || "- none"}`,
    );
  }
  lines.push(
    "",
    "Worker instructions:",
    args.task.workerPrompt,
  );
  return {
    prompt: lines.join("\n"),
    checkpointSummary,
    wakeDeltaSummary,
    wakeEventCount: args.run.eventCount,
    wakeNoteCount: args.run.notes.length,
  };
}
