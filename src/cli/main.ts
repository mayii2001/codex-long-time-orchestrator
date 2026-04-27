#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";

import { createRunScaffold } from "../orchestrator/scaffold.js";
import { deleteRun, readRunState, setRunStatus } from "../orchestrator/run-store.js";
import { executeFrozenPlan, freezeCurrentDraft } from "../orchestrator/planner-runner.js";
import { startAppServer } from "../server/http-server.js";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inlineValue] = token.split("=", 2);
    const key = name.slice(2);
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
      continue;
    }
    flags[key] = true;
  }

  return { command, positionals, flags };
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

function resolveRepoPath(flags: Record<string, string | boolean>): string {
  const value = flags.repo;
  if (typeof value === "string" && value.trim() !== "") {
    return path.resolve(value);
  }
  return process.cwd();
}

function openBrowser(url: string): void {
  if (process.platform === "win32") {
    spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function printHelp(): void {
  console.log(`orch

Usage:
  orch doctor
  orch plan [--repo <path>] [--port <n>] [--no-open]
  orch status [--repo <path>] --run-id <id>
  orch serve [--port <n>]
  orch cancel [--repo <path>] --run-id <id>
  orch delete-run [--repo <path>] --run-id <id>
  orch report [--repo <path>] --run-id <id>
  orch freeze [--repo <path>] --run-id <id>
  orch execute [--repo <path>] --run-id <id>
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "doctor": {
      console.log("CLI: ok");
      console.log(`Node: ${process.version}`);
      console.log(`CWD: ${process.cwd()}`);
      return;
    }
    case "plan": {
      const repoPath = resolveRepoPath(args.flags);
      const portRaw = args.flags.port;
      const port = typeof portRaw === "string" ? Number.parseInt(portRaw, 10) : 4318;
      if (!Number.isInteger(port) || port < 1) {
        throw new Error("Invalid --port");
      }
      const record = await createRunScaffold({ repoPath });
      await startAppServer(port);
      const url = `http://127.0.0.1:${port}/?projectId=${encodeURIComponent(record.projectId)}&runId=${encodeURIComponent(record.runId)}`;
      console.log(`Planner: ${url}`);
      if (args.flags["no-open"] !== true) {
        openBrowser(url);
      }
      return await new Promise(() => {});
    }
    case "serve": {
      const portRaw = args.flags.port;
      const port = typeof portRaw === "string" ? Number.parseInt(portRaw, 10) : 4318;
      if (!Number.isInteger(port) || port < 1) {
        throw new Error("Invalid --port");
      }
      await startAppServer(port);
      console.log(`Dashboard: http://127.0.0.1:${port}/`);
      return await new Promise(() => {});
    }
    case "freeze": {
      const repoPath = resolveRepoPath(args.flags);
      const runId = requireFlag(args.flags, "run-id");
      const run = await readRunState(repoPath, runId);
      const next = await freezeCurrentDraft(run);
      console.log(JSON.stringify(next, null, 2));
      return;
    }
    case "execute": {
      const repoPath = resolveRepoPath(args.flags);
      const runId = requireFlag(args.flags, "run-id");
      const run = await readRunState(repoPath, runId);
      const next = await executeFrozenPlan(run);
      console.log(JSON.stringify(next, null, 2));
      return;
    }
    case "status": {
      const repoPath = resolveRepoPath(args.flags);
      const runId = requireFlag(args.flags, "run-id");
      const state = await readRunState(repoPath, runId);
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    case "cancel": {
      const repoPath = resolveRepoPath(args.flags);
      const runId = requireFlag(args.flags, "run-id");
      const next = await setRunStatus(repoPath, runId, "cancelled", "cancelled", "Run cancelled by operator.");
      console.log(JSON.stringify(next, null, 2));
      return;
    }
    case "delete-run": {
      const repoPath = resolveRepoPath(args.flags);
      const runId = requireFlag(args.flags, "run-id");
      await deleteRun(repoPath, runId);
      console.log(JSON.stringify({ deleted: true, runId }, null, 2));
      return;
    }
    case "report": {
      const repoPath = resolveRepoPath(args.flags);
      const runId = requireFlag(args.flags, "run-id");
      const state = await readRunState(repoPath, runId);
      console.log([
        `Run ID: ${state.runId}`,
        `Project ID: ${state.projectId}`,
        `Repo: ${state.repoPath}`,
        `Phase: ${state.phase}`,
        `Status: ${state.status}`,
        `Check interval: ${state.settings.checkIntervalMs} ms`,
        `Planner turns: ${state.planner.turnCount}`,
        `Can execute: ${state.planner.canExecute}`,
        `Created: ${state.createdAt}`,
        `Updated: ${state.updatedAt}`,
        `Notes:`,
        ...state.notes.map((note) => `- ${note}`),
      ].join("\n"));
      return;
    }
    default:
      printHelp();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
