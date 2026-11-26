# 跨 Agent 交接单（Handoffs）

本目录用于存放**一任务一文件**的跨 Agent 详细交接单，避免多个并行分支在 [docs/team-status.md](../team-status.md) 中堆积长段过程日志而引发 Git 合并冲突。

## 使用约定

1. **何时创建**：
   - 当某任务需要另一环境的 Agent 接力补端或本地验证（例如 `linux-agent` 完成 Spec + Web + Android 与 Swift 代码，需 `macos-agent` 跑 Xcode / iOS Simulator 验收）；
   - 或某项长任务暂停/转交，需要向下一个会话传递完整的上下文与踩坑记录。
2. **文件命名**：`<Task-ID>-<short-slug>.md`（例如 `T-002-media-preview.md`）。
3. **联动看板**：创建交接单后，在 [docs/team-status.md](../team-status.md) 的「进行中与已认领任务」将状态置为 `handoff-needed`，并在「跨 Agent 交接队列」添加一行指向该文件的链接。
4. **收尾清理**：任务全部验证并合入 `main` 后，由收尾 Agent 删除对应交接单文件，并将任务移入看板的「近期已完成」。

---

## 交接单模板

```markdown
# <Task ID> · <任务标题> 交接单

- **发起方**：`<agent / 环境角色，如 linux-agent (antigravity)>`
- **目标接力方**：`<macos-agent / linux-agent / any>`
- **分支 / PR / Issue**：`<branch> · PR #xx · Refs #xx`
- **独占 Scope**：`<文件或目录列表>`
- **更新时间**：`YYYY-MM-DD`

## 1. 已完成项
- [x] ...

## 2. 待接力 / 未验证项
- [ ] ...

## 3. 关键实现决策与注意点
- ...

## 4. 复现与验证命令
```sh
# 接力方可直接执行的检查命令
```
```
