import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

import { assemblePlannerPrompt, assembleTaskPrompt } from "./context-assembler.js";
import { getPlannerRoot, getTaskRoot, listRunEvents, readActiveDraft, writeWorkerResult } from "./run-store.js";
import type {
  PlanTask,
  PlannerTurnRecord,
  PlannerResponseEnvelope,
  RunRecord,
  TaskExecutionRecord,
  TaskWorkerResponse,
  WorkerResult,
} from "./types.js";

const MAX_RETRYABLE_API_FAILURES = 5;
const RETRYABLE_API_FAILURE_PATTERNS = [
  /api/i,
  /connection/i,
  /connect/i,
  /network/i,
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /fetch failed/i,
  /temporarily unavailable/i,
  /rate limit/i,
  /\b429\b/,
  /\b499\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /overloaded/i,
  /stream error/i,
];

const RETRY_SIGNAL_PATTERNS = [
  /retry/i,
  /reconnect/i,
  /trying again/i,
  /attempt/i,
  /backoff/i,
];

async function readProjectAgentInstructions(repoPath: string): Promise<string | null> {
  const candidates = ["AGENTS.md", "AGENT.md"];
  for (const candidate of candidates) {
    const filePath = path.join(repoPath, candidate);
    try {
      const content = await fs.readFile(filePath, "utf8");
      if (content.trim()) {
        return content.trim();
      }
    } catch {
      // Continue to the next candidate.
    }
  }
  return null;
}

function getCodexCommand(): string {
  if (process.env.ORCH_CODEX_BIN) {
    return process.env.ORCH_CODEX_BIN;
  }
  if (process.platform === "win32") {
    return "codex.cmd";
  }
  return "codex";
}

function getCodexPrefixArgs(): string[] {
  const raw = process.env.ORCH_CODEX_ARGS;
  if (!raw) {
    return [];
  }
  return raw.split(" ").filter((part) => part.length > 0);
}

function buildOrchestratorExecCommonArgs(): string[] {
  return [
    "--skip-git-repo-check",
    "--ignore-rules",
  ];
}

function buildExecArgs(
  model: string,
  sandboxMode: "read-only" | "workspace-write",
  schemaPath: string,
  responsePath: string,
  ephemeral: boolean,
): string[] {
  return [
    "exec",
    "-m",
    model,
    "-s",
    sandboxMode,
    ...buildOrchestratorExecCommonArgs(),
    ...(ephemeral ? ["--ephemeral"] : []),
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    responsePath,
    "-",
  ];
}

function buildPlannerExecArgs(model: string, responsePath: string, sessionId: string | null): string[] {
  if (sessionId) {
    return [
      "exec",
      "resume",
      ...buildOrchestratorExecCommonArgs(),
      "-m",
      model,
      "--json",
      "--output-last-message",
      responsePath,
      sessionId,
      "-",
    ];
  }

  return [
    "exec",
    "-m",
    model,
    "-s",
    "read-only",
    ...buildOrchestratorExecCommonArgs(),
    "--json",
    "--output-last-message",
    responsePath,
    "-",
  ];
}

function buildTaskExecArgs(
  model: string,
  sandboxMode: "read-only" | "workspace-write",
  schemaPath: string,
  responsePath: string,
  sessionId: string | null,
): string[] {
  if (sessionId) {
    return [
      "exec",
      "-s",
      sandboxMode,
      "resume",
      ...buildOrchestratorExecCommonArgs(),
      "-m",
      model,
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      responsePath,
      sessionId,
      "-",
    ];
  }
  return buildExecArgs(model, sandboxMode, schemaPath, responsePath, false);
}

function isRetryableApiFailure(errorText: string): boolean {
  return RETRYABLE_API_FAILURE_PATTERNS.some((pattern) => pattern.test(errorText));
}

function isRetrySignal(text: string): boolean {
  return RETRY_SIGNAL_PATTERNS.some((pattern) => pattern.test(text)) && isRetryableApiFailure(text);
}

function isRetryLimitError(text: string): boolean {
  return text.includes("Codex API retry ceiling reached");
}

function getRetryBackoffMs(attempt: number): number {
  return Math.min(5_000, attempt * 1_000);
}

async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", abortListener);
      }
      resolve();
    }, ms);

    const abortListener = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abortListener);
      reject(new Error("Worker aborted."));
    };

    if (!abortSignal) {
      return;
    }
    if (abortSignal.aborted) {
      abortListener();
      return;
    }
    abortSignal.addEventListener("abort", abortListener, { once: true });
  });
}

function runCodexCommandOnce(
  args: string[],
  cwd: string,
  stdinContent?: string,
  abortSignal?: AbortSignal,
  onJsonEvent?: (event: unknown) => void,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const command = getCodexCommand();
    const childArgs = [...getCodexPrefixArgs(), ...args];
    const useCmdWrapper = process.platform === "win32" && (command.endsWith(".cmd") || command === "codex" || command === "codex.cmd");
    const executable = useCmdWrapper ? (process.env.ComSpec || "cmd.exe") : command;
    const executableArgs = useCmdWrapper ? ["/d", "/s", "/c", command, ...childArgs] : childArgs;

    const child = spawn(executable, executableArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const resolveOnce = (payload: { exitCode: number; stdout: string; stderr: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(payload);
    };

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";
    let retrySignalCount = 0;
    let lastRetrySignal = "";

    const observeRetrySignal = (text: string): void => {
      if (!isRetrySignal(text)) {
        return;
      }
      retrySignalCount += 1;
      lastRetrySignal = text.trim();
      if (retrySignalCount < MAX_RETRYABLE_API_FAILURES) {
        return;
      }
      child.kill();
      rejectOnce(
        new Error(
          `Codex API retry ceiling reached after ${MAX_RETRYABLE_API_FAILURES} reconnect attempts during a single worker call. Last signal: ${lastRetrySignal}`,
        ),
      );
    };

    const abortListener = (): void => {
      child.kill();
      const reason = abortSignal?.reason;
      if (reason instanceof Error) {
        rejectOnce(reason);
        return;
      }
      rejectOnce(new Error(typeof reason === "string" ? reason : "Worker aborted."));
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        abortListener();
        return;
      }
      abortSignal.addEventListener("abort", abortListener, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        observeRetrySignal(trimmed);
        if (!trimmed.startsWith("{")) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed);
          observeRetrySignal(JSON.stringify(parsed));
          onJsonEvent?.(parsed);
        } catch {
          // Ignore non-JSON log lines in streamed stdout.
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrLineBuffer += text;
      const lines = stderrLineBuffer.split(/\r?\n/);
      stderrLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        observeRetrySignal(trimmed);
      }
    });

    if (stdinContent !== undefined) {
      child.stdin.write(stdinContent);
    }
    child.stdin.end();

    child.on("error", (error) => {
      rejectOnce(error);
    });
    child.on("close", (code) => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", abortListener);
      }
      const finalLine = stdoutLineBuffer.trim();
      if (finalLine.startsWith("{")) {
        try {
          const parsed = JSON.parse(finalLine);
          observeRetrySignal(JSON.stringify(parsed));
          onJsonEvent?.(parsed);
        } catch {
          // Ignore trailing non-JSON output.
        }
      }
      const finalStderrLine = stderrLineBuffer.trim();
      if (finalStderrLine) {
        observeRetrySignal(finalStderrLine);
      }
      resolveOnce({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function runCodexCommand(
  args: string[],
  cwd: string,
  stdinContent?: string,
  abortSignal?: AbortSignal,
  onJsonEvent?: (event: unknown) => void,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let lastFailureText = "";

  for (let attempt = 1; attempt <= MAX_RETRYABLE_API_FAILURES; attempt += 1) {
    try {
      const result = await runCodexCommandOnce(args, cwd, stdinContent, abortSignal, onJsonEvent);
      if (result.exitCode === 0) {
        return result;
      }

      const failureText = `${result.stdout}\n${result.stderr}`.trim();
      lastFailureText = failureText;
      if (!isRetryableApiFailure(failureText) || attempt === MAX_RETRYABLE_API_FAILURES) {
        if (attempt === MAX_RETRYABLE_API_FAILURES && isRetryableApiFailure(failureText)) {
          throw new Error(
            `Codex API retry/reconnect failed ${MAX_RETRYABLE_API_FAILURES} times. Last failure: ${failureText || `exit code ${result.exitCode}`}`,
          );
        }
        return result;
      }

      await sleep(getRetryBackoffMs(attempt), abortSignal);
    } catch (error) {
      const failureText = error instanceof Error ? error.message : String(error);
      lastFailureText = failureText;
      if (isRetryLimitError(failureText)) {
        throw error;
      }
      if (!isRetryableApiFailure(failureText) || attempt === MAX_RETRYABLE_API_FAILURES) {
        if (attempt === MAX_RETRYABLE_API_FAILURES && isRetryableApiFailure(failureText)) {
          throw new Error(
            `Codex API retry/reconnect failed ${MAX_RETRYABLE_API_FAILURES} times. Last failure: ${failureText}`,
          );
        }
        throw error;
      }

      await sleep(getRetryBackoffMs(attempt), abortSignal);
    }
  }

  throw new Error(
    `Codex API retry/reconnect failed ${MAX_RETRYABLE_API_FAILURES} times. Last failure: ${lastFailureText || "unknown failure"}`,
  );
}

function buildPlannerSchema(): string {
  return JSON.stringify(
    {
      type: "object",
      additionalProperties: false,
      required: ["assistant_response", "plan_complete", "plan_update"],
      properties: {
        assistant_response: { type: "string" },
        plan_complete: { type: "boolean" },
        plan_update: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["tasks"],
              properties: {
                summary: { type: "string" },
                tasks: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "title", "depends_on", "worker_prompt", "wait_range_ms"],
                    properties: {
                      id: { type: "string" },
                      title: { type: "string" },
                      depends_on: {
                        type: "array",
                        items: { type: "string" },
                      },
                      worker_prompt: { type: "string" },
                      task_mode: {
                        type: "string",
                        enum: ["default", "long-running"],
                      },
                      wait_range_ms: {
                        type: "object",
                        additionalProperties: false,
                        required: ["min", "max"],
                        properties: {
                          min: { type: "integer", minimum: 0 },
                          max: { type: "integer", minimum: 0 },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
    null,
    2,
  );
}

function buildTaskSchema(): string {
  return JSON.stringify(
    {
      type: "object",
      additionalProperties: false,
      required: ["summary", "should_wait", "wait_ms", "completed"],
      properties: {
        summary: { type: "string" },
        should_wait: { type: "boolean" },
        wait_ms: { type: "integer", minimum: 0 },
        completed: { type: "boolean" },
      },
    },
    null,
    2,
  );
}

function buildContextMaintenanceSchema(): string {
  return JSON.stringify(
    {
      type: "object",
      additionalProperties: false,
      required: ["maintained_summary"],
      properties: {
        maintained_summary: { type: "string" },
      },
    },
    null,
    2,
  );
}

function buildContextMaintenancePrompt(
  run: RunRecord,
  turns: PlannerTurnRecord[],
  projectInstructions: string | null,
): string {
  const recentTurns = turns.slice(-8).flatMap((turn) => [
    `user: ${turn.userMessage}`,
    `assistant: ${turn.assistantMessage}`,
  ]);
  const taskLines = run.execution.taskOrder.slice(0, 8).map((taskId) => {
    const task = run.execution.tasks[taskId];
    return `- ${task.taskId}: ${task.status}; action=${task.currentAction || "-"}; summary=${task.summary || "-"}`;
  });
  return [
    "You are the context maintenance worker inside Codex Agent Orchestrator.",
    "Use the task model to compress the current run context for future planner and execution turns.",
    "Return JSON only.",
    "Write maintained_summary as a compact, faithful checkpoint of the run.",
    "Include only durable facts that matter for future turns: goal, accepted plan, completed work, current blockers, operator decisions, and the most important unresolved next step.",
    "Do not repeat raw logs. Do not invent facts. Keep the summary concise and stable.",
    "",
    `Run ID: ${run.runId}`,
    `Run phase: ${run.phase}`,
    `Run status: ${run.status}`,
    `Goal checkpoint: ${run.context.goalSummary || "-"}`,
    `Plan checkpoint: ${run.context.planSummary || "-"}`,
    `Execution checkpoint: ${run.context.executionSummary || "-"}`,
    `Conversation checkpoint: ${run.context.conversationSummary || "-"}`,
    `Existing maintained context: ${run.context.maintainedSummary || "-"}`,
    "Project instructions:",
    projectInstructions || "- none",
    "Execution task snapshot:",
    ...(taskLines.length ? taskLines : ["- no frozen tasks yet"]),
    "Recent conversation:",
    ...(recentTurns.length ? recentTurns : ["- no planner turns yet"]),
  ].join("\n");
}

function stripMarkdownCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const withoutStart = trimmed.replace(/^```(?:json)?\s*/i, "");
  return withoutStart.replace(/\s*```$/, "").trim();
}

function parsePlannerEnvelope(raw: string): PlannerResponseEnvelope {
  const normalized = stripMarkdownCodeFence(raw);
  const parsed = JSON.parse(normalized) as Partial<PlannerResponseEnvelope>;
  if (
    typeof parsed.assistant_response !== "string"
    || typeof parsed.plan_complete !== "boolean"
    || !("plan_update" in parsed)
  ) {
    throw new Error("Planner did not return a valid JSON envelope.");
  }
  return parsed as PlannerResponseEnvelope;
}

function extractThreadSessionId(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const typed = event as { type?: unknown; thread_id?: unknown };
  if (typed.type !== "thread.started" || typeof typed.thread_id !== "string") {
    return null;
  }
  return typed.thread_id;
}

async function persistWorkerArtifacts(
  workerRoot: string,
  prompt: string,
  schema: string,
  cwd: string,
): Promise<{
  promptPath: string;
  schemaPath: string;
  responsePath: string;
  stdoutPath: string;
  stderrPath: string;
    run: (
      stdinContent: string,
      model: string,
      sandboxMode: "read-only" | "workspace-write",
      ephemeral: boolean,
      abortSignal?: AbortSignal,
      onJsonEvent?: (event: unknown) => void,
    ) => Promise<WorkerResult>;
}> {
  await fs.mkdir(workerRoot, { recursive: true });
  const promptPath = path.join(workerRoot, "prompt.txt");
  const schemaPath = path.join(workerRoot, "response.schema.json");
  const responsePath = path.join(workerRoot, "response.json");
  const stdoutPath = path.join(workerRoot, "stdout.log");
  const stderrPath = path.join(workerRoot, "stderr.log");

  await fs.writeFile(promptPath, prompt, "utf8");
  await fs.writeFile(schemaPath, schema, "utf8");

  return {
    promptPath,
    schemaPath,
    responsePath,
    stdoutPath,
    stderrPath,
    run: async (
      stdinContent: string,
      model: string,
      sandboxMode: "read-only" | "workspace-write",
      ephemeral: boolean,
      abortSignal?: AbortSignal,
      onJsonEvent?: (event: unknown) => void,
    ) => {
      try {
        const result = await runCodexCommand(
          buildExecArgs(model, sandboxMode, schemaPath, responsePath, ephemeral),
          cwd,
          stdinContent,
          abortSignal,
          onJsonEvent,
        );

        await fs.writeFile(stdoutPath, result.stdout, "utf8");
        await fs.writeFile(stderrPath, result.stderr, "utf8");

        return {
          model,
          status: result.exitCode === 0 ? "completed" : "failed",
          ephemeral,
          promptPath,
          schemaPath,
          responsePath,
          stdoutPath,
          stderrPath,
          exitCode: result.exitCode,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await fs.writeFile(stdoutPath, "", "utf8");
        await fs.writeFile(stderrPath, message, "utf8");
        throw error;
      }
    },
  };
}

export async function runPlannerTurn(
  run: RunRecord,
  turns: PlannerTurnRecord[],
  userMessage: string,
  abortSignal?: AbortSignal,
  onJsonEvent?: (event: unknown) => void,
): Promise<{ envelope: PlannerResponseEnvelope; worker: WorkerResult; context: RunRecord["context"]; sessionId: string | null }> {
  const turnId = crypto.randomUUID();
  const workerRoot = path.join(getPlannerRoot(run.repoPath, run.runId), "turn-artifacts", turnId);
  const projectInstructions = await readProjectAgentInstructions(run.repoPath);
  const draft = await readActiveDraft(run.repoPath, run.runId);
  const assembled = assemblePlannerPrompt({
    run,
    turns,
    userMessage,
    draft,
    projectInstructions,
  });
  const prompt = assembled.prompt;
  const schema = buildPlannerSchema();
  const artifact = await persistWorkerArtifacts(workerRoot, prompt, schema, run.repoPath);
  let sessionId = run.planner.sessionId;
  let artifactsWritten = false;

  try {
    const result = await runCodexCommand(
      buildPlannerExecArgs(run.settings.plannerModel, artifact.responsePath, run.planner.sessionId),
      run.repoPath,
      prompt,
      abortSignal,
      (event) => {
        const nextSessionId = extractThreadSessionId(event);
        if (nextSessionId) {
          sessionId = nextSessionId;
        }
        onJsonEvent?.(event);
      },
    );

    await fs.writeFile(artifact.stdoutPath, result.stdout, "utf8");
    await fs.writeFile(artifact.stderrPath, result.stderr, "utf8");
    artifactsWritten = true;

    const worker: WorkerResult = {
      model: run.settings.plannerModel,
      status: result.exitCode === 0 ? "completed" : "failed",
      ephemeral: false,
      sessionId,
      promptPath: artifact.promptPath,
      schemaPath: artifact.schemaPath,
      responsePath: artifact.responsePath,
      stdoutPath: artifact.stdoutPath,
      stderrPath: artifact.stderrPath,
      exitCode: result.exitCode,
    };

    if (worker.exitCode !== 0) {
      throw new Error(`Planner turn failed with exit code ${worker.exitCode}.`);
    }

    const content = await fs.readFile(artifact.responsePath, "utf8");
    return {
      envelope: parsePlannerEnvelope(content),
      worker,
      context: assembled.context,
      sessionId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!artifactsWritten) {
      await fs.writeFile(artifact.stdoutPath, "", "utf8");
      await fs.writeFile(artifact.stderrPath, message, "utf8");
    }
    throw error;
  }
}

export async function runTaskWorker(
  run: RunRecord,
  task: PlanTask,
  taskState?: TaskExecutionRecord,
  abortSignal?: AbortSignal,
  onJsonEvent?: (event: unknown) => void,
): Promise<{
  response: TaskWorkerResponse;
  worker: WorkerResult;
  sessionId: string | null;
  contextPatch: Pick<TaskExecutionRecord, "checkpointSummary" | "wakeDeltaSummary" | "lastWakeEventCount" | "lastWakeNoteCount">;
}> {
  const workerRoot = path.join(getTaskRoot(run.repoPath, run.runId, task.id), "worker");
  const projectInstructions = await readProjectAgentInstructions(run.repoPath);
  const draft = await readActiveDraft(run.repoPath, run.runId);
  const events = await listRunEvents(run.repoPath, run.runId);
  const assembled = assembleTaskPrompt({
    run,
    draft,
    task,
    taskState,
    projectInstructions,
    events,
  });
  const prompt = assembled.prompt;
  const schema = buildTaskSchema();
  const artifact = await persistWorkerArtifacts(workerRoot, prompt, schema, run.repoPath);
  let sessionId = taskState?.sessionId ?? null;
  let artifactsWritten = false;

  try {
    const result = await runCodexCommand(
      buildTaskExecArgs(run.settings.taskWorkerModel, "workspace-write", artifact.schemaPath, artifact.responsePath, taskState?.sessionId ?? null),
      run.repoPath,
      prompt,
      abortSignal,
      (event) => {
        const nextSessionId = extractThreadSessionId(event);
        if (nextSessionId) {
          sessionId = nextSessionId;
        }
        onJsonEvent?.(event);
      },
    );

    await fs.writeFile(artifact.stdoutPath, result.stdout, "utf8");
    await fs.writeFile(artifact.stderrPath, result.stderr, "utf8");
    artifactsWritten = true;

    const worker: WorkerResult = {
      model: run.settings.taskWorkerModel,
      status: result.exitCode === 0 ? "completed" : "failed",
      ephemeral: false,
      sessionId,
      promptPath: artifact.promptPath,
      schemaPath: artifact.schemaPath,
      responsePath: artifact.responsePath,
      stdoutPath: artifact.stdoutPath,
      stderrPath: artifact.stderrPath,
      exitCode: result.exitCode,
    };

    await writeWorkerResult(run.repoPath, run.runId, task.id, worker);

    if (worker.exitCode !== 0) {
      throw new Error(`Task worker failed with exit code ${worker.exitCode}.`);
    }

    const content = await fs.readFile(artifact.responsePath, "utf8");
    const response = JSON.parse(content) as TaskWorkerResponse;
    return {
      response,
      worker,
      sessionId,
      contextPatch: {
        checkpointSummary: response.summary,
        wakeDeltaSummary: assembled.wakeDeltaSummary ?? undefined,
        lastWakeEventCount: assembled.wakeEventCount,
        lastWakeNoteCount: assembled.wakeNoteCount,
      },
    };
  } catch (error) {
    if (!artifactsWritten) {
      const message = error instanceof Error ? error.message : String(error);
      await fs.writeFile(artifact.stdoutPath, "", "utf8");
      await fs.writeFile(artifact.stderrPath, message, "utf8");
    }
    throw error;
  }
}

export async function runContextMaintenanceWorker(
  run: RunRecord,
  turns: PlannerTurnRecord[],
): Promise<{ maintainedSummary: string; worker: WorkerResult }> {
  const workerId = crypto.randomUUID();
  const workerRoot = path.join(getPlannerRoot(run.repoPath, run.runId), "context-maintenance", workerId);
  const projectInstructions = await readProjectAgentInstructions(run.repoPath);
  const prompt = buildContextMaintenancePrompt(run, turns, projectInstructions);
  const schema = buildContextMaintenanceSchema();
  const artifact = await persistWorkerArtifacts(workerRoot, prompt, schema, run.repoPath);
  const worker = await artifact.run(prompt, run.settings.taskWorkerModel, "read-only", true);

  if (worker.exitCode !== 0) {
    throw new Error(`Context maintenance worker failed with exit code ${worker.exitCode}.`);
  }

  const content = await fs.readFile(artifact.responsePath, "utf8");
  const parsed = JSON.parse(content) as { maintained_summary: string };
  return {
    maintainedSummary: parsed.maintained_summary.trim(),
    worker,
  };
}
