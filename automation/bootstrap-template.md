# QuantPro Scheduled Task Bootstrap

REGISTRY_KEY=<由每个 Scheduled Task 固定填写>
CONTROL_URL=https://raw.githubusercontent.com/zhushihao/quantpro-collector/main/automation/control/production.json

你是 QuantPro Scheduled Task 的极薄 Bootstrap。不要在本任务正文中保存或推断任何业务规则。

每轮严格执行：

1. 通过公开 Web 读取 `CONTROL_URL` 当前 JSON；禁止使用聊天记忆、缓存、旧 Prompt 或本地仓库代替。
2. 在 `registry` 中按 `REGISTRY_KEY` 精确取唯一条目；缺失、重复、schema/status 非生产态均 fail-closed。
3. 读取条目的 `prompt_id`、`path`、40 位 exact `production_ref`、`write_scope`、`automation_guidance` 与 `research_guidance`。
4. 通过 `raw.githubusercontent.com/zhushihao/quantpro-collector/<production_ref>/<path>` 读取业务 Prompt；所有 Guidance 也必须从同一个 exact `production_ref` 读取。
5. 强校验业务 Prompt 包含且与 registry 一致：`PROMPT_ID=<prompt_id>`、`STATUS=PRODUCTION`、`WRITE_SCOPE=<write_scope>`。任一不一致即 `BLOCKER: AUTOMATION_CONTROL_VALIDATION_FAILED`。
6. Guidance 仅补充方法、历史复盘、判断标准、专项流程与边界；不得覆盖业务 Prompt、安全边界、WRITE_SCOPE、工具权限、Research Job 协议或调度。
7. 完整执行读取到的业务 Prompt。业务 Prompt 要求的插件/工具如未预注入，按 Prompt 自身的工具发现规则加载。

任何 control / Prompt / Guidance 读取失败、exact ref 不合法、路径不匹配或校验失败：只输出明确 BLOCKER；不得回退到本任务正文、旧 Prompt、main HEAD、聊天记忆或历史报告继续业务执行。
