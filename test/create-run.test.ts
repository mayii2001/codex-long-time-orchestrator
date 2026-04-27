import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeFrozenPlan, freezeCurrentDraft, maintainCompressedContext, submitPlannerMessage } from "../src/orchestrator/planner-runner.js";
import { startAppServer } from "../src/server/http-server.js";
import {
  getEventsPath,
  getExecutionPlanPath,
  getStatePath,
  getTaskRoot,
  listPlannerTurns,
  readActiveDraft,
  readProjectIndex,
  readRunState,
  updateRunState,
} from "../src/orchestrator/run-store.js";
import { createRunScaffold } from "../src/orchestrator/scaffold.js";

test("createRunScaffold writes state and registers project", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;

  const record = await createRunScaffold({ repoPath });
  const statePath = getStatePath(repoPath, record.runId);
  const state = await readRunState(repoPath, record.runId);
  const projects = await readProjectIndex();

  assert.equal(state.runId, record.runId);
  assert.equal(state.phase, "planning");
  assert.equal(state.settings.checkIntervalMs, 600_000);
  assert.equal(projects.projects.length, 1);
  assert.equal(projects.projects[0].runIds[0], record.runId);
  await fs.access(statePath);

  delete process.env.ORCH_HOME;
});

test("planner message updates draft, freezes, and executes task", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-run-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const afterMessage = await submitPlannerMessage(record, "Build a plan for a short wait task.");
  const draft = await readActiveDraft(repoPath, record.runId);
  assert.equal(afterMessage.planner.turnCount, 1);
  assert.equal(afterMessage.planner.planComplete, true);
  assert.equal(afterMessage.planner.canExecute, true);
  assert.match(afterMessage.context.goalSummary || "", /Build a plan/);
  assert.match(afterMessage.context.planSummary || "", /Execute one task/);
  assert.equal(afterMessage.context.plannerPrompt?.compressed, false);
  assert.equal(draft?.tasks.length, 1);

  const frozen = await freezeCurrentDraft(afterMessage);
  assert.equal(frozen.phase, "awaiting_execute_confirmation");
  await fs.access(getExecutionPlanPath(repoPath, record.runId));

  const executed = await executeFrozenPlan(frozen);
  const events = await fs.readFile(getEventsPath(repoPath, record.runId), "utf8");
  assert.equal(executed.phase, "completed");
  assert.equal(executed.status, "done");
  assert.equal(executed.execution.tasks["task-1"].status, "completed");
  assert.match(events, /execution_plan_frozen/);
  assert.match(events, /task_wait_started/);

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("planner main agent runs without ephemeral mode", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-persistence-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const next = await submitPlannerMessage(record, "Verify planner persistence mode.");
  const turns = await listPlannerTurns(repoPath, record.runId);

  assert.equal(next.planner.turnCount, 1);
  assert.equal(turns[0]?.assistantMessage, "planner persistence: durable");
  assert.equal(turns[0]?.worker.ephemeral, false);

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("planner stores and resumes a persistent session id", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-planner-session-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const first = await submitPlannerMessage(record, "Build a plan for a short wait task.");
  assert.equal(first.planner.sessionId, "mock-thread-1");

  const second = await submitPlannerMessage(first, "Verify planner session resume.");
  const turns = await listPlannerTurns(repoPath, record.runId);

  assert.equal(second.planner.sessionId, "mock-thread-1");
  assert.equal(turns[1]?.assistantMessage, "planner session resume: mock-thread-1");

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("planner cannot freeze a draft before plan completion is marked", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-plan-complete-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const planned = await submitPlannerMessage(record, "Build a plan that is still under discussion.");

  assert.equal(planned.planner.planComplete, false);
  assert.equal(planned.planner.canExecute, false);
  assert.match(planned.planner.missingFields.join(" "), /plan complete/);
  await assert.rejects(
    freezeCurrentDraft(planned),
    /Planner has not marked the plan complete yet/,
  );

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("retryable codex api failures stop after five attempts", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-api-retry-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  const retryFile = path.join(homePath, "retry-count.txt");
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");
  process.env.ORCH_MOCK_RETRY_FILE = retryFile;

  const record = await createRunScaffold({ repoPath });
  await assert.rejects(
    submitPlannerMessage(record, "Force planner API reconnect failure for test."),
    /Codex API retry\/reconnect failed 5 times/,
  );

  const attempts = await fs.readFile(retryFile, "utf8");
  assert.equal(attempts.trim(), "5");

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
  delete process.env.ORCH_MOCK_RETRY_FILE;
});

test("single worker call is aborted after five internal api reconnect signals", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-api-ceiling-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const startedAt = Date.now();
  await assert.rejects(
    submitPlannerMessage(record, "Force internal API reconnect loop for test."),
    /Codex API retry ceiling reached after 5 reconnect attempts/,
  );
  assert.ok(Date.now() - startedAt < 5_000);

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("execute endpoint returns immediately and runs in background", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-http-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const afterMessage = await submitPlannerMessage(record, "Build a plan for a short wait task.");
  await freezeCurrentDraft(afterMessage);

  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "execute" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.phase, "executing");

  let finalState = await readRunState(repoPath, record.runId);
  const deadline = Date.now() + 2_000;
  while (finalState.phase !== "completed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    finalState = await readRunState(repoPath, record.runId);
  }

  assert.equal(finalState.phase, "completed");
  assert.equal(finalState.status, "done");

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("terminate task endpoint stops an active waiting task", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-terminate-task-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const afterMessage = await submitPlannerMessage(record, "Build a plan for task termination.");
  await freezeCurrentDraft(afterMessage);

  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const executeResponse = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "execute" }),
  });
  assert.equal(executeResponse.status, 202);

  let waitingState = await readRunState(repoPath, record.runId);
  const waitingDeadline = Date.now() + 2_000;
  while (waitingState.execution.tasks["task-1"]?.status !== "waiting" && Date.now() < waitingDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    waitingState = await readRunState(repoPath, record.runId);
  }
  assert.equal(waitingState.execution.tasks["task-1"]?.status, "waiting");

  const terminateResponse = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}/tasks/task-1/terminate`, {
    method: "POST",
  });
  const terminatePayload = await terminateResponse.json();
  assert.equal(terminateResponse.status, 202);
  assert.equal(terminatePayload.execution.tasks["task-1"].status, "waiting");

  let finalState = await readRunState(repoPath, record.runId);
  const finalDeadline = Date.now() + 2_000;
  while (finalState.execution.tasks["task-1"]?.status !== "failed" && Date.now() < finalDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    finalState = await readRunState(repoPath, record.runId);
  }

  assert.equal(finalState.phase, "failed");
  assert.equal(finalState.status, "error");
  assert.equal(finalState.execution.tasks["task-1"].status, "failed");
  assert.equal(finalState.execution.tasks["task-1"].currentAction, "terminated by operator");
  assert.match(finalState.execution.tasks["task-1"].summary || "", /terminated by operator/);

  const events = await fs.readFile(getEventsPath(repoPath, record.runId), "utf8");
  assert.match(events, /task_termination_requested/);
  assert.match(events, /task_terminated/);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("planner stream emits heartbeat while main agent is still working", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-stream-heartbeat-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}/planner/message/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Delay planner response for heartbeat test." }),
  });
  const streamText = await response.text();
  assert.equal(response.status, 200);
  assert.match(streamText, /"type":"planner_started"/);
  assert.match(streamText, /"type":"planner_heartbeat"/);
  assert.match(streamText, /"type":"done"/);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("settings endpoint persists check interval", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-settings-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;

  const record = await createRunScaffold({ repoPath });
  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkIntervalMs: 12345,
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.settings.checkIntervalMs, 12345);

  const persisted = await readRunState(repoPath, record.runId);
  assert.equal(persisted.settings.checkIntervalMs, 12345);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  delete process.env.ORCH_HOME;
});

test("maintain compressed context uses task model and updates run context", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-context-maintain-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  await updateRunState(repoPath, record.runId, {
    settings: {
      ...record.settings,
      taskWorkerModel: "gpt-5.4",
    },
  });
  const configured = await readRunState(repoPath, record.runId);
  const planned = await submitPlannerMessage(configured, "Build a plan for a short wait task.");
  const maintained = await maintainCompressedContext(planned);

  assert.match(maintained.context.maintainedSummary || "", /Maintained context checkpoint/);
  assert.equal(maintained.context.maintainedByModel, "gpt-5.4");
  assert.ok(maintained.context.maintainedAt);

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("long-running task uses check interval and re-wakes the worker", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-long-running-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const seeded = await readRunState(repoPath, record.runId);
  await updateRunState(repoPath, record.runId, {
    settings: {
      ...seeded.settings,
      checkIntervalMs: 5,
    },
  });

  const configured = await readRunState(repoPath, record.runId);
  const planned = await submitPlannerMessage(configured, "Build a long-running plan for monitoring.");
  const frozen = await freezeCurrentDraft(planned);
  const executed = await executeFrozenPlan(frozen);

  assert.equal(executed.phase, "completed");
  assert.equal(executed.execution.tasks["task-1"].status, "completed");
  assert.equal(executed.execution.tasks["task-1"].taskMode, "long-running");
  assert.equal(executed.execution.tasks["task-1"].checkIteration, 1);
  assert.equal(executed.execution.tasks["task-1"].checkIntervalMs, 5);
  assert.match(executed.execution.tasks["task-1"].checkpointSummary || "", /Long-running task finished/);
  assert.match(executed.execution.tasks["task-1"].wakeDeltaSummary || "", /task_check_scheduled/);
  assert.equal(typeof executed.execution.tasks["task-1"].lastWakeEventCount, "number");
  assert.match(executed.execution.tasks["task-1"].summary || "", /scheduled follow-up check/);
  assert.match(executed.context.executionSummary || "", /completed=1/);

  const events = await fs.readFile(getEventsPath(repoPath, record.runId), "utf8");
  assert.match(events, /task_check_scheduled/);
  assert.match(events, /task_check_started/);
  const workerPrompt = await fs.readFile(path.join(getTaskRoot(repoPath, record.runId, "task-1"), "worker", "prompt.txt"), "utf8");
  assert.match(workerPrompt, /Wake delta since previous check:/);
  assert.match(workerPrompt, /task_check_scheduled/);
  assert.match(workerPrompt, /Last task checkpoint:/);

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("delete run removes state directory and project index entry", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-delete-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;

  const record = await createRunScaffold({ repoPath });
  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}`, {
    method: "DELETE",
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.deleted, true);

  await assert.rejects(fs.access(getStatePath(repoPath, record.runId)));
  const projects = await readProjectIndex();
  assert.deepEqual(projects.projects[0].runIds, []);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  delete process.env.ORCH_HOME;
});

test("stale executing run can resume planner conversation", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-resume-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const planned = await submitPlannerMessage(record, "Build a plan for a short wait task.");
  await updateRunState(repoPath, record.runId, {
    phase: "executing",
    status: "active",
    runtime: {
      executionOwnerId: null,
      executionHeartbeatAt: null,
    },
  });

  const staleRun = await readRunState(repoPath, record.runId);
  const resumed = await submitPlannerMessage(staleRun, "Continue refining the plan after interruption.");
  assert.equal(resumed.phase, "planning");
  assert.equal(resumed.status, "active");
  assert.equal(resumed.planner.turnCount, 2);

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("executeFrozenPlan resumes from completed tasks in saved execution state", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-resume-exec-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const planned = await submitPlannerMessage(record, "Build a two-step plan for resume testing.");
  const frozen = await freezeCurrentDraft(planned);
  const firstCompletedAt = new Date().toISOString();
  await updateRunState(repoPath, record.runId, {
    phase: "executing",
    status: "active",
    execution: {
      taskOrder: ["task-1", "task-2"],
      tasks: {
        "task-1": {
          taskId: "task-1",
          title: "First wait briefly",
          status: "completed",
          startedAt: firstCompletedAt,
          completedAt: firstCompletedAt,
          updatedAt: firstCompletedAt,
          summary: "First resumable task completed.",
        },
        "task-2": {
          taskId: "task-2",
          title: "Then finish second",
          status: "running",
          startedAt: firstCompletedAt,
          updatedAt: firstCompletedAt,
        },
      },
    },
    runtime: {
      executionOwnerId: null,
      executionHeartbeatAt: null,
    },
  });

  const staleRun = await readRunState(repoPath, record.runId);
  const resumed = await executeFrozenPlan(staleRun);
  assert.equal(resumed.phase, "completed");
  assert.equal(resumed.execution.tasks["task-1"].status, "completed");
  assert.equal(resumed.execution.tasks["task-1"].startedAt, firstCompletedAt);
  assert.equal(resumed.execution.tasks["task-2"].status, "completed");

  const events = await fs.readFile(getEventsPath(repoPath, record.runId), "utf8");
  assert.match(events, /Execution resumed from frozen plan/);

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("unknown api route returns json error payload", async () => {
  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/does-not-exist`);
  const payload = await response.json();
  assert.equal(response.status, 404);
  assert.match(payload.error, /API route not found/);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

test("task detail endpoint returns worker process artifacts", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-task-detail-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const afterMessage = await submitPlannerMessage(record, "Build a plan for a short wait task.");
  const frozen = await freezeCurrentDraft(afterMessage);
  await executeFrozenPlan(frozen);

  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}/tasks/task-1`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.task.taskId, "task-1");
  assert.match(payload.process.prompt, /Task ID: task-1/);
  assert.equal(payload.process.response.completed, true);
  assert.match(payload.process.stdout, /mock codex completed/);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("task detail endpoint truncates oversized worker logs", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-task-truncate-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const afterMessage = await submitPlannerMessage(record, "Build a plan for a short wait task.");
  const frozen = await freezeCurrentDraft(afterMessage);
  await executeFrozenPlan(frozen);

  const workerRoot = path.join(getTaskRoot(repoPath, record.runId, "task-1"), "worker");
  const hugeStdout = `${"A".repeat(25_000)}mock codex completed`;
  await fs.writeFile(path.join(workerRoot, "stdout.log"), hugeStdout, "utf8");

  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}/tasks/task-1`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.match(payload.process.stdout, /^\[truncated \d+ chars\]/);
  assert.match(payload.process.stdout, /mock codex completed$/);
  assert.ok(payload.process.stdout.length < hugeStdout.length);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("planner chat stays available while execution is live", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-live-chat-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  const planned = await submitPlannerMessage(record, "Build a plan for a short wait task.");
  await updateRunState(repoPath, record.runId, {
    phase: "executing",
    status: "active",
    runtime: {
      executionOwnerId: "owner-1",
      executionHeartbeatAt: new Date().toISOString(),
    },
  });

  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}/planner/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "What is the current execution progress?" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.phase, "executing");
  assert.equal(payload.planner.turnCount, 2);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});

test("planner streaming flag resets after planner failure", async () => {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-planner-fail-"));
  const homePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-orchestrator-home-"));
  process.env.ORCH_HOME = homePath;
  process.env.ORCH_CODEX_BIN = process.execPath;
  process.env.ORCH_CODEX_ARGS = path.resolve("test", "fixtures", "mock-codex.mjs");

  const record = await createRunScaffold({ repoPath });
  await assert.rejects(
    submitPlannerMessage(record, "Force planner failure for test."),
    /Planner turn failed with exit code 1/,
  );

  const afterFailure = await readRunState(repoPath, record.runId);
  assert.equal(afterFailure.planner.isStreaming, false);

  const server = await startAppServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(record.runId)}/planner/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Build a plan for a short wait task." }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.planner.isStreaming, false);
  assert.equal(payload.planner.turnCount, 1);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  delete process.env.ORCH_HOME;
  delete process.env.ORCH_CODEX_BIN;
  delete process.env.ORCH_CODEX_ARGS;
});
