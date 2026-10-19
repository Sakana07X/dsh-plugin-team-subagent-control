/**
 * “删除子智能体”的实现。
 *
 * 宿主的公开能力边界（务必如实告知用户）：
 *   agentTeams 只有 interrupt / sendMessage / waitForChange / 任务板，
 *   没有任何 delete/remove 成员的方法；成员的运行实例是 subagents 层面的
 *   “常驻可续子代理”，因此释放实例 = subagents.drainContinuableChildren。
 *   释放后团名册里的成员记录仍在（状态 inactive，可被冷恢复）——
 *   这就是“删掉运行实例但界面仍显示该成员”的原因，属于宿主既有语义。
 */

import { describe, fail } from './util.js'
import { isLive, liveAgent, service } from './team.js'

const DEFAULT_TIMEOUT_MS = 20_000

/** 给宿主调用套一个超时，保证工具永长时间阻塞主对话。 */
async function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    // 不阻止进程退出
    if (typeof timer?.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function looksUnauthorized(error) {
  const text = describe(error).toUpperCase()
  return text.includes('UNAUTHORIZED') || text.includes('FORBIDDEN') || text.includes('NOT AUTHORIZED')
}

/**
 * 释放一个团队成员的运行实例。
 *
 * @returns {{ ok: boolean, before: string, after: string, released: boolean, notes: string[], message?: string }}
 */
export async function releaseMember(ctx, team, target, options = {}) {
  const { agentTeams, membership } = team
  const { caller, includeDescendants = true, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const notes = []

  // ① 主代理/团长不允许删除（用户明确要求：禁止删团长）。
  if (target.role === 'lead' || target.name === membership.name) {
    return {
      ok: false,
      before: target.status,
      after: target.status,
      released: false,
      notes,
      message: fail(
        '拒绝删除主代理（团长）。',
        '本插件只释放团队成员（子代理）；主对话/团长由 DeepSeek Desktop 界面管理。',
      ),
    }
  }

  const sessionId = target.id
  if (!sessionId) {
    return { ok: false, before: target.status, after: target.status, released: false, notes, message: fail('该成员没有可用的会话 id，无法释放运行实例。') }
  }

  const subagents = service(ctx, 'subagents')
  if (!subagents || typeof subagents.drainContinuableChildren !== 'function') {
    return {
      ok: false,
      before: target.status,
      after: target.status,
      released: false,
      notes,
      message: fail(
        '当前宿主没有提供 subagents.drainContinuableChildren，无法释放成员运行实例。',
        '替代方案：使用 interrupt_agent 停止该成员的当前回合（实例仍常驻，无法真正释放）。',
      ),
    }
  }

  const parent = membership.root
  if (!parent) {
    return { ok: false, before: target.status, after: target.status, released: false, notes, message: fail('无法确定团长（root）Agent，已放弃删除。') }
  }

  const before = target.status
  const agent = liveAgent(ctx, sessionId)

  // ② 正在跑就先中断当前回合，否则常驻实例可能拒绝被释放。
  if (isLive(target) && typeof agentTeams.interrupt === 'function') {
    try {
      await withTimeout(Promise.resolve(agentTeams.interrupt(caller, target.name)), timeoutMs, '中断成员回合')
      notes.push('已先中断该成员正在执行的回合。')
    } catch (error) {
      notes.push(`中断当前回合失败（继续尝试释放）：${describe(error)}`)
    }
  }

  // ③ 先释放该成员自己带出来的子代理（“团队成员中的子代理”）。
  if (includeDescendants && agent && typeof subagents.drainContinuableDescendants === 'function') {
    try {
      await withTimeout(Promise.resolve(subagents.drainContinuableDescendants([agent])), timeoutMs, '释放成员下属子代理')
      notes.push('已同时释放该成员下属的子代理运行实例。')
    } catch (error) {
      notes.push(`释放下属子代理失败（不影响下一步）：${describe(error)}`)
    }
  }

  // ④ 释放成员本体。
  let releaseError
  try {
    await withTimeout(Promise.resolve(subagents.drainContinuableChildren(parent, [sessionId])), timeoutMs, '释放成员运行实例')
  } catch (error) {
    releaseError = error
  }

  // ⑤ 用宿主的真实状态复核，绝不只相信调用没抛错。
  const after = (() => {
    try {
      const list = agentTeams.listMembers(caller)
      const row = (Array.isArray(list) ? list : []).find((item) => item?.id === sessionId)
      return typeof row?.status === 'string' ? row.status : 'unknown'
    } catch {
      return 'unknown'
    }
  })()
  const stillLive = liveAgent(ctx, sessionId) !== undefined

  if (releaseError !== undefined) {
    const hint = looksUnauthorized(releaseError)
      ? '宿主拒绝释放该实例（可能不是本会话的直接子代理，或父会话身份已变化）。'
      : '宿主释放实例失败。'
    return {
      ok: false,
      before,
      after,
      released: !stillLive,
      notes,
      message: fail(`${hint}${describe(releaseError)}`, '可先用 interrupt_agent 停止该成员，再重试删除。'),
    }
  }

  if (stillLive) {
    return {
      ok: false,
      before,
      after,
      released: false,
      notes,
      message: fail(
        '释放调用已返回，但该成员仍有活着的运行实例。',
        '通常是该成员正在执行中；请稍等其回合结束后重试，或先用 interrupt_agent。',
      ),
    }
  }

  return { ok: true, before, after, released: true, notes }
}
