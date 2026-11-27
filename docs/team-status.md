# 多 Agent 团队基线与共享决策（Team Status）

> 协作规范与工程红线见根目录 [AGENTS.md](../AGENTS.md)。
>
> **实时认领锁、热点文件锁与跨端交接队列已迁移至置顶 GitHub Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41)**（秒级可见，Append-only 评论流，消除 `main` 合入前窗口期）。开工前请运行：
> ```sh
> gh issue view 41 -R Josp3r/open-jsbridge --comments
> gh pr list -R Josp3r/open-jsbridge --state open --limit 20
> ```
> 本文件专注沉淀**持久化团队信息**：当前基线、环境能力矩阵、三端能力对齐矩阵、待认领候选池、待决议事项、共享决策/避坑清单与近期已完成里程碑。
>
> **维护约定**：每合入一个改变能力边界或候选池的功能 PR 后，收尾 Agent 应顺手（或在下一个文档 PR 中）同步本文件 §1、§3、§4、§7，避免后续会话认领已完成的任务。

---

## 1. 当前基线快照（Baseline Snapshot）

- **最新主干基线**：`main` @ `328cc7b`（最后更新日期：`2026-11-27`）
- **本地验证基线**（`linux-agent`）：`npm test` 236/236、`dart run test/all_tests.dart` 66/66、`npm run codegen:check` 通过、`npm run pack:web` 生成 `dist/open-jsbridge-web-1.0.0.tgz`、`npm run size:web` 观测输出（非阻断，见 `D-011`）
- **版本线状态**：
  - 协议版本 `jsb`：**`1.0`（Frozen，#70）**
  - 三端 SDK（Web `@open-jsbridge/web`、iOS SwiftPM `NativeIOSHost`、Android Maven `io.github.josp3r:open-jsbridge-android`）版本号均已对齐 **`1.0.0`**，待维护者执行正式发版与打标（见 [docs/native-release.md](native-release.md)）
  - **1.0 退出标准进展（见 [TODO.md](../TODO.md) 与 `D-013`）**：协议冻结 ✅、能力三端对齐 ✅、M0/M1 原生回归 ✅、Android 11 API 30 Photo Picker CI 替代验收 ✅、体积非阻断拍板 ✅；仅剩 **维护者执行三端 `1.0.0` 正式发版**。
- **v1 标准能力（三端已合入 `main`）**：
  - 方法：`device.getInfo@1`、`network.getStatus@1`、`ui.toast.show@1`、`media.chooseMedia@1`、`media.release@1`、`transfer.upload@1`
  - 控制/流式：`bridge.progress`
  - 事件：`network.statusChanged`、`app.foregrounded`、`app.backgrounded`
- **Web SDK 子路径**：`/auto`、`/app`、`/device`、`/network`、`/ui`、`/media`、`/transfer`、`/reverse`、`/fallback`、`/mock`
- **仓内参考实现（不随 1.0 单独发布）**：`packages/host-core`、`packages/devtools`、`packages/react-native`、`packages/codegen`、`packages/flutter`（`publish_to: none`，已接入 CI `Flutter Dart host` #63）
- **当前发版 / 验收跟进项**：
  - Android 10–12（API 30–32）Photo Picker 替代验收已由 CI `Android 11 Photo Picker Compat`（API 30，#66）覆盖（见 `D-014`）。
- **主干活跃 Issue**：
  - `#41`：**置顶多 Agent 实时认领锁与跨端交接控制面**
  - `#21`：v1 标准能力集（首批能力与后续准入审批）
  - `#24`：媒体句柄 + 原生上传（选图、主动释放、进度回调、单图前台上传已三端落地；预览推迟至 1.0 后）

---

## 2. Agent 角色与环境能力矩阵

不同会话具备不同工具链，在 Issue `#41` 认领任务或发起交接时请使用下表中的角色标识：

| 角色标识 | 典型会话 / 环境 | 可本地验证范围 | 局限与交接约定 |
|---|---|---|---|
| `macos-agent` | 本地 macOS（如 Codex worktree + Xcode） | Web/Mock、SwiftPM、iOS Release Simulator、Xcode 真机、Android JVM | 负责 iOS 编译/模拟器验收与双端发版验收 |
| `linux-agent` | 云端 Ubuntu 24.04（如 Antigravity VM） | Spec、Web SDK/Mock、Codegen、Conformance、Android JVM/Gradle、Dart/Flutter、GitHub CLI | 无本地 Swift/Xcode；涉及 Swift 改动时靠 GitHub Actions CI 或在 `#41` 发起 `HANDOFF` 给 `macos-agent` |
| `other-agent` | 其他会话环境 | 按实际可用工具链在认领时注明 | 严格遵循 `AGENTS.md` 中的诚实验证原则 |

---

## 3. 三端能力对齐矩阵（Parity Matrix）

> `✅` 已合入 `main`；`🚧` 部分完成或进行中；`—` 未实现。Web 侧能力能否使用仍以握手声明为准，原生宿主未实现时不会声明对应能力。

| 能力 | Web SDK | Mock / `host-core` | iOS 参考宿主 | Android 参考宿主 | 备注 |
|---|---|---|---|---|---|
| 首批 7 项 v1 能力 | ✅ | ✅ | ✅ | ✅ | `0.2.0` |
| `media.release@1` | ✅ #56 | ✅ #56 | ✅ #55 | ✅ #57 | #49 契约 |
| `bridge.progress` 流式回调 | ✅ #38 | ✅ #38 | ✅ #62 | ✅ #61 | Flutter 已于 #45 实现 |
| Host → Web 反向调用（§9.2） | ✅ #46（`/reverse`） | ✅ #46 | — | — | 推迟至 1.0 后（Flutter / RN 经 host-core 支持） |
| `transfer.upload@1` | ✅ #58（`/transfer`） | ✅ #58 | ✅ #65 | ✅ #67 | 三端对齐完成（RFC #44） |
| `rules` ACL / 限流（§11.3） | n/a | ✅ #54 | — | — | 推迟至 1.0 后（原生宿主仍只支持精确 HTTPS origin 白名单） |
| `media.preview@1` | — | — | — | — | 推迟至 1.0 后（无契约） |

---

## 4. 待认领候选池（Backlog / Ready to Claim）

> **停止扩张规则（见 [AGENTS.md](../AGENTS.md) §2.5）**：当前 **1.0 必选开发与测试项已全部完成，候选池无任何 `高` 优先级项**。在维护者完成 M0 协议冻结、1.0 发版或明确指派新任务（bugfix / 安全修复 / 平台兼容修复）前，所有 Agent **MUST 停止开新功能任务**，仅在 Issue [#41](https://github.com/Josp3r/open-jsbridge/issues/41) 报告空闲。下表「推迟至 1.0 后」条目未经维护者明确批准不得认领。

| 候选方向 | 优先级 | 建议角色 | 预估主要 Scope | 关联来源 / 说明 |
|---|---|---|---|---|
| `media.preview@1` 契约与实现 | 推迟至 1.0 后 | — | `spec/methods/media/**`、双端宿主 | 见 `D-013`：不进 1.0，达标发版后按需并经维护者审批启动 |
| 原生反向调用（§9.2） | 推迟至 1.0 后 | — | 双端宿主会话层 | 见 `D-013`：不进 1.0；握手按能力声明，不影响兼容 |
| 下一批标准能力（`ui.dialog.confirm` / `clipboard.*` / `permissions.getState` / `media.scan.qr`） | 推迟至 1.0 后 | — | `spec/methods/**`、`packages/web-sdk/**`、双端宿主 | 见 `D-012`、`D-013`：须先在 `#21` 通过四问并获维护者批准 |
| 原生 `rules` ACL / 原生 iframe 文档绑定 | 推迟至 1.0 后 | — | 双端宿主安全与生命周期模块 | 见 `D-013`：不进 1.0 |

---

## 5. 待决议事项（Open Decisions）

> 当前无阻塞中的待决议事项（此前 `O-001`～`O-004` 均已于 `2026-11-27` 拍板并转入下方 `D-011`～`D-014`；`jsb 1.0` 协议规范已于 `2026-11-27` 冻结）。
> 唯一剩余人工收尾项：维护者执行三端 `1.0.0` 正式发版（npm / SwiftPM 标签 / Maven Central），发版后按 `D-013` 转入维护模式。

---

## 6. 共享决策与避坑清单（Shared Decisions & Gotchas）

> 记录已拍板的架构结论和真实踩坑经验，供所有新会话直接复用；新增条目请附日期与来源 PR/Issue。

- **[D-001 | 2026-11-25 | #24, #29] 媒体首版走主 frame RPC 回传有界缩略图，不引入原生 URL Scheme Handler**
  - `WKURLSchemeTask` 与 Android `WebResourceRequest` 在图片子资源请求中缺少可认证的发起 frame/document 会话元数据。
  - 首版 `media.chooseMedia@1` 统一在已验证的主 frame RPC 响应中返回 `id`（128-bit 32 位小写 hex 句柄）与 `thumbnailBase64`（JPEG 长边 ≤ 256 px、解码后 ≤ 32 KiB），Web SDK 转换为 `blob:` `thumbUrl` 并在过期/`pagehide`/`close()` 时撤销。原图留在宿主（5 分钟 / 20 MiB 上限）。
- **[D-002 | 2026-11-25 | #21, #28] 方法与事件命名冻结基线**
  - 新增标准能力方法使用 `domain.verbNoun`（已有 `ui.toast.show` 保留原名）。
  - 标准事件使用「名词 + 过去分词」（如 `network.statusChanged`），命名空间已指明主语时可用过去分词（`app.foregrounded`、`app.backgrounded`）。旧事件名 `network.changed` 已直接删除，禁止回退或混用。
  - `request`、WebSocket、Canvas 不进桥；支付、登录等走厂商命名空间（如 `wechat.pay.request`）；官方仓不维护第三方方言兼容包（见 `D-010`）。
- **[D-003 | 2026-11-25 | #30] 安全来源与 JSON 键名保留约束**
  - 参考宿主仅支持一个或多个**精确 HTTPS origin**（`https://host[:port]`），禁止前缀/子串匹配；`rules` JSON 细粒度 ACL 仍属未实现的可选提案。
  - 解码器仅过滤任意层级的 `__proto__` 字段，**必须保留 `constructor` 与 `prototype` 等业务 JSON 键名**。
  - 编码器在入队前做严格 JSON 快照，拒绝 `Date`、访问器、稀疏数组、循环引用、超出安全整数范围的数字等非标准 JSON 值（`-32600` / `-32602`）。
  - **补充（2026-11-26 · #54）**：`rules` JSON（含 `rateLimit` 与权限链异常隔离 `SEC-ACL-ERROR-001`）已在 TypeScript 参考 `packages/host-core`（`createAclPolicy`）实现；**iOS / Android 原生参考宿主仍未实现**，上述精确 origin 约束对原生宿主继续有效。
- **[D-004 | 2026-11-26 | #19, #27, #31] Web SDK 包边界约定**
  - 仅发布 ESM + TypeScript 声明，零运行时依赖；主入口 `@open-jsbridge/web` 只导出 `createBridge` 与核心类型/错误码，不自动初始化默认单例（默认单例在 `@open-jsbridge/web/auto`，按需能力在 `/app`、`/device`、`/network`、`/ui`、`/media`、`/transfer`、`/reverse`、`/fallback`、`/mock`）。
  - 体积硬门禁已于 `2026-11-27` 调整为非阻断观测输出（见 `D-011`）。
- **[D-005 | 2026-11-25 | #29] Android Photo Picker 兼容策略**
  - 选图强制使用 iOS PHPicker / AndroidX `PickVisualMedia`，禁止为选图申请整库相册权限。
  - Android API 24–32 若设备缺少系统或已安装的 Photo Picker 回移版本，握手时**不声明** `media.chooseMedia`；回移配置由接入 App 自行声明（见 [docs/native-android.md](native-android.md)）。
- **[D-006 | 长期约束] 文档内 Shim 代码块受单测保护**
  - `conformance-tests/shim-docs.test.mjs` 会直接解析并执行 `docs/native-ios.md`、`docs/native-android.md`、`docs/flutter.md` 中的 `js` 代码块；调整这三个文档示例时务必运行 `npm test`。
- **[D-007 | 2026-11-26 | #33 已修复] npm 12 下 `scripts/pack-web.mjs` 兼容问题**
  - npm `12.x` 下 `npm pack --json` 返回按包名索引的对象映射而非数组；`#33` 已在 `scripts/pack-web.mjs` 兼容 npm ≤ 11 数组与 npm 12+ 对象两种格式。
- **[D-008 | 2026-11-26 | #34] `spec/` 修改必须同步 TS Codegen**
  - 新增或修改 `spec/schemas/`、`spec/methods/` 或 `spec/protocol/errors.json` 后，必须运行 `npm run codegen:ts` 更新 `packages/web-sdk/src/generated/spec.ts`，CI 已接入 `npm run codegen:check` 拦截漂移与不合规 schema。
- **[D-009 | 2026-11-26 | #41] 实时认领锁与交接走置顶 GitHub Issue `#41`**
  - 为彻底消除 `main` 分支合入前的可见性 Gap 及并行 PR 对 `docs/team-status.md` 的合并冲突，所有瞬态 `CLAIM` / `HANDOFF` / `DONE` / `RELEASE` 统一以 Append-only 评论发到 Issue `#41`（60m TTL + Comment ID 乐观锁仲裁），本文件仅保留持久化基线、候选池与共享决策。
- **[D-010 | 2026-11-26 | #50 Revert] 官方仓库不维护第三方方言兼容包（如 `wx-compat`）**
  - 为保持 Open JSBridge 单一标准心智、避免给开发者造成「多套规范并存」或「兼容微信全量运行时」的误解，官方仓库不提供 `wx-compat` 一类第三方方言封装包；有存量迁移需求的接入方可在自有业务仓或外部社区自行封装异步薄层。
- **[D-011 | 2026-11-27 | 原 O-001] Web SDK 主入口体积门禁改为非阻断观测输出**
  - 维护者拍板：当前约 7 KiB 的主入口体积并非实际瓶颈，不再作为硬阻断门禁；`scripts/check-web-size.mjs`（`npm run size:web`）保留在 CI 中输出 min+gzip 字节数供观测，不再因超过 7168 bytes 返回非零退出码。零运行时依赖与 ESM-only 红线继续有效。
- **[D-012 | 2026-11-27 | 原 O-002] 新增包/子路径/命名空间须维护者预先批准 + Agent 停止规则**
  - 新增 `packages/*`、新增 `@open-jsbridge/web/*` 子路径或新增标准能力命名空间前，须先在 Issue 获维护者批准；候选池无 `高` 优先级项且待决议事项无新结论时，Agent 停止主动开新任务，仅在 `#41` 报空闲（已写入 [AGENTS.md](../AGENTS.md) §2.5）。
- **[D-013 | 2026-11-27 | 原 O-003] 1.0 退出标准与维护模式范围拍板**
  - 1.0 能力范围锁定为：首批 7 项 + `media.release@1` + `bridge.progress` + `transfer.upload@1` 三端对齐；`media.preview`、下一批标准能力、原生 `rules` ACL、原生反向调用、iframe 均明确不进 1.0，Flutter / RN / devtools 继续作为仓内参考实现不单独发版。达标并完成三端正式发版后转入维护模式（详见 [TODO.md](../TODO.md)）。
- **[D-014 | 2026-11-27 | 原 O-004] Android 10–12 Photo Picker 验收改由模拟器 / CI 替代**
  - 不以物理真机阻塞 Android Maven Central 正式发版；通过补齐 Android 10–12（API 30–32）模拟器 / CI 验证覆盖系统 Photo Picker 缺失/可用探测与能力声明行为。

---

## 7. 近期已完成（Recently Completed）

> 仅保留近期关键里程碑条目，完整历史见 `git log` 与 [CHANGELOG.md](../CHANGELOG.md)。

| 完成日期 | 摘要 | PR / Commit |
|---|---|---|
| 2026-11-27 | 对齐三端 `1.0.0` 版本号、整理 `CHANGELOG.md` 与 `docs/native-release.md` | `#71` (`133ffbc`) |
| 2026-11-27 | 冻结 `jsb: 1.0` 协议规范并勾选 M0 评审项 | `#70` (`328cc7b`) |
| 2026-11-27 | Android M0 回退通道关闭回归测试（`SEC-JSI-DEFAULT-001`）与 1.0 看板收口 | `#69` (`500cb88`) |
| 2026-11-27 | Android 原生 `transfer.upload@1` 前台单图上传与 RPC 注册（三端对齐完成） | `#67` (`a0eff27`) |
| 2026-11-27 | iOS M0 权限链异常隔离回归单测（`SEC-ACL-ERROR-001`） | `#68` (`bc18787`) |
| 2026-11-27 | iOS 原生 `transfer.upload@1` 前台单图上传与 RPC 注册 | `#65` (`ef0ea9f`) |
| 2026-11-27 | Android 11（API 30）Photo Picker 兼容仪器测试与 CI 替代验收（`D-014`） | `#66` (`8414141`) |
| 2026-11-27 | 确立 1.0 退出标准、Agent 停止规则与 O-001～O-004 拍板（`D-011`–`D-014`） | `#64` (`b17f584`) |
| 2026-11-27 | Flutter Dart 静态分析与 66 项测试接入 CI（`Flutter Dart host`） | `#63` (`46cc74b`) |
| 2026-11-27 | Android 原生 `bridge.progress` 进度回调发送端 | `#61` (`fbae0a2`) |
| 2026-11-27 | iOS 原生 `bridge.progress` 进度回调发送端 | `#62` (`07c686f`) |
| 2026-11-26 | 同步规划与治理文档（`team-status.md`、`TODO.md`、`CHANGELOG.md`） | `#60` (`c29c13e`) |
| 2026-11-26 | Android 前台上传图片预处理（`AndroidUploadImage.kt` + 单测/真机测试） | `#59` (`60258e3`) |
| 2026-11-26 | iOS 参考宿主接入 `media.release@1`（批量释放、会话配额回收） | `#55` (`a56de2c`) |
| 2026-11-26 | Android 参考宿主接入 `media.release@1` | `#57` (`b1393f9`) |
| 2026-11-26 | `transfer.upload@1` Schema、`@open-jsbridge/web/transfer` 与 Mock `uploadMedia` | `#58` (`915256b`) |
| 2026-11-26 | Web `/media` 与 Mock 支持 `media.release@1` | `#56` (`f3aba04`) |
| 2026-11-26 | `host-core` 实现 §11.3 `rules` ACL、限流与 `SEC-ACL-ERROR-001` | `#54` (`a45ad0b`) |
| 2026-11-26 | Web demo 补齐 ES 模块服务、`?devtools=1` 浮层与 HTTP 模块图测试 | `#53` (`515972b`) |
| 2026-11-26 | 回滚 `wx-compat` 并记录 D-010 | `#52` (`5457802`)，回滚 `#50` |
| 2026-11-26 | Codegen 新增 Swift / Kotlin / Dart 生成目标 | `#51` (`617a18c`) |
| 2026-11-26 | `media.release@1` 契约 | `#49` (`a0d266d`) |
| 2026-11-26 | `packages/devtools`（记录器、HAR 导出、Shadow DOM 浮层） | `#48` (`594237f`) |
| 2026-11-26 | iOS 前台上传图片预处理 | `#47` (`d2a2ac0`) |
| 2026-11-26 | Host → Web 反向调用（§9.2，Web `/reverse` + host-core） | `#46` (`0f917cd`) |
| 2026-11-26 | Flutter 方案 A Dart 宿主核心与 shim | `#45` (`fb33a6e`) |
| 2026-11-26 | `transfer.upload` 前台图片上传 RFC（`spec/rfcs/transfer-upload.md`） | `#44` (`40f6795`) |
| 2026-11-26 | Web SDK 插件管线（`use` / `onMetric`）与 `/fallback` | `#43` (`c56e6a9`) |
| 2026-11-26 | 实时认领与交接迁移到置顶 Issue `#41` | `#42` (`ce3a69e`) |
| 2026-11-26 | React Native 方案 A 宿主核心（`packages/react-native`、`OJSB_RN_SHIM`、二次编码、S2 门禁） | `#40` (`9d2600f`) |
| 2026-11-26 | 流式回调协议 `bridge.progress`（`onCallback` + `idleTimeout` + `HostCore` `ctx.callback`） | `#38` (`c49083d`) |
| 2026-11-26 | 提取参考 `packages/host-core` 并增强 `@open-jsbridge/web/mock` | `#36` (`4acf1aa`) |
| 2026-11-26 | 补齐 `docs/native-capability-catalog.md` 的 `#21` 边界说明并同步 `0.2.0` 看板 | `#35` (`1a1d401`) |
| 2026-11-26 | 新增 `packages/codegen`（Spec Lint + TS 类型生成）与 CI 漂移检查 | `#34` (`ca340e8`) |
| 2026-11-26 | 修复 `scripts/pack-web.mjs` 对 npm 12 `npm pack --json` 返回格式的兼容 | `#33` (`1a1b580`) |
| 2026-11-26 | 建立多 Agent 协作规范 `AGENTS.md`、中心状态看板与零冲突交接单模板 | `#32` (`15dd06d`) |
| 2026-11-26 | Web SDK `0.2.0` 发布与迁移说明（`docs/migrate-0.2.0.md`） | `#31` (`52d94f5`) |
| 2026-11-26 | 三端 `0.2.0` 候选发布工程化与 Android Photo Picker 回移文档 | `#27` (`d7149c2`) |
