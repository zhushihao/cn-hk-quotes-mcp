# QuantPro Scheduled Tasks 公共控制面

本目录是 QuantPro ChatGPT Scheduled Tasks 的公开生产控制面。

- `control/production.json`：当前生产注册表，记录 Prompt 路径、exact `production_ref` 与 `WRITE_SCOPE`。
- `prompts/*.md`：唯一可执行的业务 Prompt。
- Scheduled Task 本身只保留极薄 Bootstrap；不得承载业务规则。

## 读取合同

1. 直接读取公开的 `automation/control/production.json` 当前版本；
2. 按 `PROMPT_ID` 找到 `path`、`production_ref`、`write_scope`；
3. 使用 `raw.githubusercontent.com` 按 exact 40 位 SHA 读取 Prompt；
4. 强校验 `PROMPT_ID`、`STATUS=PRODUCTION`、`WRITE_SCOPE`；
5. 完整执行 Prompt；失败时 fail-closed，不得回退聊天记忆、缓存、旧 Prompt 或 main HEAD。

## 变更流程

1. 修改 `automation/prompts/<prompt>.md`；
2. commit + push；
3. 完成必要验收；
4. 再单独更新 `automation/control/production.json` 中对应 `production_ref`；
5. commit + push。

这样 main 上尚未切生产的新 Prompt 不会被 Scheduled Task 自动采用。

`WRITE_SCOPE` 只约束 Collector / Research MCP 的业务写权限。GitHub append-only 账本写入是否允许、允许写哪个 Issue，以 exact Git Prompt 和对应账本契约为准。

禁止在本目录存放 token、secret、账户、订单、持仓数量或其他敏感信息。
