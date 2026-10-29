# 设计说明

这份文档记录插件为什么长这样：宿主提供了什么、我们只能在哪些缝里做、以及每次取舍的代价。想快速用起来看 [README](../README.md)。

## 1. 接入方式与前提

| 项目 | 结论 |
| --- | --- |
| 接入方式 | Cordis **宿主插件行**（`cordis.patch.yml` 的 `insert` 行），不需要 `isolate` realm，也没有前端 bundle |
| 运行依赖 | 零 npm 依赖：不 import 任何 `@deepseek-ai/*` 包，只消费宿主注入的服务 |
| 作用粒度 | 按成员（per-member） |
| 生效方式 | 覆盖该成员每次 LLM 调用的 `agent/request` 配置 |
| 思考强度取值 | 以模型自己声明的档位为准，非法值拒绝并回报可选值（`llm.resolveModelInfo()`） |
| 删除语义 | 释放运行实例；宿主没有抹掉名册的 API，故名册里该成员变成 `inactive`，可被再次唤起 |
| 可删范围 | 只允许删团队成员，禁止删主代理/团长 |
| 删除后可否恢复 | 可以：名册记录保留，`send_message` 会冷恢复（但该成员的模型指定已被清除，回到继承） |

## 2. 文件结构

```
dsh-plugin-team-subagent-control/
├─ package.json          # ESM 包声明；dsh.bundle.patch 指向 cordis.patch.yml（走包安装时用）
├─ cordis.patch.yml      # 宿主插件行定义（insert 一行）
├─ lib/
│  ├─ index.js           # 插件入口：name / inject / apply；注册工具 + 挂事件监听
│  ├─ tools.js           # 4 个模型可见工具的定义与编排
│  ├─ routes.js          # 模型/档位覆盖的存储与 agent/request 合并逻辑
│  ├─ release.js         # 删除成员 = 中断 → 释放下属 → 释放本体 → 复核
│  ├─ team.js            # 团队身份/成员解析、存活判定、状态渲染
│  └─ util.js            # 日志、错误描述、safely() 兜底、输出格式
├─ test/
│  └─ smoke.mjs          # 假宿主自测（零依赖，node test/smoke.mjs）
└─ docs/design.md
```

| 模块 | 对接的宿主能力 | 职责 |
| --- | --- | --- |
| `lib/index.js` | `ctx.tools.register()`、`ctx.on('agent/created')`、`ctx.on('session/disposed')`、`ctx.get('agents')` | 装配与兜底；给已在场和新出现的团队成员挂覆盖钩子 |
| `lib/routes.js` | `ctx.get('llm').resolveModelInfo()`、每个 Agent 自己的 `ctx.on('agent/request')` | 保存覆盖、把它合并进冻结的 `LlmCallConfig` |
| `lib/release.js` | `agentTeams.interrupt()`、`subagents.drainDescendants()`、`subagents.drainChildren()`（旧宿主为 `drainContinuableDescendants()` / `drainContinuableChildren()`）、`agentTeams.listMembers()`、`agents.get()` | 删除流程与真实状态复核 |
| `lib/team.js` | `agentTeams.tryMembership()/listMembers()`、`agents.get()` | 判断是否在团里、对方是否成员，并渲染人类可读状态 |
| `lib/tools.js` | `tools.register()` 的工具契约 | 参数校验、错误文案、结果汇总 |

## 3. 模型与思考强度

- 宿主 `AgentOptions` 就是 `{ provider?, model?, reasoningEffort?, maxTokens?, subagentDepth? }`。每次模型调用前由 `agent/request` waterfall（payload `{ turn, step, signal }`）产出冻结的 `LlmCallConfig = { provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }`。
- 插件在**每个团队成员自己的 ctx** 上监听 `agent/request`：先 `await next()` 拿到宿主原生配置，再把覆盖字段浅合并进去，其余字段（`maxTokens`、`temperature` 等）原样保留。
- 档位归属规则与宿主 `@deepseek-ai/dsh-subagent` 一致：`reasoningEffort` 属于模型自己的词汇表，所以**换模型且没有显式指定档位时会丢弃继承来的档位**，绝不把旧档位发给新模型。
- 档位合法值来自 `llm.resolveModelInfo(provider, model).reasoning.efforts[].id`（含 `defaultEffort`），设置时即时校验，非法值直接把可选值列回去。

## 4. 删除团队成员

宿主**没有** `agentTeams.deleteMember/removeMember` 这类 API（`agentTeams` 只有 `membership / listMembers / spawnTeammate / sendMessage / interrupt / waitForChange / 任务板`）。真正可用的释放路径在子代理层面：

| 行为 | 宿主 API |
| --- | --- |
| 判定成员存活 | `agents.get(sessionId)`，用的是它的 `status`（`running` / `inactive`） |
| 停当前回合 | `agentTeams.interrupt(caller, targetName)`（仅团长可调用） |
| 释放成员本体 | `subagents.drainChildren(parent, [childId])`，要求 `parent` 是同一个活着的 Agent；DSH 0.2.1 之前叫 `drainContinuableChildren` |
| 释放成员带出来的子代理 | `subagents.drainDescendants([memberAgent])`；DSH 0.2.1 之前叫 `drainContinuableDescendants` |

两代命名参数形状一致，插件按“新名优先、旧名回退”取用（`lib/release.js` 的 `pickMethod()`），所以同一份代码在 0.2.1 与更早的宿主上都可用。

所以流程是：**解析目标 → 拒绝主代理 → 正在跑就先 interrupt → 释放下属 → 释放成员本体 → 用 listMembers + agents.get 复核**。每一步 20s 超时，任何一步失败都变成一句可读说明，不阻塞主对话、不抛异常。

**关键限制**：`drainChildren` 释放的是运行实例，团队名册是持久化的（Lead 会话日志），宿主没有删除名册行的 API（0.2.1 里同样没有 `removeMember` / `deleteMember` / `releaseMember`）。删除后 `listMembers` 和界面里该成员仍然存在、状态为 `inactive`。卡上显示 inactive，实际也确实没有运行实例，状态一致；再次 `send_message` 会冷恢复。要彻底消失只能等宿主开放名册删除 API。

## 5. 稳定性取舍

| 要求 | 实现 |
| --- | --- |
| 不破坏原有功能 | 只**新增** 4 个工具 + 在两个事件上加监听；不接管、不替换任何宿主工具（`list_agents` / `send_message` / `interrupt_agent` 原样可用） |
| 激活失败不拖垮宿主 | `apply()` 内部全部走 `safely()`；单个工具注册失败只记日志，其余工具照常注册；`inject` 只强制要求 `tools`，其余服务懒取 |
| 失败有明确提示 | 统一返回 `✖ 原因` + `提示：下一步`，区分 `UNAUTHORIZED` / 超时 / 模型不存在 / 档位非法 |
| 不阻塞主对话 | 释放流程 20s 超时；覆盖钩子出错时完整回退宿主原配置；调用被取消时立刻返回且不落修改 |
| 不误伤 | 覆盖只挂在当前团成员的 ctx 上，一次性子代理不参与；删除精确到单个 `sessionId`，以宿主真实状态复核后才宣布成功 |
| 幂等 | 重复删除已释放成员不报错；重复设置覆盖直接替换旧值 |

## 6. 已知限制

1. **不能删除名册行**：见上，宿主无 API。
2. **不能预设新成员的路由**：`spawn_teammate` 只接受 `provider`（spawn 方式），不接受 model/effort，只能先建后指定，且从下一个回合生效。
3. **指定是进程内状态**：重启 DSH 后丢失，回到继承主对话。
4. **删除会清掉该成员的模型指定**：避免冷恢复后带着旧设定复活；想保留就改 `lib/tools.js` 里 `team_delete_member` 的一行。
5. **只覆盖 LLM 路由**：不改系统提示、工具集、预算，`maxTokens` / `temperature` 不提供入口。
6. **档位校验依赖 `llm.resolveModelInfo`**：宿主没暴露该方法时插件放行并打警告，拼错会在该成员回合由宿主报错。
7. **非团队模式**：工具明确说明当前会话不在智能体团队中，不做隐含动作。
8. **成员互删不支持**：只有团长能删，与宿主 `interrupt` 的权限模型一致。
9. **若宿主把团队成员改成非直系子代理**：`drainChildren` 返回 `UNAUTHORIZED`，插件原样回报并建议先用 `interrupt_agent`。
10. **跨宿主版本**：释放依赖 `subagents.drainChildren` / `drainDescendants`（旧宿主为 `drainContinuable*`）。两代都没有时插件在第一步就说明缺哪层能力，不会静默失败。

## 7. 待办

1. 模型指定持久化到磁盘（重启后仍生效）。
2. 「删除」是否要从名册彻底消失：需要宿主开放 API。
3. 覆盖一次性子代理（`spawn` 派生的非团队子代理）的模型。
4. 表单式设置面板。
5. 成员之间互删。
6. 思考强度白名单（例如只允许 `high` / `max`）。
