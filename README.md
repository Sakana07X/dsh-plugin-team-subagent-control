# dsh-plugin-team-subagent-control

这是一个为**DeepSeek Desktop（DSH）**"智能体团队（Agent Teams）"模式补足能力的插件，提供两项功能：

1. **按成员指定模型与思考强度（reasoning effort）** —— 粒度是"每个团队成员一个"，不影响主对话和其它成员。
2. **主对话可以删除团队成员子代理** —— 释放它的运行实例（含它自己带出来的子代理），主代理/团长不允许删除。

两项能力都以**模型可见的工具**形式提供（不带设置面板）。

---

## 1. 前置确认结论

| 项目 | 结论 |
| --- | --- |
| 接入方式 | Cordis **宿主插件行**（`cordis.patch.yml` 的 `insert` 行），无需 `isolate` realm、无需前端 bundle |
| 运行依赖 | **零 npm 依赖**：不 import 任何 `@deepseek-ai/*` 包，只消费宿主注入的服务 |
| 作用粒度 | **按成员**（per-member） |
| 生效方式 | 覆盖该成员每次 LLM 调用的 `agent/request` 配置 |
| 思考强度取值 | **以模型自己声明的档位为准**，非法值拒绝并回报可选值（`llm.resolveModelInfo()`） |
| 删除语义 | **释放运行实例**；宿主没有"抹掉名册"的 API，故名册里该成员会变成 `inactive`，可被再次唤起（见 §5.2） |
| 可删范围 | 只允许删团队成员，**禁止删主代理/团长** |
| 删除后可否恢复 | 可以：名册记录保留，`send_message` 会冷恢复（但该成员的模型指定已被清除，回到继承） |

---

## 2. 文件结构

```
dsh-plugin-team-subagent-control/
├─ package.json          # ESM 包声明；dsh.bundle.patch 指向 cordis.patch.yml（走包安装时用）
├─ cordis.patch.yml      # 宿主插件行定义（insert 一行）
├─ lib/
│  ├─ index.js           # 插件入口：name / inject / apply；注册工具 + 挂事件监听
│  ├─ tools.js           # 4 个模型可见工具的定义与编排
│  ├─ routes.js          # 模型/档位覆盖的存储与 agent/request 合并逻辑
│  ├─ release.js         # "删除成员" = 中断 → 释放下属 → 释放本体 → 复核
│  ├─ team.js            # 团队身份/成员解析、存活判定、状态渲染
│  └─ util.js            # 日志、错误描述、safely() 兜底、输出格式
├─ test/
│  └─ smoke.mjs          # 假宿主自测（零依赖，node test/smoke.mjs）
└─ README.md
```

### 各模块职责与对接点

| 模块 | 对接的宿主能力 | 职责 |
| --- | --- | --- |
| `lib/index.js` | `ctx.tools.register()`、`ctx.on('agent/created')`、`ctx.on('session/disposed')`、`ctx.get('agents')` | 装配与兜底；给已在场和新出现的团队成员挂覆盖钩子 |
| `lib/routes.js` | `ctx.get('llm').resolveModelInfo()`、每个 Agent 自己的 `ctx.on('agent/request')` | 保存覆盖、把它合并进冻结的 `LlmCallConfig` |
| `lib/release.js` | `agentTeams.interrupt()`、`subagents.drainContinuableDescendants()`、`subagents.drainContinuableChildren()`、`agentTeams.listMembers()`、`agents.get()` | 删除流程与真实状态复核 |
| `lib/team.js` | `agentTeams.tryMembership()/listMembers()`、`agents.get()` | 判断"我在不在团里、对方是不是成员"并渲染成人类可读状态 |
| `lib/tools.js` | `tools.register()` 的工具契约 | 4 个工具的参数校验、错误文案、结果汇总 |

---

## 3. 安装

插件零依赖，所以有两种装法。**推荐 A**（不碰 npm，最稳）。

### 方式 A：用 `file:///` 行直接挂载（推荐）

1. 把整个 `dsh-plugin-team-subagent-control` 目录放到一个**长期存在**的路径，例如
   `D:\\github-code\\dsh-plugin-team-subagent-control`。
2. 打开 profile 的补丁层：
   `C:\\Users\\<用户名>\\AppData\\Roaming\\dsh-desktop\\harness\\profiles\\web\\cordis.patch.yml`
3. 在文件末尾追加（注意 YAML 缩进，URL 里的空格写成 `%20`）：

```yaml
- insert:
    - id: team-subagent-control
      name: "file:///D:/DeepSeek%20Harness/dsh-plugin-team-subagent-control/lib/index.js"
```

4. 保存。该 profile 的 `dsh.profile.patchReload` 是 `live`，保存后通常**热生效**。
   若工具没有出现，重启 DeepSeek Desktop。
5. 打开日志确认一行：
   `[team-subagent-control] 已加载：team_route_options / team_set_member_route / team_member_status / team_delete_member`

> 只加这一处即可。**不要**同时使用方式 B，否则同名工具会注册两次。

### 方式 B：作为包安装（市场 / `dsh plugin add`）

本目录已有 `package.json` 的 `dsh.bundle.patch` 与 `cordis.patch.yml`，因此可以直接以包形式安装。

```powershell
dsh plugin --profile web add link:D:\\github-code\\dsh-plugin-team-subagent-control
```

安装后重启；包的 `cordis.patch.yml` 会自动插入同一行。若你的环境没有 `dsh` 命令，用市场插件管理界面按本地路径安装，效果相同。

### 卸载

- 方式 A：删掉那 3 行 YAML。
- 方式 B：`dsh plugin --profile web remove dsh-plugin-team-subagent-control`（或界面里禁用）。

### 自测（不依赖 DSH，随时可跑）

```powershell
cd "D:\\github-code\\dsh-plugin-team-subagent-control"
node test/smoke.mjs
```

它会用假宿主跑 20 组断言，覆盖：档位校验、覆盖合并、路由失效回退、删除只动目标、拒绝删团长、服务缺失、调用取消等退化路径，以及 `apply()` 在服务全缺时也能正常激活。

---

## 4. 使用

启用后先进"智能体团队"模式，然后直接在对话里说人话即可，模型会调用对应工具。

**A. 先查有哪些模型与档位**

> 看看现在能用哪些模型，以及 `deepseek-flash` 支持哪些思考强度。

工具调用：`team_route_options` → `team_route_options(provider, model)`

**B. 给某个成员换模型/档位**

> 把 alice 换成 deepseek-pro，思考强度用 max。bob 保持现在的模型，但档位降到 low。

工具调用：
```
team_set_member_route(member="alice", provider="deepseek-official", model="deepseek-pro", reasoning_effort="max")
team_set_member_route(member="bob", reasoning_effort="low")     # 只改档位，模型沿用
```

只给档位时，插件读该成员**当前活着的** `agent.options` 来补全 provider/model。成员没有运行实例时会拒绝并提示显式给出 provider+model。

**C. 查看谁在用哪个模型？**

> 现在每个成员分别用的什么模型？哪些是继承主对话的？

工具调用：`team_member_status`

输出形如：
```
- alice｜teammate｜running｜已指定：deepseek-official / deepseek-pro @ max
- bob｜teammate｜inactive｜继承：deepseek-official / deepseek-flash @ low
```

**D. 删除成员**

> 把 alice 删掉。

工具调用：`team_delete_member(member="alice")`

返回会明确写**释放前状态 / 释放后状态 / 运行实例是否还在**，并附过程记录（是否先中断了它的回合、是否连带释放了它下属的子代理）。

**E. 撤销模型指定**

> 让 alice 回到跟随主对话。

工具调用：`team_set_member_route(member="alice", clear=true)`

---

## 5. 工作原理（以及为什么删除只能做到这一步）

### 5.1 模型与思考强度

- 宿主 `AgentOptions` 就是 `{ provider?, model?, reasoningEffort?, maxTokens?, subagentDepth? }`。
  每次模型调用前由 `agent/request` waterfall（payload `{ turn, step, signal }`）产出冻结的
  `LlmCallConfig = { provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }`。
- 本插件在**每个团队成员自己的 ctx** 上监听 `agent/request`：先 `await next()` 拿到宿主原生配置，
  再把覆盖字段浅合并进去，其余字段（`maxTokens`、`temperature` 等）原样保留。
- 档位归属规则与宿主 `@deepseek-ai/dsh-subagent` 一致：`reasoningEffort` 属于"模型自己的词汇表"，
  所以**换模型且没有显式指定档位时，会丢弃继承来的档位**，绝不把旧档位发给新模型。
- 档位合法值来自 `llm.resolveModelInfo(provider, model).reasoning.efforts[].id`（含 `defaultEffort`），
  设置时即时校验，非法值直接把可选值列回去。

### 5.2 删除子智能体

宿主**没有** `agentTeams.deleteMember/removeMember` 这类 API（`agentTeams` 只有
`membership / listMembers / spawnTeammate / sendMessage / interrupt / waitForChange / 任务板`）。
真正可用的释放路径是子代理层面：

| 行为 | 宿主 API |
| --- | --- |
| 判定成员存活 | `agents.get(sessionId)`；团队自己的 `memberView()` 就是用它的 `status`（`running` / `inactive`）。 |
| 停当前回合 | `agentTeams.interrupt(caller, targetName)`（仅团长可调用） |
| 释放成员本体 | `subagents.drainContinuableChildren(parent, [childId])`（`dsh-subagent/lib/typert.host.js:163`），要求 `parent` 是**同一个活着的** Agent |
| 释放成员带出来的子代理 | `subagents.drainContinuableDescendants([memberAgent])` |

所以删除流程是：**解析目标 → 拒绝主代理 → 正在跑就先 `interrupt` → 释放下属 → `drainContinuableChildren` → 用 `listMembers` + `agents.get` 复核**。
每一步都有 20s 超时，任何一步失败都变成一句可读说明，不会把主对话卡住或抛异常。

**关键限制（请务必知悉）**：`drainContinuableChildren` 释放的是**运行实例**，团队名册是持久化的（Lead 会话日志），宿主没有删除名册行的 API，因此删除后
`listMembers` / 界面里该成员仍然存在，状态显示 `inactive`。这正是"界面状态与实际状态一致"：卡上显示 inactive，实际也确实没有运行实例了；
再次 `send_message` 会冷恢复它。若你要"彻底消失"，只能等宿主开放名册删除 API。

---

## 6. 稳定性设计（对应验收标准）

| 要求 | 实现 |
| --- | --- |
| 不破坏原有功能 | 插件是**新增** 4 个工具 + 在两个事件上加监听；不接管、不替换任何宿主工具（`list_agents`/`send_message`/`interrupt_agent` 原样可用）。 |
| 激活失败不拖垮宿主 | `apply()` 内部全部走 `safely()`；单个工具注册失败只记日志，其余工具照常注册；`inject` 只强制要求 `tools`，其余服务懒取。 |
| 操作失败有明确提示 | 所有失败返回 `✖ 原因 \n提示：下一步怎么做`，并区分 `UNAUTHORIZED`/超时/模型不存在/档位非法。 |
| 不阻塞主对话 | 释放流程带 20s 超时；覆盖钩子出错时**完整回退**宿主原配置；调用被取消时立刻返回且不落任何修改。 |
| 不误伤 | 覆盖只挂在"当前团成员"的 ctx 上，一次性 one-shot 子代理不参与；删除精确到单个 `sessionId`，并用宿主真实状态复核后才宣布成功。 |
| 幂等 | 对已释放成员重复删除不会报错；重复设置覆盖直接覆盖旧值。 |

---

## 7. 已知限制

1. **不能删除名册行**：见 §5.2，宿主无 API。删掉的只是运行实例。
2. **不能预设新成员的路由**：宿主 `spawn_teammate` 只接受 `provider`（spawn provider，如 `spawn`/`fork`），
   不接受 model/effort。因此只能"先创建、后指定"，指定从该成员的**下一个**回合生效。
3. **指定是进程内状态**：重启 DSH 后成员的模型指定丢失，回到继承主对话。
   （如需持久化，可后续接 `settings` 命名空间，见 §8 第 1 条。）
4. **删除会清掉该成员的模型指定**：避免被冷恢复后"带着旧设定复活"。若你更希望保留，改
   `lib/tools.js` 里 `team_delete_member` 中的一行即可。
5. **只覆盖 LLM 路由**：不改系统提示、工具集、预算；`maxTokens`/`temperature` 不提供设置入口。
6. **档位校验依赖 `llm.resolveModelInfo`**：宿主若未暴露该方法，插件会放行但打警告。
   拼写错误会在该成员回合由宿主报错。
7. **非团队模式**：工具会明确说明"当前会话不在智能体团队中"，不做任何隐含动作。
8. **成员互删不支持**：只有团长能删（与宿主 `interrupt` 的权限模型一致）。
9. **若宿主未来把团队成员改成非直系子代理**：`drainContinuableChildren` 会返回
   `UNAUTHORIZED`，插件会原样回报并建议先用 `interrupt_agent`。

---

## 8. TODO / 未确认事项

1. **模型指定持久化到磁盘**（重启后仍生效）：当前是进程内。
2. **"删除"是否必须"从名册彻底消失"**：若是，需要宿主开放 API，插件侧无法绕过。
3. **覆盖一次性子代理**（`spawn` 派生的非团队子代理）的模型：当前只覆盖团队成员。
4. **设置面板**（表单式 UI）：当前只提供工具命令。
5. **成员之间互删**：当前仅团长。
6. **思考强度额外白名单**（例如只允许 `high`/`max`）：当前完全以模型声明为准。

---

## 9. 故障排查

| 现象 | 检查 |
| --- | --- |
| 对话里看不到那 4 个工具 | ① 确认 YAML 缩进/URL 编码正确；② 日志里有没有 `[team-subagent-control] 已加载`；③ 是否同时用了方式 A+B 造成重复；④ 重启应用 |
| 工具报"当前运行环境没有智能体团队服务" | 当前不是智能体团队模式，或该 profile 没装团队扩展（`@deepseek-ai/dsh-experimental-agent-team`）。 |
| 设置成功但成员仍用旧模型 | 覆盖从**下一个回合**生效；确认成员确实在跑（`team_member_status` 看 status），必要时先 `send_message` 催它跑一轮。 |
| 删除报 `UNAUTHORIZED` | 目标不是团长的直系子代理，或团长身份已过期（例如刚冷恢复）；先重开一轮团队对话再试。 |
| 删除报"仍有活着的运行实例" | 成员正在执行中；等其回合结束重试，或先用 `interrupt_agent`。 |
| 删除成功但界面还显示该成员 | 这是宿主的正常表现：名册行保留、状态变 `inactive`，见 §5.2。 |

日志标签统一是 `[team-subagent-control]`，错误的完整原因与下一步提示都会写在工具返回里。
