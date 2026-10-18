/**
 * 无依赖的小工具集合。
 *
 * 设计约束（重要）：本插件在运行时不 import 任何 `@deepseek-ai/*` 包，
 * 因此它可以被 `file:///` 行直接加载，不需要放在 profile 的 node_modules 里，
 * 也不会因为宿主版本升级而出现模块解析失败。
 */

export const LOG_TAG = '[team-subagent-control]'

/** 把任意抛出物转成一行可读文本。 */
export function describe(error) {
  if (error instanceof Error) {
    const code = error.code ?? error.codeName
    return code ? `${error.name}[${String(code)}]: ${error.message}` : `${error.name}: ${error.message}`
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 记录一条错误日志，永不抛出。 */
export function report(ctx, label, error) {
  const message = describe(error)
  try {
    ctx.logger?.error?.(`${LOG_TAG} ${label}: ${message}`)
  } catch {
    /* 日志本身失败也不能影响主流程 */
  }
  return message
}

/** 记录一条警告日志，永不抛出。 */
export function warn(ctx, label, error) {
  try {
    ctx.logger?.warn?.(`${LOG_TAG} ${label}: ${describe(error)}`)
  } catch {
    /* 同上 */
  }
}

/**
 * 执行一段可能失败的初始化逻辑：吞掉异常并记日志，返回 fallback。
 * 用于“插件任何一部分坏掉都不许拖垮宿主”的场景。
 */
export function safely(ctx, label, run, fallback = undefined) {
  try {
    return run()
  } catch (error) {
    report(ctx, label, error)
    return fallback
  }
}

/** 组装工具返回的 content blocks。 */
export function text(value) {
  return [{ type: 'text', text: String(value ?? '') }]
}

/** 所有工具共用的 output 描述（tools.register 只要求 { schema, render }）。 */
export const OUTPUT = Object.freeze({
  schema: { type: 'string' },
  render: (_args, value) => text(value),
})

/** 失败信息的统一前缀，便于模型/用户区分“工具拒绝”和“插件崩溃”。 */
export function fail(message, hint) {
  return hint ? `✖ ${message}\n提示：${hint}` : `✖ ${message}`
}

export function has(value) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

/** 模型/provider 名里可能有不可见字符，统一 trim 一次。 */
export function clean(value) {
  return typeof value === 'string' ? value.trim() : value
}

/** 简短 id，便于在结果里对齐界面上的会话。 */
export function shortId(id) {
  const value = String(id ?? '')
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-3)}` : value
}
