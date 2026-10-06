# 操作文档：云同步自动推送（`senseaudio.cloudSyncAutoPush`）

> 目标：在**现有云同步逻辑不变**（推送整体替换云端、拉取"云端为源"合并）的前提下，新增自动推送，省去每次手动跑 `Sync Push`。
> 前提约束：现有合并逻辑是"云端为源 + 本地多出的删除"，自动推送**只在"key 单机管理"用法下安全**（见第 2 节）。
> 状态：**待实施**（2026-10-07 记录）

---

## 1. 现有逻辑（不改动）

- **Sync Push**（手动）：本地 store → **整体替换**云端 Gist
- **Sync Pull**（手动）/ **自动拉取**（启动时，`cloudSyncAutoPull` 默认开启）：云端 → 合并覆盖本地，"云端为源"——云端有本地无的追加、两边都有云端覆盖、**本地有云端无的删除**
- 互斥：push/pull 共用 `syncInFlight` 锁（单窗口内有效）
- 时间戳：优先 GitHub 服务端 `updated_at`；push 后更新 `lastCloudSyncAt`

本次**只加自动推送**，不改合并策略（并集合并方案已评估，因复杂度放弃，见会话记录）。

---

## 2. 使用约束与风险（必须写进文档/README 与设置项 description）

自动推送 + "云端为源"合并的组合下，各场景的风险：

| 使用场景 | 风险 | 结论 |
|----------|------|------|
| **key 只在一台机器上管理**（其他机器只读、只拉取） | 无风险——改完自动推，其他机器自动拉，无冲突 | ✅ 推荐用法 |
| **多台机器各自有不同 key** | 自动推送会把"本机没有的 key"从云端抹掉（整体替换），其他机器拉取后**跟着丢 key** | ❌ 禁止开启 autoPush |
| **多台机器都管理 key（但 key 集合相同）** | 修改 cookie/label 时**最后 push 的机器赢**，先推机器上的修改在下次拉取时被覆盖丢失 | ⚠️ 可用但修改可能互相覆盖 |
| **本机删除 key 后自动推送** | 云端该 key 被删，其他机器拉取后**跟着删**（删除会传播） | ⚠️ 预期行为，但要知道删一处=删全部 |
| **多窗口同时改 key** | 并发 push last-writer-wins，可能丢一次更新（跨窗口锁缓解，不消除） | ⚪ 低频，可接受 |
| **去抖期间（2-3 秒内）关闭窗口** | 自动 push 丢失（deactivate flush 缓解，不保证） | ⚪ 低频，可接受 |

**定案（2026-10-07）**：`cloudSyncAutoPush` 默认 `false`；**不做"开启前弹窗确认"**，改为在设置项 description 里写明约束——"key 只在一台机器上管理"的用法下是安全的，不建议多机器不同 key 的用法。

---

## 3. 方案要点

1. **新增配置项** `senseaudio.cloudSyncAutoPush`（boolean，默认 `false`，`package.json` → `contributes.configuration`）
2. **触发时机**：用户 key 管理操作（增删/批量导入/编辑/设当前/绑定/清除 cookie）完成后自动 push
3. **去抖**：2-3 秒 debounce（批量导入逐条写入只推一次；期间新变更重置计时器）
4. **静默失败**：自动 push 失败（未登录/网络错误）只记日志（`cloudSync.autoPush`），不弹窗不打断；未登录静默跳过（`getGitHubSession(false)`）
5. **手动 `Sync Push` 保留**：逃生舱 + 首次初始化用

---

## 4. 逻辑死角与防护（必须实现）

### 🔴 死角 1：pull → push 回声循环

自动 pull 导致 store 变更 → 若触发自动 push → 云端 `updatedAt` 刷新 → 其他窗口/机器 pull → …

**防护（二选一，推荐 ①）**：
- ① 自动 push 的触发钩子**只挂在用户操作入口**（`addApiKey`/`updateApiKey`/`removeApiKey`/`setKeyCookie` 等命令层函数），**不挂 `saveApiKeyStore`**（pull 也调它）
- ② pull 成功后设模块级抑制标志（`suppressAutoPushUntil = Date.now() + 5000`），期间 auto-push 跳过

### 🔴 死角 2：无变更 push 刷时间戳

store 内容没变也 push → 云端 `updatedAt` 每次刷新 → 其他机器永远认为"有更新" → 无谓拉取。

**防护**：push 前对比本地序列化 payload 与云端现有 payload（`fetchSyncPayload`），**完全相同则不写 Gist、不更新 `updatedAt`**，仅记日志返回。

### 🟡 死角 3：多窗口并发

每个窗口是独立扩展宿主进程，`syncInFlight` 锁单窗口内有效——多窗口可并发 push（last-writer-wins 丢更新）、重复拉取。

**防护**：
- `globalState` 跨窗口锁：push/pull 前写 `cloudSyncLockUntil = Date.now() + 30s`（TTL 自动过期防崩溃死锁），被占用则跳过（自动模式静默）
- 残余风险接受：多窗口同时改 key 极低频，且"单机管理"约束下无冲突

### ⚪ 死角 4：去抖期间关窗丢 push

改完 key 2-3 秒内关 VS Code，push 丢失。
**防护**：`deactivate()` 中 flush 待执行的 push（尽力而为，失败只记日志）；或接受偶发丢失（下次变更补推）。

---

## 5. 涉及文件与改动清单

### 5.1 `package.json`

```json
"senseaudio.cloudSyncAutoPush": {
    "type": "boolean",
    "default": false,
    "description": "Automatically push key changes to the cloud Gist after key management operations (debounced). Only safe when keys are managed on a single machine — do NOT use with different keys on multiple machines (auto-push would remove keys not present locally from the cloud)."
}
```

### 5.2 `src/cloud/cloudSync.ts`

- `pushToCloud` 补充 `silent` 参数（若现有签名无）：静默失败只记日志
- push 前无变更短路：拉云端 payload 对比，相同则跳过写入（死角 2 防护）
- 跨窗口锁：`globalState` 的 `cloudSyncLockUntil` 检查/写入（死角 3 防护）
- 导出 `autoPushDebounced(context)`：去抖 2-3 秒后调用 `pushToCloud(context, silent=true)`

### 5.3 `src/keys/keyManager.ts` + `src/extension.ts`（触发点）

- keyManager 写操作函数（命令层入口）完成后调用注入的 `onStoreChanged` 回调（**不挂 `saveApiKeyStore`**，避免 pull 触发——死角 1 防护）
- `extension.ts` 注册回调：读 `cloudSyncAutoPush` 配置 → 开启则调 `autoPushDebounced(context)`
- `deactivate()` flush 待执行 push（死角 4）

### 5.4 `AGENTS.md`（文档同步铁律）

- 1.2「云同步（GitHub Gist）」条目：新增自动推送说明（配置项、去抖、静默失败、单机管理约束）
- 4.x `cloudSync.ts` 函数清单：新增 `autoPushDebounced` 说明，更新 `pushToCloud` 签名（silent 参数、无变更短路、跨窗口锁）

---

## 6. 实施顺序（建议）

1. `package.json` 加 `senseaudio.cloudSyncAutoPush`
2. `cloudSync.ts`：`pushToCloud` 加 silent + 无变更短路 + 跨窗口锁 + `autoPushDebounced`
3. `keyManager.ts` 写操作回调 + `extension.ts` 注册（去抖触发）
4. `deactivate()` flush
5. `npx tsc --noEmit` / `npm run compile` 编译检查（铁律，必须无错误）
6. 手动验证：
   - 开启配置 → 管理界面加一个 key → 2-3 秒后输出通道出现 `cloudSync.autoPush` 日志，Gist 内容更新
   - 批量导入 3 个 key → 只触发一次 push（去抖）
   - 不改任何 key → 不产生 push（无变更短路，`updatedAt` 不变）
   - 未登录 GitHub → 静默跳过不弹窗
   - 开两个窗口同时改 key → 无死循环（跨窗口锁 + 短路兜底）
7. 更新 `AGENTS.md`

---

## 7. 验收标准

- [ ] `npm run compile` / `npx tsc --noEmit` 无错误
- [ ] 开启配置后，用户 key 操作 2-3 秒内自动 push；批量导入只推一次（去抖）
- [ ] **pull 引起的 store 变更不触发自动 push**（无回声循环）
- [ ] **无变更不写 Gist、不刷新 `updatedAt`**（短路生效）
- [ ] 未登录/失败静默只记日志，不弹窗
- [ ] 多窗口并发无死循环（跨窗口锁 + 短路兜底）
- [ ] 手动 `Sync Push` 行为不变
- [ ] `AGENTS.md` 已同步更新
