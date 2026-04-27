# UI

这里放本地监控面板的静态资源。

当前页面负责：

- 项目列表和 run 历史
- run 历史默认显示首次 plan 主题，便于按意图回看
- 删除当前 run
- 主 agent 对话
- 空闲时兼 planner，执行中可继续问进度
- 对 streaming planner turn 提供显式中断按钮
- planner 模型、task 模型、最大 agent 数和检查间隔秒数配置
- draft 与事件流查看
- task 状态、当前动作和等待时间显示
- 点击 task 查看子 worker 进程产物
- 对 running / waiting task 提供显式终止按钮
- 自动轮询和 planner 流式过程展示
- 浏览器流式连接断开时自动请求后端停止当前 planner turn，避免界面卡在运行中
- 历史面板按版本和计数增量刷新，不做每秒全量重拉
- task 进程日志按点击加载，超长输出只展示尾部截断内容

这里不维护独立状态真相，只消费后端 run 状态和历史文件。
