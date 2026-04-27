# Codex Long-time Orchestrator

[中文](README.md)

`Codex Long-time Orchestrator` is a local orchestration layer for `Codex CLI`. It is built for engineering work that does not finish in a single model call: long-running tests, smoke checks, remote jobs, repeated log inspection, bug fixing, and re-execution over time.

The core problem behind this project is straightforward. `codex exec` is effective for starting work, but once a task enters waiting, polling, or long-running execution, the original session does not reliably wake itself up and continue the loop. This repository separates responsibilities so the model can focus on reasoning and execution, while a persistent host process handles waiting, wake-ups, state storage, and history presentation.

For users and stakeholders, the system behaves like a control surface for engineering experiment loops. You talk to the main agent in the browser, the agent plans and starts execution, the host process keeps the run alive during waiting periods, and the agent is invoked again later to inspect progress, fix issues, and continue the task. The full process is stored per project so it can be reviewed and reported clearly.

## What It Solves

This project is designed to solve four practical problems.

- A single `codex exec` call is not enough for long-running workflows.
- Once a task enters waiting, the model does not automatically come back to inspect progress.
- After several iterations, it becomes hard to explain what happened, where a run stopped, and why it failed.
- Teams need a continuous, replayable history when reviewing engineering experiments or reporting status.

Typical use cases include:

- pushing code to a server, launching tests, and checking logs at fixed intervals
- running smoke checks, training jobs, or other long-running tasks
- continuing execution while the main agent inspects new logs and fixes issues
- keeping multiple runs per project with complete history

## How It Works

This is not a single permanent Codex session. It is closer to a persistent host process that repeatedly invokes the model with the right context.

When you send a message in the web UI, the host loads the saved run context and starts a real `codex exec` call. When execution enters a waiting phase, the waiting is owned by the orchestrator instead of leaving a Codex process idle in the background. When the next check time arrives, the host wakes the model again so it can inspect the latest state, decide what to do next, and continue the loop.

That design gives three useful properties. First, the run history is stored on disk. Second, refreshing the browser does not lose execution state. Third, if the host process is interrupted, the system can decide whether to resume planning, continue execution, or start the next cycle from the saved state.

In the current implementation, the main agent and task workers no longer share the same context strategy. The main agent no longer runs in one-shot ephemeral mode. Instead, each run keeps a durable Codex planner session and later planner turns prefer `codex exec resume` so the same session can continue. Task workers stay short-lived, but for long-running tasks the host now injects execution checkpoints and deltas since the previous wake instead of forcing each wake-up to reconstruct context from loose history.

## Installation and First Start

The following is the recommended setup flow. Once it is done, you can use `orch` directly from any project directory.

1. Open this repository and install dependencies.

```bash
npm install
```

2. Build the CLI.

```bash
npm run build
```

3. Register `orch` in your local command line. In most cases, this only needs to be done once.

```bash
npm run link-cli
```

4. Verify that the local environment is ready.

```bash
npm run doctor
```

5. Move into the project you actually want to work on and start the orchestrator.

```bash
orch plan
```

This creates a new run, starts the local web server, opens the browser, and lands you in the planner page for the current project.

If you are not inside the target project directory, you can specify it explicitly:

```bash
orch plan --repo C:\path\to\your-project
```

If you are developing this repository itself instead of using it as a tool, you can also run:

```bash
npm run plan
```

## Day-to-Day Usage

In normal use, the flow is simple. Run `orch plan` inside a project, then talk to the main agent in the browser. When the system is idle, the main agent acts as the planner and helps shape a structured execution plan. During execution, the same main agent can continue answering progress questions, explain failures, and suggest the next step.

Once the draft is complete, click `Freeze Plan` to turn it into an execution plan. Then click `Start Execute` to hand the work to the background executor. The browser will keep showing run status, task status, events, waiting periods, and recent worker output. For long-running tasks, you can also configure a check interval so the system wakes the model again after a period of time instead of stopping after one wait.

The run history in the left sidebar prefers the topic from the first planning message for each run. That makes repeated attempts inside the same project easier to scan by intent instead of forcing you to recognize runs only by UUID.

If a task is already running or waiting and you know the current attempt should stop, the `Task Process` panel can terminate the selected task explicitly. That interrupts the current run execution and writes the operator stop reason back into task state and event history so the next planning or rerun step starts from an honest state.

If execution is interrupted, completed tasks remain recorded. The next time you open the run, you can continue planning or resume execution from the unfinished part.

## Common Commands

- start the main UI: `orch plan`
- start only the web server: `orch serve`
- inspect a run state: `orch status --run-id <run-id>`
- freeze the current draft: `orch freeze --run-id <run-id>`
- execute the frozen plan: `orch execute --run-id <run-id>`
- print a short report: `orch report --run-id <run-id>`
- cancel a run: `orch cancel --run-id <run-id>`
- delete a run: `orch delete-run --run-id <run-id>`

All of these commands use the current directory as the project directory by default. If you are outside the target project, add `--repo <path>`.

## Where Data Is Stored

Detailed run data is primarily stored inside the project directory rather than scattered across the user profile.

Each run is written under:

```text
.orchestrator/runs/<run-id>/
```

This contains state, events, planner history, draft versions, the frozen execution plan, and worker output for each task.

The run state also stores checkpoint summaries used for context management, including goal, plan, execution, and planner prompt compression metadata. Long-running task records keep their own checkpoint summary plus wake cursors so the next scheduled check can receive delta-based context.

By default, the user directory only stores a global project index:

```text
%USERPROFILE%\.codex\codex-agent-orchestrator\projects.json
```

If you set `ORCH_HOME`, that index will be written to the directory you specify.

## Current Scope and Limits

At this point, the project already has a usable main path. It supports starting directly from a project directory, browser-based planning, freezing an execution plan, background execution, preserved waiting state, continued conversation with the main agent during execution, and project-scoped run history.

It also includes practical engineering features such as model selection, concurrency limits, a configurable check interval for long-running tasks, task process inspection, truncated large logs in the UI, and resume behavior that skips already completed tasks.

That said, this is still not a fully validated production system. More advanced conflict-aware scheduling, stronger remote-job recovery, a fuller reviewer flow, stricter approval boundaries, and more mature filtering and comparison views still need work.

## Disclaimer

This project is still under active iteration. It already has a runnable, testable, and demonstrable main flow, but it has **not** been fully validated across every real-world business scenario. The README describes current intent and implemented capabilities, not a guarantee that every environment, repository, or remote execution setup is already stable.

If you plan to use it for formal experiments, pre-production validation, or external reporting, it is better to run an end-to-end trial in a controlled project first. When communicating externally, it should still be presented as an engineering tool under active development rather than a universally verified platform.

## Development

If you are continuing development on this repository itself, the most common commands are:

```bash
npm run build
npm test
npm run plan
```

The current test suite covers run scaffold creation, planner draft generation, freezing execution plans, background execution, settings persistence, periodic checks for long-running tasks, run deletion, interrupted-stream recovery, and several API behaviors. It is strong enough for daily iteration, but it is not a substitute for real scenario validation.
