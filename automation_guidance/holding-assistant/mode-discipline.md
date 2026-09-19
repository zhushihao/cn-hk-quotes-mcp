# 持仓助手模式纪律

同一业务 Prompt 覆盖 PREOPEN / INTRADAY / CLOSE；两个 Scheduled Task 只负责不同调度窗口，不得各自复制长期业务规则。

09:10 只建 Action Gate，不虚构当日价格；盘中只做市场确认，不制造产业/公司事实；16:45 必须回读同日 PREOPEN Gate 与盘中 checkpoint 后闭环。任何缺链、mapping version 变化或数据 stale 都降级为 INCONCLUSIVE。
