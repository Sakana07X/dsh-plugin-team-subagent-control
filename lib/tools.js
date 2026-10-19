/**
 * 模型可见的 4 个工具。全部使用最普通的 JSON Schema 参数描述和
 * `output: { schema, render }` 形状，不 import `defineTool`，
 * 因此插件可以在任何安装位置（含 file:/// 行）正常注册。
 *
 * 稳定性约定：execute 内部任何异常都被转成一句明确的 `✖ …` 文本返回，
 * 绝不抛出——抛错会让模型看到工具崩溃，也容易中断主对话节奏。
 */

import { clean, describe, fail, has, OUTPUT } from './util.js'
import { attachRouteHook, detachRouteHook, probeModel } from './routes.js'
import { findMember, liveAgent, renderMember, resolveTeam, service } from './team.js'
import { releaseMember } from './release.js'

function guard(exec) {
  if (exec?.signal?.aborted) return '✖ 本次调用已被取消，未做任何修改。'
  return undefined
}

function callContext(exec) {
  return exec?.agent
}

async function llmOf(ctx) {
  const llm = service(ctx, 'llm')
  if (!llm || typeof llm.listProviders !== 'function') return undefined
  return llm
}

/** 把模型/提供方列表渲染成紧凑文本。 */
function joinList(items, render) {
  if (!Array.isArray(items) || items.length === 0) return '（无）'
  return items.map(render).join('\n')
}

const routeOptions = (ctx, state) => ({
  name: 'team_route_options',
  description:
    '查看当前可用的模型提供方、模型，以及某个模型声明了哪些“思考强度（reasoning effort）”档位。'
    + '设置团队成员模型前，先用它确认合法取值。参数可逐级收窄：不传任何参数→列提供方；传 provider→列该提供方的模型；再传 model→列该模型的思考强度档位。',
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: '模型提供方 id，例如 deepseek-official' },
      model: { type: 'string', description: '模型 id，例如 deepseek-flash；需要同时给出 provider' },
    },
    required: [],
    additionalProperties: false,
  },
  output: OUTPUT,
  async execute(args, exec) {
    const denied = guard(exec)
    if (denied) return denied
    const provider = clean(args?.provider)
    const model = clean(args?.model)
    try {
      const llm = await llmOf(ctx)
      if (!llm) return fail('当前运行环境没有可用的 llm 服务，无法列出模型。')

      if (!provider) {
        const providers = await llm.listProviders()
        return [
          '可用模型提供方：',
          joinList(providers, (item) => `- ${item?.id ?? item}${item?.name && item.name !== item.id ? `（${item.name}）` : ''}`),
          '',
          '下一步：传入 provider 查看它的模型。',
        ].join('\n')
      }

      if (!model) {
        if (typeof llm.listModels !== 'function') return fail('当前宿主未暴露 llm.listModels，无法列出模型。')
        const models = await llm.listModels(provider)
        return [
          `提供方 ${provider} 的模型：`,
          joinList(models, (item) => `- ${item?.id ?? item}${item?.name && item.name !== item.id ? `（${item.name}）` : ''}`),
          '',
          '下一步：传入 model 查看该模型声明的思考强度档位。',
        ].join('\n')
      }

      const probe = await probeModel(ctx, state, provider, model)
      if (probe.state === 'missing') {
        return fail(`无法解析模型 ${provider}/${model}：${probe.reason}`, '用 team_route_options 重新枚举可用的 provider/model。')
      }
      if (probe.state === 'unknown') {
        return `模型 ${provider}/${model}：${probe.reason}。\n设置时需要自行确保 provider/model/档位拼写正确，否则该成员的回合会报错。`
      }
      if (probe.efforts.length === 0) {
        return `模型 ${provider}/${model} 未声明任何思考强度档位（只能使用模型默认行为）；设置时请不要给出 reasoning_effort。`
      }
      return [
        `模型 ${provider}/${model} 支持的思考强度档位：`,
        probe.efforts.map((id) => `- ${id}${id === probe.defaultEffort ? '（默认）' : ''}`).join('\n'),
      ].join('\n')
    } catch (error) {
      return fail(`列举模型选项失败：${describe(error)}`)
    }
  },
})

const setMemberRoute = (ctx, state) => ({
  name: 'team_set_member_route',
  description:
    '为**某个团队成员（子代理）**指定它后续回合使用的模型与思考强度。粒度是“按成员”，不影响主对话和其它成员。'
    + '只传 reasoning_effort 时，模型沿用该成员当前路由；只传 provider/model 时不带档位（继承目标模型默认档位）。'
    + '想恢复“跟随主对话”请用 clear=true。设置成功后从该成员的下一个回合开始生效，且成员被删除/冷恢复后仍然保留。',
  parameters: {
    type: 'object',
    properties: {
      member: { type: 'string', description: '团队成员名称（与 list_agents / team_member_status 里的 name 一致）' },
      provider: { type: 'string', description: '模型提供方 id；省略则沿用该成员当前提供方' },
      model: { type: 'string', description: '模型 id；省略则沿用该成员当前模型' },
      reasoning_effort: {
        type: 'string',
        description: '思考强度档位 id（必须在该模型声明的档位内，可用 team_route_options 查询）',
      },
      clear: { type: 'boolean', description: '设为 true 表示清除该成员的模型指定，恢复继承主对话路由' },
    },
    required: ['member'],
    additionalProperties: false,
  },
  output: OUTPUT,
  async execute(args, exec) {
    if (exec?.signal?.aborted) return guard({ signal: exec.signal })
    const team = resolveTeam(ctx, callContext(exec))
    if (team.error) return team.error

    const found = findMember(team.members, clean(args?.member))
    if (found.error) return found.error
    const target = found.member
    if (target.role === 'lead') {
      return fail('主代理（团长）的模型由主对话自身的模型选择控制，不能用本工具修改。', '请为具体成员指定模型。')
    }

    const sessionId = target.id
    if (!sessionId) return fail('该成员没有可用的会话 id，无法保存模型指定。')

    if (args?.clear === true) {
      state.overrides.delete(sessionId)
      return `✔ 已清除成员 "${target.name}" 的模型指定，其后续回合恢复继承主对话路由。`
    }

    const providerArg = clean(args?.provider)
    const modelArg = clean(args?.model)
    const effortArg = clean(args?.reasoning_effort)
    if (!has(providerArg) && !has(modelArg) && !has(effortArg)) {
      return fail('没有给出任何要修改的项。', '至少给出 provider / model / reasoning_effort 之一，或用 clear=true 清除指定。')
    }

    const agent = liveAgent(ctx, sessionId)
    const options = agent?.options ?? {}
    // 只从“活着的 Agent 的 LLM 路由”继承；member.provider 是 spawn provider
    // （如 spawn/fork），不是 LLM 提供方，不能拿来当默认值。
    const provider = has(providerArg) ? providerArg : options.provider
    const model = has(modelArg) ? modelArg : options.model

    if (!has(provider) || !has(model)) {
      return fail(
        `无法确定成员 "${target.name}" 当前的模型路由，因此不能只改思考强度。`,
        '请同时给出 provider 与 model（可用 team_route_options 查询，例如 provider=deepseek-official / model=deepseek-flash）。',
      )
    }

    const probe = await probeModel(ctx, state, provider, model)
    if (probe.state === 'missing') {
      return fail(`无法解析模型 ${provider}/${model}：${probe.reason}`, '用 team_route_options 重新枚举可用的 provider/model。')
    }
    if (has(effortArg) && probe.state === 'ok') {
      if (probe.efforts.length === 0) {
        return fail(
          `模型 ${provider}/${model} 未声明任何思考强度档位。`,
          '请去掉 reasoning_effort（只指定模型），或换一个声明了档位的模型。',
        )
      }
      if (!probe.efforts.includes(effortArg)) {
        return fail(
          `模型 ${provider}/${model} 不接受思考强度 "${effortArg}"。`,
          `可选值：${probe.efforts.join(', ')}`,
        )
      }
    }

    const override = { provider, model }
    if (has(effortArg)) override.reasoningEffort = effortArg
    state.overrides.set(sessionId, override)

    // 成员正在运行就立刻挂载覆盖；没运行时会在 agent/created 时补挂（覆盖按 id 保存）。
    if (agent) {
      try {
        attachRouteHook(ctx, agent, state)
      } catch (error) {
        return fail(`保存成功但挂载覆盖钩子失败：${describe(error)}`, '该成员的下一个回合可能仍使用原模型，请重试。')
      }
    }

    const lines = [
      `✔ 已为成员 "${target.name}" 指定模型路由：`,
      `- provider: ${provider}`,
      `- model: ${model}`,
      `- reasoning_effort: ${override.reasoningEffort ?? '（未指定，沿用目标模型默认档位）'}`,
      '',
      '生效范围：仅该成员的后续回合，不影响主对话与其它成员。',
    ]
    if (probe.state === 'unknown') lines.push('注意：当前宿主无法校验该模型声明的档位，拼写错误会在该成员回合报错。')
    if (!agent) lines.push('注意：该成员当前没有运行实例，指定会在它下次启动/冷恢复后生效。')
    return lines.join('\n')
  },
})

const memberStatus = (ctx, state) => ({
  name: 'team_member_status',
  description:
    '列出当前智能体团队的成员，以及每个成员此刻的模型路由来源：继承主对话，还是已被本插件单独指定。'
    + '删除成员前后都可以用它复核界面状态与实际运行实例是否一致。',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  output: OUTPUT,
  async execute(_args, exec) {
    const team = resolveTeam(ctx, callContext(exec))
    if (team.error) return team.error
    if (team.members.length === 0) return '当前团队没有成员。'

    const rows = team.members.map((member) => {
      const override = member.id === undefined ? undefined : state.overrides.get(member.id)
      const agent = member.id === undefined ? undefined : liveAgent(ctx, member.id)
      const view = renderMember(member, override, agent?.options)
      return `- ${view.name}｜${view.role}｜${view.status}｜${view.source}：${view.route}`
    })
    return [
      `团队成员（${team.members.length}）：`,
      ...rows,
      '',
      '“已指定”= team_set_member_route 单独指定；“继承”= 跟随主对话路由。',
      'status 含义：running 执行中 / inactive 无运行实例 / provisioning 启动中 / failed 启动失败。',
    ].join('\n')
  },
})

const deleteMember = (ctx, state) => ({
  name: 'team_delete_member',
  description:
    '删除（释放）一个团队成员子代理的运行实例，并同时释放它带出来的子代理。'
    + '主代理（团长/主对话）不允许删除。释放后团名册里仍保留该成员记录（状态变为 inactive，可被再次唤起），'
    + '这是宿主既有语义；本工具会回报释放前后的真实状态，便于确认界面与实际一致。',
  parameters: {
    type: 'object',
    properties: {
      member: { type: 'string', description: '要删除的团队成员名称' },
      include_descendants: {
        type: 'boolean',
        description: '是否同时释放该成员自己带出来的子代理，默认 true',
      },
    },
    required: ['member'],
    additionalProperties: false,
  },
  output: OUTPUT,
  async execute(args, exec) {
    if (exec?.signal?.aborted) return guard({ signal: exec.signal })
    const caller = callContext(exec)
    const team = resolveTeam(ctx, caller)
    if (team.error) return team.error

    if (team.membership.role !== 'lead') {
      return fail(
        '只有主对话（团长）可以删除团队成员。',
        '作为成员时请让主对话发起删除，或使用 interrupt_agent 停止其它成员的当前回合。',
      )
    }

    const found = findMember(team.members, clean(args?.member))
    if (found.error) return found.error
    const target = found.member

    const result = await releaseMember(ctx, team, target, {
      caller,
      includeDescendants: args?.include_descendants !== false,
    })

    if (!result.ok) {
      const extra = result.notes.length > 0 ? `\n过程记录：\n- ${result.notes.join('\n- ')}` : ''
      return `${result.message}${extra}`
    }

    // 释放后清掉覆盖与钩子，避免同一个 id 冷恢复时沿用旧指定。
    if (target.id !== undefined) {
      try {
        detachRouteHook(state, target.id)
      } catch {
        /* 清理失败不影响结果 */
      }
    }

    const lines = [
      `✔ 已释放成员 "${target.name}" 的运行实例。`,
      `- 释放前状态：${result.before}`,
      `- 释放后状态：${result.after}`,
      `- 运行实例：已不存在`,
    ]
    if (result.notes.length > 0) lines.push('', '过程记录：', ...result.notes.map((note) => `- ${note}`))
    lines.push(
      '',
      '说明：团名册里该成员记录仍然存在（状态 inactive），可再次通过 send_message / spawn 唤起；',
      '这是 DeepSeek Desktop 的既有语义——“删除”释放的是运行实例，不是名册记录。',
    )
    return lines.join('\n')
  },
})

/** 构建全部工具定义。 */
export function buildTools(ctx, state) {
  return [routeOptions(ctx, state), setMemberRoute(ctx, state), memberStatus(ctx, state), deleteMember(ctx, state)]
}
