import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

import { getPlannerRoot, getTaskRoot, writeWorkerResult } from "./run-store.js";
import type {
  PlanTask,
  PlannerResponseEnvelope,
  RunRecord,
  TaskExecutionRecord,
  TaskWorkerResponse,
  WorkerResult,
} from "./types.js";

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

function buildExecArgs(
  model: string,
  sandboxMode: "read-only" | "workspace-write",
  schemaPath: string,
  responsePath: string,
): string[] {
  return [
    "exec",
    "-m",
    model,
    "-s",
    sandboxMode,
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    responsePath,
    "-",
  ];
}

function runCodexCommand(
  args: string[],
  cwd: string,
  stdinContent?: string,
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

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";

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
        if (!trimmed.startsWith("{")) {
          continue;
        }
        try {
          onJsonEvent?.(JSON.parse(trimmed));
        } catch {
          // Ignore non-JSON log lines in streamed stdout.
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    if (stdinContent !== undefined) {
      child.stdin.write(stdinContent);
    }
    child.stdin.end();

    child.on("error", reject);
    child.on("close", (code) => {
      const finalLine = stdoutLineBuffer.trim();
      if (finalLine.startsWith("{")) {
        try {
          onJsonEvent?.(JSON.parse(finalLine));
        } catch {
          // Ignore trailing non-JSON output.
        }
      }
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function buildPlannerSchema(): string {
  return JSON.stringify(
    {
      type: "object",
      additionalProperties: false,
      required: ["assistant_response", "plan_update"],
      properties: {
        assistant_response: { type: "string" },
        plan_update: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["summary", "tasks"],
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

function buildPlannerPrompt(run: RunRecord, conversationText: string, projectInstructions: string | null): string {
  const taskLines = run.execution.taskOrder.map((taskId) => {
    const task = run.execution.tasks[taskId];
    const waitUntil = task.waitUntil ? `, waitUntil=${task.waitUntil}` : "";
    const nextCheckAt = task.nextCheckAt ? `, nextCheckAt=${task.nextCheckAt}` : "";
    const iteration = task.checkIteration !== undefined ? `, checkIteration=${task.checkIteration}` : "";
    return `- ${task.taskId}: mode=${task.taskMode || "default"}, status=${task.status}, action=${task.currentAction || "-"}, summary=${task.summary || "-"}${waitUntil}${nextCheckAt}${iteration}`;
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
    `Latest planner message: ${run.planner.latestAssistantMessage || "-"}`,
    `Notes: ${run.notes.length ? run.notes.slice(-3).join(" | ") : "-"}`,
    "Project instructions:",
    projectInstructions || "- none",
    "Execution task snapshot:",
    ...(taskLines.length ? taskLines : ["- no frozen tasks yet"]),
    "",
    "Conversation history follows:",
    conversationText,
  ].join("\n");
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

function buildTaskPrompt(
  run: RunRecord,
  task: PlanTask,
  taskState: TaskExecutionRecord | undefined,
  projectInstructions: string | null,
): string {
  const lines = [
    "You are an execution worker inside Codex Agent Orchestrator.",
    "Return JSON only.",
    "This worker gets exactly one task.",
    "If you choose should_wait true, the wait_ms value must stay inside the allowed wait range.",
    task.taskMode === "long-running"
      ? "This is a long-running supervision task. Use this turn to inspect progress, read logs, fix bugs, restart commands if needed, and decide whether another scheduled check is required."
      : "For default tasks, a task that waits must also complete after that wait.",
    "",
    `Task ID: ${task.id}`,
    `Task title: ${task.title}`,
    `Task mode: ${task.taskMode}`,
    `Allowed wait range: ${task.waitPolicy.minMs} to ${task.waitPolicy.maxMs} ms`,
    `Configured check interval: ${run.settings.checkIntervalMs} ms`,
    "Project instructions:",
    projectInstructions || "- none",
  ];
  if (taskState) {
    lines.push(
      `Current status: ${taskState.status}`,
      `Current action: ${taskState.currentAction || "-"}`,
      `Check iteration: ${taskState.checkIteration ?? 0}`,
      `Last check at: ${taskState.lastCheckAt || "-"}`,
      `Next scheduled check: ${taskState.nextCheckAt || "-"}`,
      `Last summary: ${taskState.summary || "-"}`,
    );
  }
  lines.push(
    "",
    "Worker instructions:",
    task.workerPrompt,
  );
  return lines.join("\n");
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
      onJsonEvent?: (event: unknown) => void,
    ) => {
      const result = await runCodexCommand(
        buildExecArgs(model, sandboxMode, schemaPath, responsePath),
        cwd,
        stdinContent,
        onJsonEvent,
      );

      await fs.writeFile(stdoutPath, result.stdout, "utf8");
      await fs.writeFile(stderrPath, result.stderr, "utf8");

      return {
        model,
        status: result.exitCode === 0 ? "completed" : "failed",
        promptPath,
        schemaPath,
        responsePath,
        stdoutPath,
        stderrPath,
        exitCode: result.exitCode,
      };
    },
  };
}

export async function runPlannerTurn(
  run: RunRecord,
  conversationText: string,
  onJsonEvent?: (event: unknown) => void,
): Promise<{ envelope: PlannerResponseEnvelope; worker: WorkerResult }> {
  const turnId = crypto.randomUUID();
  const workerRoot = path.join(getPlannerRoot(run.repoPath, run.runId), "turn-artifacts", turnId);
  const projectInstructions = await readProjectAgentInstructions(run.repoPath);
  const prompt = buildPlannerPrompt(run, conversationText, projectInstructions);
  const schema = buildPlannerSchema();
  const artifact = await persistWorkerArtifacts(workerRoot, prompt, schema, run.repoPath);
  const worker = await artifact.run(prompt, run.settings.plannerModel, "read-only", onJsonEvent);

  if (worker.exitCode !== 0) {
    throw new Error(`Planner turn failed with exit code ${worker.exitCode}.`);
  }

  const content = await fs.readFile(artifact.responsePath, "utf8");
  return {
    envelope: JSON.parse(content) as PlannerResponseEnvelope,
    worker,
  };
}

export async function runTaskWorker(
  run: RunRecord,
  task: PlanTask,
  taskState?: TaskExecutionRecord,
  onJsonEvent?: (event: unknown) => void,
): Promise<{ response: TaskWorkerResponse; worker: WorkerResult }> {
  const workerRoot = path.join(getTaskRoot(run.repoPath, run.runId, task.id), "worker");
  const projectInstructions = await readProjectAgentInstructions(run.repoPath);
  const prompt = buildTaskPrompt(run, task, taskState, projectInstructions);
  const schema = buildTaskSchema();
  const artifact = await persistWorkerArtifacts(workerRoot, prompt, schema, run.repoPath);
  const worker = await artifact.run(prompt, run.settings.taskWorkerModel, "workspace-write", onJsonEvent);

  await writeWorkerResult(run.repoPath, run.runId, task.id, worker);

  if (worker.exitCode !== 0) {
    throw new Error(`Task worker failed with exit code ${worker.exitCode}.`);
  }

  const content = await fs.readFile(artifact.responsePath, "utf8");
  return {
    response: JSON.parse(content) as TaskWorkerResponse,
    worker,
  };
}
