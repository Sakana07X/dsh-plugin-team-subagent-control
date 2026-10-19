/**
 * dsh-plugin-team-subagent-control
 *
 * 在 DeepSeek Desktop 的“智能体团队”模式下补两项能力：
 *   1. 按成员指定模型与思考强度（reasoning effort）；
 *   2. 主对话（团长）可以删除团队成员子代理的运行实例。
 *
 * 接入方式：Cordis 宿主插件行。运行时**不依赖任何 @deepseek-ai/* 包**，
 * 只使用宿主注入的服务（tools / agents / agentTeams / subagents / llm），
 * 服务缺失时工具会给出明确提示而不是让插件崩掉。
 */

import { attachRouteHook, createState, detachRouteHook } from './routes.js'
import { buildTools } from './tools.js'
import { report, safely } from './util.js'
import { service } from './team.js'

export const name = 'team-subagent-control'

// 只强制依赖 tools：其余服务（agents / agentTeams / subagents / llm）按需
// 懒取，这样“没装团队扩展”时插件依然能正常激活并给出可读的错误信息，
// 而不是整行装配失败。
export const inject = ['tools']

/** 读取配置，容忍 undefined/垃圾值。 */
function normalizeConfig(config) {
  const input = config && typeof config === 'object' ? config : {}
  return {
    enabled: input.enabled !== false,
    hookTeamMembers: input.hookTeamMembers !== false,
  }
}

/** 该 Agent 是否是当前团的“成员（子代理）”，是则返回 membership。 */
function teammateMembership(ctx, agent) {
  const agentTeams = service(ctx, 'agentTeams')
  if (!agentTeams || !agent || agent.id === undefined) return undefined
  try {
    const membership = typeof agentTeams.tryMembership === 'function'
      ? agentTeams.tryMembership(agent)
      : undefined
    return membership && membership.role === 'teammate' ? membership : undefined
  } catch {
    return undefined
  }
}

/**
 * 给某个成员挂覆盖钩子。只对“当前团里的成员”生效：
 * 一次性的 one-shot 子代理不参与，避免扩大影响面。
 */
function maybeAttach(ctx, state, agent) {
  if (!agent) return
  if (!teammateMembership(ctx, agent)) return
  safely(ctx, `挂载成员路由覆盖 ${String(agent.id)}`, () => attachRouteHook(ctx, agent, state))
}

export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) {
    ctx.logger?.info?.('[team-subagent-control] 已按配置禁用。')
    return
  }

  const state = createState()

  // ① 注册工具（逐个独立兜底：某个工具注册失败不影响其它工具）。
  safely(ctx, '构建工具定义', () => {
    for (const definition of buildTools(ctx, state)) {
      safely(ctx, `注册工具 ${definition?.name}`, () => ctx.tools.register(definition))
    }
  })

  // ② 新成员出现时补挂覆盖（冷恢复的成员 id 不变，覆盖自动继续生效）。
  if (settings.hookTeamMembers) {
    safely(ctx, '监听 agent/created', () => {
      ctx.on('agent/created', (payload) => {
        safely(ctx, '处理 agent/created', () => maybeAttach(ctx, state, payload?.agent))
      })
    })

    // ③ 插件激活时对已在场的成员补挂一次（热安装场景）。
    safely(ctx, '扫描已存在的成员', () => {
      const agents = service(ctx, 'agents')
      if (!agents || typeof agents.list !== 'function') return
      const list = agents.list()
      for (const agent of Array.isArray(list) ? list : []) maybeAttach(ctx, state, agent)
    })
  }

  // ④ 会话销毁时清理覆盖与监听，防止 id 复用时带上旧指定。
  safely(ctx, '监听 session/disposed', () => {
    ctx.on('session/disposed', (session) => {
      const id = session?.id ?? session
      if (id === undefined || id === null) return
      safely(ctx, `清理成员状态 ${String(id)}`, () => detachRouteHook(state, id))
    })
  })

  ctx.logger?.info?.('[team-subagent-control] 已加载：team_route_options / team_set_member_route / team_member_status / team_delete_member')
}

export { createState, buildTools, report }
