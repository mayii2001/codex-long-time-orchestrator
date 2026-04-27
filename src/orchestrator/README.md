# Orchestrator

这里负责：

- run 状态模型
- `.orchestrator/runs/<run-id>/` 落盘
- run scaffold 初始化
- 状态读写和事件追加
- 执行器心跳与执行活性判断
- 区分 planner 只读执行与 task worker 可写执行
- 主 agent 的持久 planner session，以及同一 task 多轮 exec 对自身 session 的 resume 复用
- planner turn 的 abort controller 管理，以及浏览器断流后的自动清理
- ContextAssembler 分层组装 planner / task prompt
- run checkpoint 与长任务 delta wake context 的持久化

这里是编排器唯一真实状态源。
