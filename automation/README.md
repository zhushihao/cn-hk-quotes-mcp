# QuantPro Scheduled Tasks 公共控制面

本目录是 QuantPro ChatGPT Scheduled Tasks 的公开生产控制面。

- `control/production.json`：当前生产注册表，按 Scheduled Task 的固定 `REGISTRY_KEY` 记录 Prompt 路径、exact `production_ref`、`WRITE_SCOPE` 与 Guidance 路径。
- `prompts/*.md`：唯一可执行的业务 Prompt。
- `../automation_guidance/` / `../research_guidance/`：只补充方法、复盘、判断标准与专项规则；不得覆盖 Prompt、安全边界、WRITE_SCOPE、工具权限、Research Job 协议或调度。
- `bootstrap-template.md`：Scheduled Task 唯一允许保留的薄 Bootstrap 模板；任务本身不得承载业务规则。

## 读取合同

1. 直接读取公开的 `automation/control/production.json` 当前版本；
2. 按 Scheduled Task 固定的 `REGISTRY_KEY` 找到 `prompt_id`、`path`、`production_ref`、`write_scope` 与 Guidance 路径；
3. 使用 `raw.githubusercontent.com` 按 exact 40 位 SHA 读取 Prompt 及所有 Guidance；
4. 强校验 Prompt 中的 `PROMPT_ID`、`STATUS=PRODUCTION`、`WRITE_SCOPE`，并校验所有 Guidance 都来自同一 exact SHA；
5. 完整执行 Prompt，并把 Guidance 仅作为补充约束；任一读取/校验失败都 fail-closed，不得回退聊天记忆、缓存、旧 Prompt 或 main HEAD。

## 变更流程

1. 修改 `automation/prompts/<prompt>.md`；
2. commit + push；
3. 完成必要验收；
4. 再单独更新 `automation/control/production.json` 中对应 `production_ref`；
5. commit + push。

这样 main 上尚未切生产的新 Prompt 不会被 Scheduled Task 自动采用。
同一业务 Prompt 可以被多个 registry key 复用；例如持仓助手的盘中任务与盘前+收盘任务共享同一个 mode-aware Prompt，但拥有不同调度与独立 Bootstrap key。

`WRITE_SCOPE` 只约束 Collector / Research MCP 的业务写权限。GitHub append-only 账本写入是否允许、允许写哪个 Issue，以 exact Git Prompt 和对应账本契约为准。

禁止在本目录存放 token、secret、账户、订单、持仓数量或其他敏感信息。
