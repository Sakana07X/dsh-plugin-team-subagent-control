/**
 * 自测脚本：`node test/smoke.mjs`
 *
 * 不依赖 DSH、不依赖任何 npm 包，用假的宿主服务把两条主链路跑一遍：
 *   1. 按成员指定模型/思考强度 → 合并进 agent/request 的 LlmCallConfig；
 *   2. 删除成员 → 中断 + 释放 + 目标外的成员不受影响 + 主代理被拒绝。
 * 任何断言失败都会以非 0 退出码结束。
 */

import assert from 'node:assert/strict'
import { createState, attachRouteHook, detachRouteHook, probeModel } from '../lib/routes.js'
import { buildTools } from '../lib/tools.js'
import { releaseMember } from '../lib/release.js'
import { resolveTeam, findMember } from '../lib/team.js'

/* ------------------------------ 假宿主环境 ------------------------------ */

function makeCtx(services) {
  const listeners = new Map()
  const logs = []
  const ctx = {
    logs,
    get: (name) => services[name],
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      debug: (m) => logs.push(['debug', m]),
    },
    tools: { register: (def) => { services.tools.registered.push(def); return () => {} } },
    effect: (fn) => fn(),
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((item) => item !== handler))
      }
    },
  }
  return { ctx, listeners }
}

function makeAgentCtx() {
  const listeners = new Map()
  return {
    ctx: {
      on: (event, handler) => {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
        return () => listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== handler))
      },
    },
    listeners,
  }
}

function agentHost(id, options, holder) {
  const { ctx, listeners } = makeAgentCtx()
  return { id, options, ctx, listeners, status: 'inactive' }
}

/* --------------------------------- 场景 --------------------------------- */

const providers = [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }]
const models = {
  'deepseek-official': [{ id: 'deepseek-flash' }, { id: 'deepseek-pro' }],
  openai: [{ id: 'gpt-x' }],
}
const efforts = {
  'deepseek-official/deepseek-flash': ['low', 'medium', 'high'],
  'deepseek-official/deepseek-pro': ['medium', 'high', 'max'],
  'openai/gpt-x': [],
}

const leadAgent = agentHost('session-lead', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
const alice = agentHost('session-alice', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
const bob = agentHost('session-bob', { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'medium' })

const liveAgents = new Map([
  [leadAgent.id, leadAgent],
  [alice.id, alice],
  [bob.id, bob],
])

const memberRows = [
  { id: leadAgent.id, name: 'lead', role: 'lead', status: 'running' },
  { id: alice.id, name: 'alice', role: 'teammate', status: 'running', provider: 'deepseek-official', model: 'deepseek-flash' },
  { id: bob.id, name: 'bob', role: 'teammate', status: 'inactive', provider: 'deepseek-official', model: 'deepseek-pro' },
]

const calls = { interrupt: [], drainChildren: [], drainDescendants: [] }

const membershipFor = (agent) => {
  if (!agent) return undefined
  const role = agent.id === leadAgent.id ? 'lead' : 'teammate'
  return { root: leadAgent, id: 'team-1', role, name: role === 'lead' ? 'lead' : agent.id.replace('session-', '') }
}

const services = {
  tools: { registered: [] },
  llm: {
    listProviders: async () => providers,
    listModels: async (provider) => models[provider] ?? [],
    resolveModelInfo: async (provider, model) => {
      const key = `${provider}/${model}`
      if (!(key in efforts)) throw Object.assign(new Error(`no such model: ${key}`), { code: 'MODEL_NOT_FOUND' })
      return {
        reasoning: efforts[key].length > 0
          ? { efforts: efforts[key].map((id) => ({ id, name: id.toUpperCase() })), defaultEffort: efforts[key][0] }
          : undefined,
      }
    },
  },
  agents: {
    get: (id) => liveAgents.get(id),
    list: () => [...liveAgents.values()],
  },
  agentTeams: {
    tryMembership: (agent) => membershipFor(agent),
    membership: (agent) => {
      const value = membershipFor(agent)
      if (!value) throw new Error('not a member')
      return value
    },
    listMembers: (caller) => memberRows.filter((row) => row.id !== 'unauth'),
    interrupt: (caller, name) => {
      calls.interrupt.push({ caller: caller?.id, name })
      return { previousStatus: 'running' }
    },
  },
  subagents: {
    drainContinuableChildren: async (parent, ids) => {
      calls.drainChildren.push({ parent: parent?.id, ids: [...ids] })
      if (ids.includes('session-explode')) throw Object.assign(new Error('boom'), { code: 'UNAUTHORIZED' })
      for (const id of ids) {
        liveAgents.delete(id)
        const row = memberRows.find((item) => item.id === id)
        if (row) row.status = 'inactive'
      }
    },
    drainContinuableDescendants: async (parents) => {
      calls.drainDescendants.push(parents.map((item) => item?.id))
    },
  },
}

const { ctx } = makeCtx(services)
const state = createState()
const tools = buildTools(ctx, state)
const tool = (name) => tools.find((item) => item.name === name)
assert.equal(tools.length, 4, '应当注册 4 个工具')
for (const definition of tools) {
  assert.equal(typeof definition.execute, 'function', `${definition.name} 缺少 execute`)
  assert.equal(typeof definition.output?.render, 'function', `${definition.name} 缺少 output.render`)
  assert.equal(typeof definition.parameters?.type, 'string', `${definition.name} 参数不是 JSON Schema`)
}

const results = []
const pass = (label) => results.push(label)

/* ------------------------- 1. 模型/档位枚举与校验 ------------------------- */

{
  const out = await tool('team_route_options').execute({}, { agent: leadAgent })
  assert.match(out, /deepseek-official/)
  const out2 = await tool('team_route_options').execute({ provider: 'deepseek-official' }, { agent: leadAgent })
  assert.match(out2, /deepseek-flash/)
  const out3 = await tool('team_route_options').execute({ provider: 'deepseek-official', model: 'deepseek-flash' }, { agent: leadAgent })
  assert.match(out3, /low/)
  assert.match(out3, /high/)
  const out4 = await tool('team_route_options').execute({ provider: 'openai', model: 'gpt-x' }, { agent: leadAgent })
  assert.match(out4, /未声明/)
  const out5 = await tool('team_route_options').execute({ provider: 'deepseek-official', model: 'nope' }, { agent: leadAgent })
  assert.match(out5, /✖/)
  pass('team_route_options：提供方/模型/档位/无档位/不存在模型')
}

/* ------------------------------ 2. 指定路由 ------------------------------ */

{
  const bad = await tool('team_set_member_route').execute(
    { member: 'alice', provider: 'deepseek-official', model: 'deepseek-flash', reasoning_effort: 'ultra' },
    { agent: leadAgent },
  )
  assert.match(bad, /✖/)
  assert.match(bad, /low, medium, high/, '非法档位必须回报可选值')

  const noEffortModel = await tool('team_set_member_route').execute(
    { member: 'alice', provider: 'openai', model: 'gpt-x', reasoning_effort: 'high' },
    { agent: leadAgent },
  )
  assert.match(noEffortModel, /✖/)

  const ok = await tool('team_set_member_route').execute(
    { member: 'alice', provider: 'deepseek-official', model: 'deepseek-pro', reasoning_effort: 'max' },
    { agent: leadAgent },
  )
  assert.match(ok, /✔/)
  assert.equal(state.overrides.get(alice.id).model, 'deepseek-pro')
  assert.equal(state.overrides.get(alice.id).reasoningEffort, 'max')
  pass('team_set_member_route：非法档位/无档位模型被拒绝，合法值落库')

  // 只有档位时沿用成员当前模型
  const effortOnly = await tool('team_set_member_route').execute(
    { member: 'bob', reasoning_effort: 'medium' },
    { agent: leadAgent },
  )
  assert.match(effortOnly, /✔/)
  assert.deepEqual(state.overrides.get(bob.id), { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'medium' })
  pass('team_set_member_route：仅给档位时沿用成员当前 provider/model')

  // 未知成员
  const missing = await tool('team_set_member_route').execute({ member: 'nobody', model: 'deepseek-flash' }, { agent: leadAgent })
  assert.match(missing, /✖/)
  assert.match(missing, /alice/, '应提示现有成员名')

  // 主代理不允许改
  const lead = await tool('team_set_member_route').execute({ member: 'lead', model: 'deepseek-pro' }, { agent: leadAgent })
  assert.match(lead, /✖/)
  pass('team_set_member_route：未知成员/主代理被拒绝')
}

/* -------------------- 3. agent/request 覆盖真实生效 -------------------- */

{
  const handlers = alice.listeners.get('agent/request')
  assert.ok(handlers && handlers.length === 1, 'alice 应当已挂载一个 agent/request 覆盖钩子')

  const base = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 4096 }
  const patched = await handlers[0]({ turn: 1, step: 1 }, async () => base)
  assert.equal(patched.model, 'deepseek-pro', '模型应被覆盖')
  assert.equal(patched.reasoningEffort, 'max', '档位应被覆盖')
  assert.equal(patched.maxTokens, 4096, '未涉及的字段必须原样保留')
  pass('agent/request：覆盖 provider/model/档位且保留其它字段')

  // 未设定的成员不受影响
  const bobHandlers = bob.listeners.get('agent/request')
  assert.ok(bobHandlers?.length === 1, 'bob 也应有钩子（它有覆盖）')
  detachRouteHook(state, bob.id)
  assert.equal(bob.listeners.get('agent/request').length, 0, 'bob 的钩子应被清理')
  pass('detachRouteHook：清理钩子且删除覆盖')

  // 目标路由不可用 → 完整回退原配置（不能打挂成员回合）
  state.overrides.set(alice.id, { provider: 'deepseek-official', model: 'ghost-model' })
  const fallback = await handlers[0]({ turn: 2, step: 1 }, async () => base)
  assert.deepEqual(fallback, base, '不可用路由必须原样回退')
  assert.ok(ctx.logs.some(([level]) => level === 'warn'), '回退时应记一条警告日志')
  pass('agent/request：目标路由不可用时完整回退，并记警告')

  // 换模型且未指定档位 → 丢弃继承档位（档位属于模型词汇表）
  state.overrides.set(alice.id, { provider: 'openai', model: 'gpt-x' })
  const switched = await handlers[0]({ turn: 3, step: 1 }, async () => base)
  assert.equal(switched.provider, 'openai')
  assert.equal(switched.model, 'gpt-x')
  assert.equal(switched.reasoningEffort, undefined, '换模型且未指定档位时应丢弃继承档位')
  pass('agent/request：换模型时丢弃继承档位')

  // 探针有缓存
  const before = state.models.size
  await probeModel(ctx, state, 'openai', 'gpt-x')
  assert.equal(state.models.size, before, '探针结果应命中缓存')
  pass('probeModel：结果缓存')
}

/* --------------------------- 4. 状态与删除 --------------------------- */

{
  const status = await tool('team_member_status').execute({}, { agent: leadAgent })
  assert.match(status, /alice/)
  assert.match(status, /已指定/)
  pass('team_member_status：列出成员与路由来源')

  // 非团长不能删
  const byMember = await tool('team_delete_member').execute({ member: 'bob' }, { agent: alice })
  assert.match(byMember, /✖/)
  assert.match(byMember, /只有主对话/)
  pass('team_delete_member：成员调用被拒绝')

  // 团长不能删
  const leadDelete = await tool('team_delete_member').execute({ member: 'lead' }, { agent: leadAgent })
  assert.match(leadDelete, /✖/)
  pass('team_delete_member：拒绝删除主代理')

  // running 成员：先中断再释放；只有目标被动到
  calls.interrupt.length = 0
  calls.drainChildren.length = 0
  calls.drainDescendants.length = 0
  const deleted = await tool('team_delete_member').execute({ member: 'alice' }, { agent: leadAgent })
  assert.match(deleted, /✔/)
  assert.match(deleted, /运行实例：已不存在/)
  assert.deepEqual(calls.drainChildren, [{ parent: leadAgent.id, ids: [alice.id] }], '释放目标必须精确到 alice')
  assert.equal(calls.interrupt.length, 1, '正在跑的成员应先被中断')
  assert.equal(calls.drainDescendants.length, 1, '应尝试释放成员下属子代理')
  assert.equal(liveAgents.get(alice.id), undefined, 'alice 的运行实例应消失')
  assert.ok(liveAgents.get(bob.id), 'bob 不应受影响')
  assert.equal(state.overrides.get(alice.id), undefined, '删除后应清掉该成员的覆盖')
  pass('team_delete_member：中断→释放→状态复核，其它成员不受影响')

  // 释放失败要给出明确原因而不是抛错
  const team = resolveTeam(ctx, leadAgent)
  assert.ok(!team.error)
  const ghost = { id: 'session-explode', name: 'ghost', role: 'teammate', status: 'inactive' }
  const failed = await releaseMember(ctx, team, ghost, { caller: leadAgent })
  assert.equal(failed.ok, false)
  assert.match(failed.message, /✖/)
  assert.match(failed.message, /UNAUTHORIZED|拒绝/)
  pass('releaseMember：宿主拒绝时返回可读错误，不抛异常')

  // 已经释放过的成员再次删除：应成功且不报错
  const again = await tool('team_delete_member').execute({ member: 'bob' }, { agent: leadAgent })
  assert.match(again, /✔/)
  pass('team_delete_member：对 inactive 成员重复删除是幂等的')
}

/* ------------------ 4b. 宿主 0.2.1 命名（drainChildren / drainDescendants） ------------------ */

{
  // DSH 0.2.1 起宿主把 drainContinuableChildren/Descendants 改名为
  // drainChildren/drainDescendants，参数形状不变。这里用一个只有新名字的
  // 假宿主，确认插件在新旧两代宿主上都能真正释放成员。
  const carol = agentHost('session-carol', { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
  liveAgents.set(carol.id, carol)
  memberRows.push({ id: carol.id, name: 'carol', role: 'teammate', status: 'running' })

  const modernCalls = { children: [], forest: [] }
  const modernSubagents = {
    drainChildren: async (parent, ids) => {
      modernCalls.children.push({ parent: parent?.id, ids: [...ids] })
      for (const id of ids) {
        liveAgents.delete(id)
        const row = memberRows.find((item) => item.id === id)
        if (row) row.status = 'inactive'
      }
    },
    drainDescendants: async (parents) => {
      modernCalls.forest.push(parents.map((item) => item?.id))
    },
  }

  const modernCtx = makeCtx({ ...services, subagents: modernSubagents }).ctx
  const modernTeam = resolveTeam(modernCtx, leadAgent)
  assert.ok(!modernTeam.error, '新命名宿主下应能解析团队')
  const found = findMember(modernTeam.members, 'carol')
  assert.ok(found.member, '应能找到成员 carol')
  const released = await releaseMember(modernCtx, modernTeam, found.member, { caller: leadAgent })
  assert.equal(released.ok, true, `新命名宿主应释放成功：${released.message ?? ''}`)
  assert.deepEqual(modernCalls.children, [{ parent: leadAgent.id, ids: [carol.id] }], '新命名下释放目标也必须精确到 carol')
  assert.equal(modernCalls.forest.length, 1, '新命名下应释放成员下属子代理')
  assert.equal(liveAgents.get(carol.id), undefined, 'carol 的运行实例应消失')
  pass('releaseMember：兼容宿主 0.2.1 新命名 drainChildren / drainDescendants')

  // 两代命名都缺失时才拒绝，并说清缺的是哪一层能力
  const neitherCtx = makeCtx({ ...services, subagents: {} }).ctx
  const neitherTeam = resolveTeam(neitherCtx, leadAgent)
  const dave = { id: 'session-dave', name: 'dave', role: 'teammate', status: 'inactive' }
  const refused = await releaseMember(neitherCtx, neitherTeam, dave, { caller: leadAgent })
  assert.equal(refused.ok, false)
  assert.match(refused.message, /drainChildren/)
  pass('releaseMember：宿主两代命名都缺失时给出可读错误')
}

/* --------------------------- 5. 退化环境不崩 --------------------------- */

{
  const bare = makeCtx({ tools: { registered: [] } })
  const bareState = createState()
  const bareTools = buildTools(bare.ctx, bareState)
  const out = await bareTools[0].execute({}, {})
  assert.match(out, /✖/, '没有 llm 服务时应返回可读错误')
  const del = await bareTools[3].execute({ member: 'x' }, {})
  assert.match(del, /✖/, '没有团队服务时应返回可读错误')
  pass('服务缺失时工具返回可读错误而不是抛异常')

  const aborted = await bareTools[3].execute({ member: 'x' }, { signal: { aborted: true } })
  assert.match(aborted, /取消/)
  pass('调用被取消时立即返回且不修改状态')
}

/* --------------------- 6. 插件激活（apply）不抛异常 --------------------- */

{
  const registered = []
  const listeners = new Map()
  const activationCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    get: (name) => (name === 'agents' ? { list: () => [leadAgent, alice, bob] } : undefined),
    tools: { register: (def) => { registered.push(def.name); return () => {} } },
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
  }
  const { apply } = await import('../lib/index.js')
  apply(activationCtx, {})
  assert.deepEqual(
    registered.sort(),
    ['team_delete_member', 'team_member_status', 'team_route_options', 'team_set_member_route'],
    '激活时应注册 4 个工具',
  )
  assert.ok(listeners.get('agent/created')?.length === 1, '应监听 agent/created')
  assert.ok(listeners.get('session/disposed')?.length === 1, '应监听 session/disposed')
  pass('apply：注册 4 个工具并挂上 agent/created / session/disposed 监听')

  // 宿主服务全缺时也能激活（工具报错即可）
  const bareRegistered = []
  apply(
    {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      get: () => undefined,
      tools: { register: (def) => { bareRegistered.push(def.name); return () => {} } },
      on: () => () => {},
    },
    {},
  )
  assert.equal(bareRegistered.length, 4, '服务全缺也应完成注册')
  pass('apply：宿主服务缺失时仍能激活（不崩、不阻塞）')

  // 配置里显式关闭则不注册任何工具
  const offRegistered = []
  apply(
    {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      get: () => undefined,
      tools: { register: (def) => { offRegistered.push(def.name); return () => {} } },
      on: () => () => {},
    },
    { enabled: false },
  )
  assert.equal(offRegistered.length, 0, 'enabled:false 时不应注册工具')
  pass('apply：enabled=false 时安静退出')
}

/* --------------------------------- 输出 --------------------------------- */

console.log(`\n通过 ${results.length} 组断言：`)
for (const line of results) console.log(`  ✔ ${line}`)
console.log('\n全部自测通过。\n')
