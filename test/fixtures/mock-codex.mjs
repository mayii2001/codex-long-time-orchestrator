import fs from "node:fs/promises";

const argv = process.argv.slice(2);
const outputPath = argv[argv.indexOf("--output-last-message") + 1];
const sandboxMode = argv[argv.indexOf("-s") + 1];
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

let response;

if (stdin.includes("planner model inside Codex Agent Orchestrator")) {
  if (stdin.includes("Force planner failure for test.")) {
    console.error("mock planner failure");
    process.exit(1);
  }
  if (stdin.includes("Build a long-running plan")) {
    response = {
      assistant_response: "I drafted a long-running supervision plan.",
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
  } else if (stdin.includes("Build a plan")) {
    response = {
      assistant_response: "I drafted a first executable plan.",
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
    response = {
      assistant_response: "No plan changes in this turn.",
      plan_update: null,
    };
  }
} else {
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
