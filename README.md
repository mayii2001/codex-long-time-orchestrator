# Codex Long-time Orchestrator

`Codex Long-time Orchestrator` 是一个把 `Codex CLI` 接到长时间工作流里的本地编排器。它面向的不是一次性问答，而是那类真正会持续几十分钟、几小时，甚至需要反复检查日志、修复问题、重新执行的工程任务。

 `codex` 流程进入等待、轮询、远端任务、长时间测试或 smoke 检查时，原来的会话容易中断且无法定时唤醒继续TDD。这个项目的目标，就是把“模型负责思考和执行”与“宿主进程负责等待、唤起、保存状态和展示历史”拆开，让任务能够持续跑下去，而不是停在某一次超时之后。

对使用者来说，可以把它理解成一个面向工程实验循环的控制台。你在网页里和主 agent 对话，主 agent 生成计划、启动执行、在等待周期里再次被唤起检查进度、决定是否修代码或继续跑。所有这些过程都会按项目留下历史记录，便于复盘和汇报。

`Codex Long-time Orchestrator` is a local orchestrator that integrates `Codex CLI` into long-term workflows. It is not designed for one-off queries, but rather for engineering tasks that typically last for several minutes, hours, or even require repeated log checking, issue resolution, and re-execution. When the `codex` process enters waiting, polling, remote tasks, long-term testing, or smoke checks, the original session is prone to interruption and cannot be awakened to continue TDD at a fixed interval. The goal of this project is to separate "the model responsible for thinking and executing" from "the host process responsible for waiting, awakening, saving state, and presenting history", allowing the task to continue running rather than stopping after a certain timeout. For users, it can be understood as a console for engineering experimentation cycles. You interact with the main agent through the web page, and the main agent generates plans, initiates execution, is awakened again during the waiting period to check progress, and decides whether to fix the code or continue running. All these processes will leave a historical record for the project, facilitating review and reporting.

## 它解决什么问题

这个项目主要解决四类问题。

- 一次性 `codex exec` 很难覆盖长时间任务。
- 任务进入等待后，模型不会自动回来检查进度。
- 多轮实验之后，很难清楚知道某个项目到底跑到了哪里、失败在什么地方。
- 需要给团队或管理者说明过程时，缺少连续、可回放的执行记录。

它适合的典型场景包括：

- 推送代码到服务器后启动远端测试，再按固定间隔检查日志
- 跑 smoke、训练、批处理或其他长时间任务
- 一边执行，一边让主 agent 根据新日志继续定位问题和修复
- 在同一个项目里多次反复尝试不同方案，并保留完整 run 历史

## 它如何工作

本系统不是一个永远挂着的超长 Codex 会话。它的工作方式更像一个常驻宿主去反复调用模型。

当你在网页里发送一条消息时，宿主会读取当前 run 已保存的上下文，再发起一次真实的 `codex exec`。当执行进入等待期时，等待由 orchestrator 自己持有，而不是让某个 Codex 进程在后台无意义地挂着。等到下一次检查时间到了，宿主再重新唤起模型，让它基于最新状态继续判断、修复或推进任务。

这带来三个直接结果。第一，任务历史是完整落盘的。第二，浏览器刷新不会丢执行状态。第三，即使宿主进程中断，系统也能根据已保存状态决定是继续规划、恢复执行，还是重新发起下一轮。

## 安装与第一次启动

下面这组步骤是推荐的标准安装流程。第一次做完之后，后续在任何项目目录里都可以直接使用 `orch`。

1. 进入本仓库目录，安装依赖。

```bash
npm install
```

2. 编译 CLI。

```bash
npm run build
```

3. 把 `orch` 注册到当前机器的命令行。这个步骤通常只需要做一次。

```bash
npm run link-cli
```

4. 检查本机环境是否正常。

```bash
npm run doctor
```

5. 切换到你真正想工作的项目目录，直接启动 orchestrator。

```bash
orch plan
```

这条命令会立即创建一个新的 run、启动本地网页服务、自动打开浏览器，并把你带到当前项目的主界面。

如果你此时不在目标项目目录里，也可以显式指定：

```bash
orch plan --repo C:\path\to\your-project
```

如果你正在开发这个仓库本身，而不是把它当工具使用，也可以在仓库内直接运行：

```bash
npm run plan
```

## 日常使用

日常使用时，流程通常很简单。你在项目目录里执行 `orch plan`，然后在网页里和主 agent 对话。主 agent 会在空闲时承担 planner 角色，帮助你把任务整理成结构化计划；在执行中，它会继续回答当前进度、失败原因和下一步建议。

当右侧 draft 已经完整时，你点击 `Freeze Plan`，把当前草稿冻结成执行计划。随后点击 `Start Execute`，任务就会进入后台执行。网页会持续显示 run 状态、task 状态、事件流、等待时间和最近的 worker 产物。对长时间任务来说，你还可以设置检查间隔，让系统在等待一段时间后主动再次唤起模型检查进度，而不是停在某次等待之后。

如果执行被中断，系统会保留已完成 task 的状态。下一次重新进入这个 run 时，你可以继续规划，也可以直接重新发起执行，让系统从未完成部分继续往下跑。

## 常用命令

最常用的命令只有几条。

- 启动主界面：`orch plan`
- 只启动网页服务：`orch serve`
- 查看某个 run 的状态：`orch status --run-id <run-id>`
- 冻结当前草稿：`orch freeze --run-id <run-id>`
- 执行当前冻结计划：`orch execute --run-id <run-id>`
- 输出简要报告：`orch report --run-id <run-id>`
- 取消 run：`orch cancel --run-id <run-id>`
- 删除 run：`orch delete-run --run-id <run-id>`

这些命令默认都以当前目录作为项目目录。如果你不在目标项目里，再补上 `--repo <path>` 即可。

## 数据会存到哪里

这个项目的详细运行数据主要存放在项目目录内部，而不是分散写到用户目录的各个角落。

每个 run 都会写在：

```text
.orchestrator/runs/<run-id>/
```

这里会保存状态、事件、planner 历史、draft 版本、冻结后的执行计划，以及各个 task 的 worker 输出。

用户目录里默认只会额外维护一份全局项目索引：

```text
%USERPROFILE%\.codex\codex-agent-orchestrator\projects.json
```

如果你设置了 `ORCH_HOME`，这个索引会改写到你指定的目录。

## 当前的局限性

到目前为止，这个项目已经具备一条可用的主链路。它支持从项目目录直接启动、网页对话式规划、冻结执行计划、后台执行、等待期状态保存、执行中继续与主 agent 交流，以及按项目查看历史 run。

它也已经支持一些更实际的工程细节，比如模型选择、并发数上限、长时间任务的检查间隔、任务过程查看、超长日志截断显示，以及执行失败后基于已完成 task 的续跑。

但它依然不是一个已经充分验证过的成熟产品。更复杂的多任务冲突调度、远端任务恢复、完整 reviewer 流程、更细的权限和审批链路，以及更强的筛选和对比视图，仍然需要继续补强。

## 免责声明

这个项目目前仍处在持续迭代阶段。它已经有一套可运行、可测试、可演示的主流程，但**没有经过所有真实业务场景的完整验证**。README 中描述的是当前实现意图和已完成能力，不应被理解为对所有环境、所有仓库、所有远端执行场景都已经稳定适配。

如果你准备把它用于正式实验、生产前验证或对外汇报，建议先在受控项目里完成一轮端到端试跑，再决定是否扩展到更高风险的任务。对外沟通时，也应明确说明它当前属于工程化中的实验性工具，而不是已经完成全面验证的通用平台。

## 开发说明

如果你要继续开发这个仓库本身，最常用的命令是：

```bash
npm run build
npm test
npm run plan
```

当前测试已经覆盖 run scaffold、planner 生成 draft、冻结执行计划、后台执行、设置保存、长任务定期检查、历史删除、断流恢复和若干 API 行为。它足够支撑日常迭代，但还不足以替代真实场景验证。
