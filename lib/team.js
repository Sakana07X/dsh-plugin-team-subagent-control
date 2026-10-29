/**
 * 智能体团队（Agent Teams）侧的查询与“释放成员”逻辑。
 *
 * 事实依据（宿主 @deepseek-ai/dsh-experimental-agent-team）：
 *   - agentTeams 服务**没有** delete/remove/dispose member 方法；
 *     团名册（roster）在收到 `session/disposed` 时才会把成员摘掉。
 *   - 团队 spawn 走 subagents 的常驻可续子代理（0.2.1 之前叫 startContinuable），
 *     因此每个成员都是团长（root）的一个“常驻可续子代理”；宿主的公开释放 API
 *     在 0.2.1 起是 `subagents.drainChildren(parent, childIds)`，
 *     更早的宿主叫 `subagents.drainContinuableChildren(parent, childIds)`。
 *   - 团名册是**持久化**的：释放运行实例后，名册里该成员仍然存在，状态变为
 *     inactive；再次 send_message 会冷恢复。所以“删除”= 释放运行实例 + 停止
 *     占用，而不是抹掉名册记录。这一点会在工具返回值和 README 里明确写出。
 */

import { describe, fail, shortId } from './util.js'

const LIVE_STATUSES = new Set(['running', 'provisioning'])

/** 取一个服务；宿主没装该服务时返回 undefined（不抛异常）。 */
export function service(ctx, name) {
  try {
    return ctx.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/** 规范化团队成员视图，容忍字段缺失。 */
export function normalizeMember(raw) {
  return {
    id: raw?.id,
    name: typeof raw?.name === 'string' ? raw.name : String(raw?.name ?? ''),
    role: raw?.role === 'lead' ? 'lead' : 'teammate',
    status: typeof raw?.status === 'string' ? raw.status : 'unknown',
    description: typeof raw?.description === 'string' ? raw.description : undefined,
    model: typeof raw?.model === 'string' ? raw.model : undefined,
    provider: typeof raw?.provider === 'string' ? raw.provider : undefined,
    context: raw?.context,
    diagnostics: Array.isArray(raw?.diagnostics) ? raw.diagnostics.filter((item) => typeof item === 'string') : [],
  }
}

/**
 * 解析“调用者所在的团”。
 * 返回 { agentTeams, membership, members } 或 { error }。
 */
export function resolveTeam(ctx, caller) {
  const agentTeams = service(ctx, 'agentTeams')
  if (!agentTeams) {
    return { error: fail('当前运行环境没有智能体团队服务（agentTeams）。', '本能力只在“智能体团队”模式下可用。') }
  }
  if (!caller) {
    return { error: fail('无法确定调用方会话，已放弃本次操作。') }
  }

  let membership
  try {
    membership = typeof agentTeams.tryMembership === 'function'
      ? agentTeams.tryMembership(caller)
      : agentTeams.membership(caller)
  } catch (error) {
    return { error: fail(`读取团队身份失败：${describe(error)}`) }
  }
  if (!membership) {
    return { error: fail('当前会话不在任何智能体团队中。', '请先在“智能体团队”模式下发起对话。') }
  }

  let members = []
  try {
    const list = agentTeams.listMembers(caller)
    members = (Array.isArray(list) ? list : []).map(normalizeMember)
  } catch (error) {
    return { error: fail(`读取团队成员失败：${describe(error)}`) }
  }

  return { agentTeams, membership, members }
}

/** 按名字找成员；精确匹配优先，其次忽略大小写。 */
export function findMember(members, query) {
  const wanted = String(query ?? '').trim()
  if (!wanted) {
    return { error: fail('必须给出成员名称（target 字段，与界面上的成员名一致）。') }
  }
  const exact = members.find((item) => item.name === wanted)
  if (exact) return { member: exact }
  const relaxed = members.find((item) => item.name.toLowerCase() === wanted.toLowerCase())
  if (relaxed) return { member: relaxed }
  const names = members.filter((item) => item.role === 'teammate').map((item) => item.name)
  return {
    error: fail(
      `团队里没有名为 "${wanted}" 的成员。`,
      names.length > 0 ? `现有成员：${names.join(', ')}` : '当前团队没有其它成员。',
    ),
  }
}

/** 读取某个会话当前在册的 Agent（只读；成员已释放时返回 undefined）。 */
export function liveAgent(ctx, sessionId) {
  const agents = service(ctx, 'agents')
  if (!agents || sessionId === undefined || sessionId === null) return undefined
  try {
    if (typeof agents.get === 'function') return agents.get(sessionId) ?? undefined
  } catch {
    /* 读不到就当作没有运行实例 */
  }
  return undefined
}

export function isLive(member) {
  return LIVE_STATUSES.has(member.status)
}

/** 渲染成员状态表，供 list/delete 工具的返回值使用。 */
export function renderMember(member, override, agentOptions) {
  // 注意：member.provider 是“spawn provider”（子代理启动方式，如 spawn/fork），
  // 不是 LLM 提供方，绝不能混进路由显示里。
  const route = []
  const provider = override?.provider ?? agentOptions?.provider
  const model = override?.model ?? agentOptions?.model ?? member.model
  if (provider) route.push(String(provider))
  if (model) route.push(String(model))
  const effort = override?.reasoningEffort ?? agentOptions?.reasoningEffort
  const routeText = route.length > 0 ? `${route.join(' / ')}${effort ? ` @ ${String(effort)}` : ''}` : '继承主对话（未指定）'
  const source = override ? (override.provider || override.model || override.reasoningEffort ? '已指定' : '无') : '继承'
  return {
    name: member.name,
    role: member.role,
    status: member.status,
    id: shortId(member.id),
    route: routeText,
    source,
    description: member.description,
  }
}
