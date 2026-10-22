# dsh-plugin-team-subagent-control

给 **DeepSeek Desktop（DSH）** 的「智能体团队 / Agent Teams」补两件宿主没提供的能力：给单个团队成员换模型和思考强度，以及把团队成员（及其下属子代理）释放掉。

插件不接管任何宿主工具，只新增 4 个模型可见工具，零 npm 依赖。

## 功能

- **成员级模型路由** —— 每个团队成员可以单独指定 provider / model / reasoning effort，粒度精确到成员，主对话和其它成员不受影响。
- **释放团队成员** —— 团长可以在对话里释放某个成员的运行实例；默认连带释放该成员自己带出来的子代理。主代理（团长自己）不允许删除。

## 安装

插件零依赖，两种装法。

**方式 A：本地路径挂载（推荐，不改包环境）**

在 profile 的 `cordis.patch.yml`（Windows 一般是 `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`）里加一行 `insert`：

```yaml
plugins:
  insert:
    - file:///D:/github-code/dsh-plugin-team-subagent-control/lib/index.js
```

路径按你的实际位置改，Windows 盘符也要写成 `/`。DSH 会在日志里打印 `[team-subagent-control] 已加载`。

**方式 B：作为包安装**

```bash
npm i dsh-plugin-team-subagent-control
```

包声明了 `dsh.bundle.patch`，也可以在图形界面的插件管理里按本地路径安装。

**卸载**：删掉对应的 `insert` 行，或 `npm uninstall dsh-plugin-team-subagent-control`。两种方式不要同时用，否则工具会注册两遍。

**自测**（不需要 DSH，随时可跑）：

```bash
node test/smoke.mjs
```

用假宿主跑 20 组断言，覆盖档位校验、覆盖合并、路由回退、删除只动目标、拒绝删团长、服务缺失、调用取消等退化路径。

## 工具

| 工具 | 作用 |
| --- | --- |
| `team_route_options(provider?, model?)` | 查可用 provider、provider 下的模型、以及某个模型声明了哪些思考强度档位 |
| `team_set_member_route(member, provider?, model?, reasoning_effort?, clear?)` | 给某个成员指定路由；只给 `reasoning_effort` 时沿用当前模型；`clear=true` 恢复继承主对话 |
| `team_member_status()` | 列出每个成员当前的模型来源：继承主对话，还是被单独指定 |
| `team_delete_member(member, include_descendants=true)` | 释放该成员的运行实例，默认连带释放它带出来的子代理 |

## 用法

先进「智能体团队」模式，然后正常说话就行，模型会自己调工具。

```
看看现在能用哪些模型，deepseek-flash 支持哪些思考强度？
把 alice 换成 deepseek-pro，思考强度 max；bob 档位降到 low。
现在每个成员分别用的什么模型？
让 alice 回到跟随主对话。
把 alice 删掉。
```

也可以直接写工具调用：

```
team_route_options(provider="deepseek-official", model="deepseek-flash")
team_set_member_route(member="alice", provider="deepseek-official", model="deepseek-pro", reasoning_effort="max")
team_set_member_route(member="bob", reasoning_effort="low")
team_set_member_route(member="alice", clear=true)
team_delete_member(member="alice")
```

## 生效规则

- 模型覆盖从该成员的**下一个**回合开始生效。宿主 `spawn_teammate` 只接受 `provider`（spawn 方式，`spawn` / `fork`），不接受 model，所以只能是「先建成员，再指定」。
- 思考强度以模型自己声明的档位为准（`llm.resolveModelInfo()`）。填错会直接返回该模型的可选档位，不会带着非法值发出去。换模型且没写档位时，继承来的旧档位会被丢掉，不会硬塞给新模型。
- 指定是**进程内状态**：重启 DSH 后回到继承主对话。
- 释放的是**运行实例**，不是名册行。宿主没有删除名册的 API，所以释放后成员仍在名册里、状态变成 `inactive`，下次 `send_message` 会冷恢复它（此时模型指定已被清掉，回到继承）。这是宿主语义，不是插件偷懒。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 对话里看不到这 4 个工具 | `insert` 行的缩进和 URL 编码；日志有没有 `[team-subagent-control] 已加载`；是否 A/B 两种装法同时用了；重启应用 |
| 报「没有智能体团队服务」 | 当前不在智能体团队模式，或该 profile 没装团队扩展 |
| 设置成功但成员还用旧模型 | 覆盖从下一个回合生效，确认成员在跑（`team_member_status`） |
| 删除报 `UNAUTHORIZED` | 目标不是团长的直系子代理，或团长身份已过期，重开一轮团队对话 |
| 删除报「仍有活着的运行实例」 | 成员正在执行，等回合结束或先 `interrupt_agent` |
| 删除成功但界面还显示该成员 | 正常：名册保留、状态 `inactive` |

失败的返回统一是 `✖ 原因` 加一行`提示：`下一步该怎么做，不会把主对话卡住。

## 原理与限制

实现细节、宿主 API 调用点、稳定性取舍写在 [docs/design.md](docs/design.md)。

## License

MIT
