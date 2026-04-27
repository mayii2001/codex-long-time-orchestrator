# Orchestrator

这里负责：

- run 状态模型
- `.orchestrator/runs/<run-id>/` 落盘
- run scaffold 初始化
- 状态读写和事件追加
- 执行器心跳与执行活性判断
- 区分 planner 只读执行与 task worker 可写执行

这里是编排器唯一真实状态源。
