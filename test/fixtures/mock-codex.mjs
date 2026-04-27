import fs from "node:fs/promises";

const argv = process.argv.slice(2);
const outputPath = argv[argv.indexOf("--output-last-message") + 1];
const sandboxMode = argv[argv.indexOf("-s") + 1];
const plannerEphemeral = argv.includes("--ephemeral");
const promptArgIndex = argv.lastIndexOf("-");
const resumeIndex = argv.indexOf("resume");
const plannerSessionId = resumeIndex >= 0 && promptArgIndex > resumeIndex
  ? argv[promptArgIndex - 1]
  : "mock-thread-1";
const stdin = await new Promise((resolve) => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
  });
  process.stdin.on("end", () => {
    resolve(raw);
  });
});

async function incrementRetryCounter() {
  const counterPath = process.env.ORCH_MOCK_RETRY_FILE;
  if (!counterPath) {
    return 1;
  }
  let current = 0;
  try {
    current = Number.parseInt(await fs.readFile(counterPath, "utf8"), 10) || 0;
  } catch {
    current = 0;
  }
  const next = current + 1;
  await fs.writeFile(counterPath, String(next), "utf8");
  return next;
}

let response;

if (stdin.includes("Delay planner response for heartbeat test.")) {
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

if (stdin.includes("context maintenance worker inside Codex Agent Orchestrator")) {
  response = {
    maintained_summary: "Maintained context checkpoint: goal, accepted plan, execution state, and next step were compressed successfully.",
  };
  await fs.writeFile(outputPath, JSON.stringify(response, null, 2), "utf8");
  console.log("mock codex completed");
  process.exit(0);
}

if (stdin.includes("planner model inside Codex Agent Orchestrator")) {
  console.log(JSON.stringify({ type: "thread.started", thread_id: plannerSessionId }));
  console.log(JSON.stringify({ type: "turn.started" }));
  if (stdin.includes("Force planner failure for test.")) {
    console.error("mock planner failure");
    process.exit(1);
  }
  if (stdin.includes("Verify planner persistence mode.")) {
    response = {
      assistant_response: plannerEphemeral ? "planner persistence: ephemeral" : "planner persistence: durable",
      plan_complete: false,
      plan_update: null,
    };
  } else if (stdin.includes("Verify planner session resume.")) {
    response = {
      assistant_response: `planner session resume: ${plannerSessionId}`,
      plan_complete: false,
      plan_update: null,
    };
  } else if (stdin.includes("Build a long-running plan")) {
    response = {
      assistant_response: "I drafted a long-running supervision plan.",
      plan_complete: true,
      plan_update: {
        summary: "Supervise one long-running task until the next scheduled check completes it.",
        tasks: [
          {
            id: "task-1",
            title: "Monitor remote smoke loop",
            depends_on: [],
            task_mode: "long-running",
            worker_prompt: "Monitor a long-running task.",
            wait_range_ms: {
              min: 1,
              max: 20,
            },
          },
        ],
      },
    };
  } else if (stdin.includes("Build a two-step plan")) {
    response = {
      assistant_response: "I drafted a resumable two-step plan.",
      plan_complete: true,
      plan_update: {
        summary: "Execute two tasks in order.",
        tasks: [
          {
            id: "task-1",
            title: "First wait briefly",
            depends_on: [],
            worker_prompt: "Run the first resumable task.",
            wait_range_ms: {
              min: 1,
              max: 20,
            },
          },
          {
            id: "task-2",
            title: "Then finish second",
            depends_on: ["task-1"],
            worker_prompt: "Run the second resumable task.",
            wait_range_ms: {
              min: 1,
              max: 20,
            },
          },
        ],
      },
    };
  } else if (stdin.includes("Build a plan for task termination")) {
    response = {
      assistant_response: "I drafted a plan that waits long enough to test task termination.",
      plan_complete: true,
      plan_update: {
        summary: "Execute one task that enters a long wait and can be terminated by the operator.",
        tasks: [
          {
            id: "task-1",
            title: "Wait long enough for termination",
            depends_on: [],
            worker_prompt: "Wait for 200 ms and then complete the task.",
            wait_range_ms: {
              min: 1,
              max: 500,
            },
          },
        ],
      },
    };
  } else if (stdin.includes("Build a plan that is still under discussion")) {
    response = {
      assistant_response: "I drafted a candidate plan, but planning is not complete yet.",
      plan_complete: false,
      plan_update: {
        summary: "A candidate plan that should not freeze yet.",
        tasks: [
          {
            id: "task-1",
            title: "Candidate task",
            depends_on: [],
            worker_prompt: "Wait for 5 ms and then complete the task.",
            wait_range_ms: {
              min: 1,
              max: 20,
            },
          },
        ],
      },
    };
  } else if (stdin.includes("Build a plan")) {
    response = {
      assistant_response: "I drafted a first executable plan.",
      plan_complete: true,
      plan_update: {
        summary: "Execute one task that waits briefly and then completes.",
        tasks: [
          {
            id: "task-1",
            title: "Wait briefly",
            depends_on: [],
            worker_prompt: "Wait for 5 ms and then complete the task.",
            wait_range_ms: {
              min: 1,
              max: 20,
            },
          },
        ],
      },
    };
  } else {
    if (stdin.includes("Force internal API reconnect loop for test.")) {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        console.error(`API reconnect attempt ${attempt} failed`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise(() => {});
    }
    if (stdin.includes("Force planner API reconnect failure for test.")) {
      const attempt = await incrementRetryCounter();
      console.error(`API reconnect failed on planner attempt ${attempt}`);
      process.exit(1);
    }
    response = {
      assistant_response: "No plan changes in this turn.",
      plan_complete: false,
      plan_update: null,
    };
  }
} else {
  if (stdin.includes("Force task API reconnect failure for test.")) {
    const attempt = await incrementRetryCounter();
    console.error(`API reconnect failed on task attempt ${attempt}`);
    process.exit(1);
  }
  if (sandboxMode !== "workspace-write") {
    response = {
      summary: `Task worker requires workspace-write sandbox, got ${sandboxMode}.`,
      should_wait: false,
      wait_ms: 0,
      completed: false,
    };
    await fs.writeFile(outputPath, JSON.stringify(response, null, 2), "utf8");
    console.log("mock codex completed");
    process.exit(0);
  }
  if (stdin.includes("Run the first resumable task.")) {
    response = {
      summary: "First resumable task completed.",
      should_wait: true,
      wait_ms: 5,
      completed: true,
    };
  } else if (stdin.includes("Monitor a long-running task.")) {
    if (stdin.includes("Check iteration: 1")) {
      response = {
        summary: "Long-running task finished on the scheduled follow-up check.",
        should_wait: false,
        wait_ms: 0,
        completed: true,
      };
    } else {
      response = {
        summary: "Long-running task still running. Check again at the next interval.",
        should_wait: true,
        wait_ms: 0,
        completed: false,
      };
    }
  } else if (stdin.includes("Run the second resumable task.")) {
    response = {
      summary: "Second resumable task completed.",
      should_wait: true,
      wait_ms: 5,
      completed: true,
    };
  } else {
    if (stdin.includes("Wait for 200 ms and then complete the task.")) {
      response = {
        summary: "Task entered a long wait before completion.",
        should_wait: true,
        wait_ms: 200,
        completed: true,
      };
    } else
    response = {
      summary: "Task completed after a short wait.",
      should_wait: true,
      wait_ms: 5,
      completed: true,
    };
  }
}

await fs.writeFile(outputPath, JSON.stringify(response, null, 2), "utf8");
console.log("mock codex completed");
