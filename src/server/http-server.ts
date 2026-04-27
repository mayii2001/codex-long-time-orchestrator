import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendRunEvent,
  deleteRun,
  listPlannerTurns,
  listRunEvents,
  readActiveDraft,
  readProjectIndex,
  readProjectRunSummary,
  readRunState,
  readTaskProcessDetails,
  setRunStatus,
  updateRunState,
} from "../orchestrator/run-store.js";
import {
  executeFrozenPlan,
  freezeCurrentDraft,
  isExecutionLive,
  isPlannerAbortError,
  maintainCompressedContext,
  submitPlannerMessage,
  submitPlannerMessageWithEvents,
  terminatePlannerStreaming,
  terminateTaskExecution,
} from "../orchestrator/planner-runner.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");
const UI_ROOT = path.join(PACKAGE_ROOT, "src", "ui");

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function writeSseEvent(response: http.ServerResponse, event: { type: string; payload: unknown }): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

const activeExecutions = new Set<string>();

function startExecutionInBackground(repoPath: string, runId: string): void {
  if (activeExecutions.has(runId)) {
    return;
  }
  activeExecutions.add(runId);
  void (async () => {
    try {
      const latestRun = await readRunState(repoPath, runId);
      await executeFrozenPlan(latestRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setRunStatus(repoPath, runId, "failed", "error", `Execution failed: ${message}`);
      await updateRunState(repoPath, runId, {
        runtime: {
          executionOwnerId: null,
          executionHeartbeatAt: null,
        },
      });
      await appendRunEvent(repoPath, runId, {
        timestamp: new Date().toISOString(),
        type: "execution_failed",
        detail: message,
      });
    } finally {
      activeExecutions.delete(runId);
    }
  })();
}

export async function startAppServer(port: number): Promise<http.Server> {
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const pathname = requestUrl.pathname;

      if (request.method === "GET" && pathname === "/api/projects") {
        const index = await readProjectIndex();
        const projects = await Promise.all(
          index.projects.map(async (project) => ({
            ...project,
            runs: await Promise.all(project.runIds.map((runId) => readProjectRunSummary(project.repoPath, runId))),
          })),
        );
        sendJson(response, 200, projects);
        return;
      }

      const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const state = await readRunState(project.repoPath, runId);
        sendJson(response, 200, state);
        return;
      }
      if (request.method === "DELETE" && runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        if (activeExecutions.has(runId)) {
          sendJson(response, 409, { error: "Cannot delete a run that is still executing." });
          return;
        }
        await deleteRun(project.repoPath, runId);
        sendJson(response, 200, { deleted: true, runId });
        return;
      }

      const settingsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/settings$/);
      if (request.method === "PATCH" && settingsMatch) {
        const runId = decodeURIComponent(settingsMatch[1]);
        const body = await readJsonBody(request) as {
          plannerModel?: string;
          taskWorkerModel?: string;
          maxAgentCount?: number;
          checkIntervalMs?: number;
        };
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const run = await readRunState(project.repoPath, runId);
        const next = await updateRunState(project.repoPath, runId, {
          settings: {
            plannerModel: body.plannerModel || run.settings.plannerModel,
            taskWorkerModel: body.taskWorkerModel || run.settings.taskWorkerModel,
            maxAgentCount: Number.isInteger(body.maxAgentCount) ? Math.max(1, body.maxAgentCount ?? 1) : run.settings.maxAgentCount,
            checkIntervalMs: Number.isInteger(body.checkIntervalMs) ? Math.max(1, body.checkIntervalMs ?? 1) : run.settings.checkIntervalMs,
          },
        });
        sendJson(response, 200, next);
        return;
      }
      const maintainContextMatch = pathname.match(/^\/api\/runs\/([^/]+)\/context\/maintain$/);
      if (request.method === "POST" && maintainContextMatch) {
        const runId = decodeURIComponent(maintainContextMatch[1]);
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const run = await readRunState(project.repoPath, runId);
        const next = await maintainCompressedContext(run);
        sendJson(response, 200, next);
        return;
      }

      const turnsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/planner\/turns$/);
      if (request.method === "GET" && turnsMatch) {
        const runId = decodeURIComponent(turnsMatch[1]);
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const turns = await listPlannerTurns(project.repoPath, runId);
        sendJson(response, 200, turns);
        return;
      }

      const draftMatch = pathname.match(/^\/api\/runs\/([^/]+)\/planner\/draft$/);
      if (request.method === "GET" && draftMatch) {
        const runId = decodeURIComponent(draftMatch[1]);
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const draft = await readActiveDraft(project.repoPath, runId);
        sendJson(response, 200, draft);
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        const runId = decodeURIComponent(eventsMatch[1]);
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const events = await listRunEvents(project.repoPath, runId);
        sendJson(response, 200, events);
        return;
      }

      const taskDetailMatch = pathname.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)$/);
      if (request.method === "GET" && taskDetailMatch) {
        const runId = decodeURIComponent(taskDetailMatch[1]);
        const taskId = decodeURIComponent(taskDetailMatch[2]);
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const run = await readRunState(project.repoPath, runId);
        if (!run.execution.tasks[taskId]) {
          sendJson(response, 404, { error: `Task not found: ${taskId}` });
          return;
        }
        const task = run.execution.tasks[taskId];
        const processDetails = await readTaskProcessDetails(project.repoPath, runId, taskId);
        sendJson(response, 200, {
          task,
          process: processDetails,
        });
        return;
      }
      const taskTerminateMatch = pathname.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/terminate$/);
      if (request.method === "POST" && taskTerminateMatch) {
        const runId = decodeURIComponent(taskTerminateMatch[1]);
        const taskId = decodeURIComponent(taskTerminateMatch[2]);
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const run = await readRunState(project.repoPath, runId);
        const next = await terminateTaskExecution(run, taskId);
        sendJson(response, 202, next);
        return;
      }

      const messageMatch = pathname.match(/^\/api\/runs\/([^/]+)\/planner\/message$/);
      if (request.method === "POST" && messageMatch) {
        const runId = decodeURIComponent(messageMatch[1]);
        const body = await readJsonBody(request) as { message?: string };
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        if (!body.message || !body.message.trim()) {
          sendJson(response, 400, { error: "message is required" });
          return;
        }
        const run = await readRunState(project.repoPath, runId);
        const next = await submitPlannerMessage(run, body.message);
        sendJson(response, 200, next);
        return;
      }

      const messageStreamMatch = pathname.match(/^\/api\/runs\/([^/]+)\/planner\/message\/stream$/);
      if (request.method === "POST" && messageStreamMatch) {
        const runId = decodeURIComponent(messageStreamMatch[1]);
        const body = await readJsonBody(request) as { message?: string };
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        if (!body.message || !body.message.trim()) {
          sendJson(response, 400, { error: "message is required" });
          return;
        }
        const run = await readRunState(project.repoPath, runId);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        let streamSettled = false;
        const handleClientDisconnect = (): void => {
          if (streamSettled) {
            return;
          }
          streamSettled = true;
          void (async () => {
            const latestRun = await readRunState(project.repoPath, runId);
            if (latestRun.planner.isStreaming) {
              await terminatePlannerStreaming(latestRun, "Planner stream ended because the browser connection closed.");
            }
          })();
        };
        response.on("close", handleClientDisconnect);
        const streamStartedAt = Date.now();
        const heartbeatTimer = setInterval(() => {
          writeSseEvent(response, {
            type: "planner_heartbeat",
            payload: {
              elapsedMs: Date.now() - streamStartedAt,
            },
          });
        }, 1000);
        try {
          const next = await submitPlannerMessageWithEvents(run, body.message, (event) => {
            writeSseEvent(response, event);
          });
          writeSseEvent(response, { type: "run_state", payload: next });
          writeSseEvent(response, { type: "done", payload: { ok: true } });
        } catch (error) {
          if (isPlannerAbortError(error)) {
            writeSseEvent(response, {
              type: "planner_interrupted",
              payload: {
                message: error instanceof Error ? error.message : "Planner interrupted.",
              },
            });
          } else {
            writeSseEvent(response, {
              type: "error",
              payload: {
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        } finally {
          streamSettled = true;
          response.off("close", handleClientDisconnect);
          clearInterval(heartbeatTimer);
          response.end();
        }
        return;
      }

      const plannerTerminateMatch = pathname.match(/^\/api\/runs\/([^/]+)\/planner\/terminate$/);
      if (request.method === "POST" && plannerTerminateMatch) {
        const runId = decodeURIComponent(plannerTerminateMatch[1]);
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const run = await readRunState(project.repoPath, runId);
        const next = await terminatePlannerStreaming(run);
        sendJson(response, 202, next);
        return;
      }

      const freezeMatch = pathname.match(/^\/api\/runs\/([^/]+)\/execute$/);
      if (request.method === "POST" && freezeMatch) {
        const runId = decodeURIComponent(freezeMatch[1]);
        const body = await readJsonBody(request) as { action?: string };
        const index = await readProjectIndex();
        const project = index.projects.find((entry) => entry.runIds.includes(runId));
        if (!project) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }
        const run = await readRunState(project.repoPath, runId);
        if (body.action === "freeze") {
          if (isExecutionLive(run)) {
            sendJson(response, 409, { error: "Run is still executing. Wait for execution to stop before freezing a new plan." });
            return;
          }
          const next = await freezeCurrentDraft(run);
          sendJson(response, 200, next);
          return;
        }
        if (body.action === "execute") {
          if (run.phase === "completed" || run.phase === "cancelled") {
            sendJson(response, 409, { error: `Run cannot execute from phase ${run.phase}.` });
            return;
          }
          if (activeExecutions.has(runId) || isExecutionLive(run)) {
            sendJson(response, 409, { error: "Run is already executing." });
            return;
          }
          const accepted = await setRunStatus(
            project.repoPath,
            runId,
            "executing",
            "active",
            "Execution accepted and started in background.",
          );
          startExecutionInBackground(project.repoPath, runId);
          sendJson(response, 202, accepted);
          return;
        }
        sendJson(response, 400, { error: "action must be freeze or execute" });
        return;
      }

      if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = await fs.readFile(path.join(UI_ROOT, "index.html"), "utf8");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: `API route not found: ${pathname}` });
        return;
      }

      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return server;
}
