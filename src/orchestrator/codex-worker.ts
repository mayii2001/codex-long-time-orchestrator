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
  ephemeral: boolean,
): string[] {
  return [
    "exec",
    "-m",
    model,
    "-s",
    sandboxMode,
    "--skip-git-repo-check",
    ...(ephemeral ? ["--ephemeral"] : []),
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
      onJsonEvent?: (event: unknown) => void,
    ) => {
      const result = await runCodexCommand(
        buildExecArgs(model, sandboxMode, schemaPath, responsePath, ephemeral),
        cwd,
        stdinContent,
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
    },
  };
}

export async function runPlannerTurn(
  run: RunRecord,
  turns: PlannerTurnRecord[],
  userMessage: string,
  onJsonEvent?: (event: unknown) => void,
): Promise<{ envelope: PlannerResponseEnvelope; worker: WorkerResult; context: RunRecord["context"] }> {
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
  const worker = await artifact.run(prompt, run.settings.plannerModel, "read-only", false, onJsonEvent);

  if (worker.exitCode !== 0) {
    throw new Error(`Planner turn failed with exit code ${worker.exitCode}.`);
  }

  const content = await fs.readFile(artifact.responsePath, "utf8");
  return {
    envelope: JSON.parse(content) as PlannerResponseEnvelope,
    worker,
    context: assembled.context,
  };
}

export async function runTaskWorker(
  run: RunRecord,
  task: PlanTask,
  taskState?: TaskExecutionRecord,
  onJsonEvent?: (event: unknown) => void,
): Promise<{
  response: TaskWorkerResponse;
  worker: WorkerResult;
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
  const worker = await artifact.run(prompt, run.settings.taskWorkerModel, "workspace-write", true, onJsonEvent);

  await writeWorkerResult(run.repoPath, run.runId, task.id, worker);

  if (worker.exitCode !== 0) {
    throw new Error(`Task worker failed with exit code ${worker.exitCode}.`);
  }

  const content = await fs.readFile(artifact.responsePath, "utf8");
  const response = JSON.parse(content) as TaskWorkerResponse;
  return {
    response,
    worker,
    contextPatch: {
      checkpointSummary: response.summary,
      wakeDeltaSummary: assembled.wakeDeltaSummary ?? undefined,
      lastWakeEventCount: assembled.wakeEventCount,
      lastWakeNoteCount: assembled.wakeNoteCount,
    },
  };
}
