# 跨 Agent 交接单（Handoffs）

本目录用于存放**一任务一文件**的跨 Agent 详细交接单（长上下文），与置顶 GitHub Issue **[#41](https://github.com/Josp3r/open-jsbridge/issues/41)**（实时控制面）配合使用，避免并行分支修改共享文件产生 Git 合并冲突。

## 使用约定

1. **何时创建**：
   - 当某任务需要另一环境的 Agent 接力补端或本地验证（例如 `linux-agent` 完成 Spec + Web + Android 与 Swift 代码，需 `macos-agent` 跑 Xcode / iOS Simulator 验收）；
   - 或某项长任务暂停/转交，需要向下一个会话传递完整的上下文与踩坑记录。
2. **文件命名**：`pr-<num>-<short-slug>.md` 或 `issue-<num>-<short-slug>.md`（例如 `pr-42-media-preview.md`）。
3. **联动实时控制面**：创建交接单后，在置顶 Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41) 追加一条 `### HANDOFF · PR #xx · <from> → <to-role>` 评论并附上本文件路径。
4. **收尾清理**：任务全部验证并合入 `main` 后，由收尾 Agent 删除对应交接单文件，并在 Issue `#41` 补发 `### DONE` 评论。

---

## 交接单模板

```markdown
# PR #xx · <任务标题> 交接单

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
