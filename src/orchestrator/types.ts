export type RunPhase =
  | "planning"
  | "awaiting_execute_confirmation"
  | "executing"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStatus = "active" | "done" | "error" | "cancelled";

export type TaskStatus = "pending" | "running" | "waiting" | "completed" | "failed";
export type TaskMode = "default" | "long-running";
export const DEFAULT_CHECK_INTERVAL_MS = 600_000;

export interface RunEvent {
  timestamp: string;
  type: string;
  detail: string;
}

export interface WorkerResult {
  model: string;
  status: "pending" | "completed" | "failed";
  ephemeral: boolean;
  promptPath: string;
  schemaPath: string;
  responsePath: string;
  stdoutPath: string;
  stderrPath: string;
  exitCode: number;
}

export interface RunSettings {
  plannerModel: string;
  taskWorkerModel: string;
  maxAgentCount: number;
  checkIntervalMs: number;
}

export interface ProjectRecord {
  projectId: string;
  repoPath: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
}

export interface ProjectRunSummary {
  runId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  phase: RunPhase;
  status: RunStatus;
}

export interface ProjectIndex {
  projects: ProjectRecord[];
}

export interface WaitPolicy {
  minMs: number;
  maxMs: number;
}

export interface PlanTask {
  id: string;
  title: string;
  dependsOn: string[];
  workerPrompt: string;
  waitPolicy: WaitPolicy;
  taskMode: TaskMode;
}

export interface PlanDraft {
  version: number;
  summary: string;
  tasks: PlanTask[];
}

export interface PlannerTurnRecord {
  turnId: string;
  timestamp: string;
  userMessage: string;
  assistantMessage: string;
  planUpdated: boolean;
  draftVersion?: number;
  worker: WorkerResult;
}

export interface PlannerState {
  turnCount: number;
  activeDraftVersion: number | null;
  latestAssistantMessage: string | null;
  sessionId: string | null;
  planComplete: boolean;
  canExecute: boolean;
  missingFields: string[];
  isStreaming: boolean;
}

export interface PlannerPromptContextMeta {
  estimatedTokens: number;
  compressed: boolean;
  retainedTurnCount: number;
  summarizedTurnCount: number;
}

export interface RunContextState {
  goalSummary: string | null;
  planSummary: string | null;
  executionSummary: string | null;
  conversationSummary: string | null;
  maintainedSummary: string | null;
  maintainedAt: string | null;
  maintainedByModel: string | null;
  plannerPrompt: PlannerPromptContextMeta | null;
}

export interface TaskExecutionRecord {
  taskId: string;
  title: string;
  status: TaskStatus;
  taskMode?: TaskMode;
  model?: string;
  currentAction?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  waitDecisionMs?: number;
  waitStartedAt?: string;
  waitUntil?: string;
  checkIntervalMs?: number;
  checkIteration?: number;
  lastCheckAt?: string;
  nextCheckAt?: string;
  summary?: string;
  checkpointSummary?: string;
  wakeDeltaSummary?: string;
  lastWakeEventCount?: number;
  lastWakeNoteCount?: number;
}

export interface ExecutionState {
  taskOrder: string[];
  tasks: Record<string, TaskExecutionRecord>;
}

export interface RunRuntimeState {
  executionOwnerId: string | null;
  executionHeartbeatAt: string | null;
}

export interface RunRecord {
  runId: string;
  projectId: string;
  repoPath: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  phase: RunPhase;
  status: RunStatus;
  settings: RunSettings;
  notes: string[];
  context: RunContextState;
  planner: PlannerState;
  execution: ExecutionState;
  runtime: RunRuntimeState;
}

export interface PlannerResponseEnvelope {
  assistant_response: string;
  plan_complete: boolean;
  plan_update: null | {
    summary: string;
    tasks: Array<{
      id: string;
      title: string;
      depends_on: string[];
      worker_prompt: string;
      task_mode?: TaskMode;
      wait_range_ms: {
        min: number;
        max: number;
      };
    }>;
  };
}

export interface TaskWorkerResponse {
  summary: string;
  should_wait: boolean;
  wait_ms: number;
  completed: boolean;
}
