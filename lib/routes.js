/**
 * 模型路由覆盖的存储 + 生效逻辑。
 *
 * 生效点：每个“团队成员 Agent”自己的 `agent/request` waterfall（payload 只有
 * { turn, step, signal }，返回值是冻结的 LlmCallConfig：扁平结构
 * { provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }）。
 *
 * 之所以把监听器挂在**每个成员自己的 ctx** 上，而不是宿主 ctx 上：
 * 团队成员身份随时变（新增、冷恢复），逐个成员精确挂载可以保证
 * 一、只影响被设定的那个成员；二、成员被删除后不出残留覆盖。
 */

import { describe, report, warn } from './util.js'

/** 进程内状态：全部按 SessionId 归类，成员冷恢复（同一个 id）后自动重新生效。 */
export function createState() {
  return {
    /** SessionId -> { provider?, model?, reasoningEffort? } */
    overrides: new Map(),
    /** SessionId -> disposer（已挂载的 agent/request 监听） */
    hooks: new Map(),
    /** `${provider}\u0000${model}` -> probe 结果 */
    models: new Map(),
    /** 已经警告过的 key，避免每轮都刷日志 */
    warned: new Set(),
  }
}

function once(state, ctx, key, label, error) {
  if (state.warned.has(key)) {
    try {
      ctx.logger?.debug?.(`${label}: ${describe(error)}`)
    } catch {
      /* 忽略 */
    }
    return
  }
  state.warned.add(key)
  warn(ctx, label, error)
}

/**
 * 探测一个模型是否可用，以及它声明了哪些思考强度档位。
 *
 * 返回：
 *   { state: 'ok', efforts: string[], defaultEffort?: string }
 *   { state: 'missing', reason }   模型/提供方不存在
 *   { state: 'unknown', reason }   宿主没有暴露 llm.resolveModelInfo，无法校验
 */
export async function probeModel(ctx, state, provider, model) {
  const key = `${provider}\u0000${model}`
  if (state.models.has(key)) return state.models.get(key)

  const llm = ctx.get('llm')
  const result = await (async () => {
    if (!llm || typeof llm.resolveModelInfo !== 'function') {
      return { state: 'unknown', reason: '当前宿主未暴露 llm.resolveModelInfo，无法校验模型与档位' }
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      if (!info) return { state: 'missing', reason: `模型 ${provider}/${model} 不存在` }
      const efforts = Array.isArray(info.reasoning?.efforts)
        ? info.reasoning.efforts.map((item) => String(item?.id ?? item)).filter(Boolean)
        : []
      return {
        state: 'ok',
        efforts,
        defaultEffort: info.reasoning?.defaultEffort === undefined ? undefined : String(info.reasoning.defaultEffort),
      }
    } catch (error) {
      return { state: 'missing', reason: describe(error) }
    }
  })()

  state.models.set(key, result)
  return result
}

/** 拿到当前的生效覆盖（可能没有）。 */
export function overrideOf(state, sessionId) {
  return state.overrides.get(sessionId)
}

/**
 * 在指定成员的 ctx 上挂载一次 agent/request 覆盖钩子（幂等）。
 * 任何异常都被吞掉：钩子坏了也绝不能让该成员的回合失败。
 */
export function attachRouteHook(ctx, agent, state) {
  const id = agent?.id
  if (id === undefined || id === null) return
  if (state.hooks.has(id)) return
  const agentCtx = agent.ctx
  if (!agentCtx || typeof agentCtx.on !== 'function') return

  const dispose = agentCtx.on('agent/request', async (payload, next) => {
    // next() 只能调用一次：先把宿主原生的冻结配置取出来。
    const config = await next()
    try {
      const override = state.overrides.get(id)
      if (!override) return config
      return await applyOverride(ctx, state, id, config, override)
    } catch (error) {
      // 覆盖失败 → 完整保留宿主原始配置，绝不中断本回合。
      once(state, ctx, `apply\u0000${id}`, `成员 ${String(id)} 路由覆盖失败`, error)
      return config
    }
  })

  state.hooks.set(id, dispose)
}

/** 成员消失后清理挂载与状态。 */
export function detachRouteHook(state, sessionId) {
  const dispose = state.hooks.get(sessionId)
  state.hooks.delete(sessionId)
  if (typeof dispose === 'function') {
    try {
      dispose()
    } catch {
      /* 忽略 */
    }
  }
  state.overrides.delete(sessionId)
}

/**
 * 把覆盖合并进宿主冻结的 LlmCallConfig。
 *
 * 思考强度归属规则（与宿主 dsh-subagent 一致）：reasoningEffort 属于“模型
 * 自己的词汇表”，因此当本次覆盖更换了 provider/model 而调用方没有显式给出
 * 档位时，必须丢弃继承来的档位，而不是把一个不存在的档位发给新模型。
 */
async function applyOverride(ctx, state, id, config, override) {
  const targetProvider = override.provider ?? config.provider
  const targetModel = override.model ?? config.model
  const routeChanged = targetProvider !== config.provider || targetModel !== config.model

  // 目标路由必须先能解析，否则宁可退回宿主原配置，也不把成员的回合打挂。
  const probe = await probeModel(ctx, state, targetProvider, targetModel)
  if (probe.state === 'missing') {
    once(state, ctx, `route\u0000${id}\u0000${targetProvider}/${targetModel}`, `成员 ${String(id)} 的目标路由不可用，已回退到原配置`, probe.reason)
    return config
  }

  const next = { ...config }
  if (routeChanged) {
    next.provider = targetProvider
    next.model = targetModel
  }

  const requested = override.reasoningEffort
  if (requested !== undefined) {
    if (probe.state === 'ok' && probe.efforts.length > 0 && !probe.efforts.includes(requested)) {
      once(
        state,
        ctx,
        `effort\u0000${targetProvider}/${targetModel}/${requested}`,
        `模型 ${targetProvider}/${targetModel} 不接受档位 "${requested}"，已忽略`,
        `可选值：${probe.efforts.join(', ')}`,
      )
      if (!routeChanged) delete next.reasoningEffort
    } else {
      next.reasoningEffort = requested
    }
  } else if (routeChanged) {
    // 未显式指定档位却换了模型：丢弃继承档位，交给新模型的默认档位。
    delete next.reasoningEffort
  }

  return next
}
