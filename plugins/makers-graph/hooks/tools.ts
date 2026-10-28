import type { EngineInterface, ToolSpec } from 'claude-code'

import {
  canonicalJson,
  confirmationFor,
  type Edge,
  edgeState,
  type Graph,
  ID_PATTERN,
  INTERFACE_KINDS,
  latestStamp,
  mentionWarnings,
  nodeContext,
  type NodeDetail,
  type NodeOutcome,
  nodeStatus,
  outgoing,
  outputsOf,
  progress,
  readiness,
  scopeConflicts,
  stampAfter,
  type TodoNode,
  validateEdge,
  validateNodeFields,
  validatePorts,
} from './model'
import { diagram } from './diagram'
import { createGraph, listGraphs, loadGraph, saveGraph } from './repo'

type $ = EngineInterface

export class ToolRefusal extends Error {}

const str = { type: 'string' }
const strs = { type: 'array', items: str }
const graphId = { type: 'string', description: '그래프 id (디렉터리 이름)' }
const port = {
  type: 'object',
  properties: { name: str, kind: { type: 'string', enum: [...INTERFACE_KINDS] }, signature: str },
  required: ['name', 'kind', 'signature'],
}
const decision = {
  type: 'object',
  properties: { question: str, choice: str, reason: str, alternatives: strs },
  required: ['question', 'choice', 'reason'],
}
const detail = {
  type: 'object',
  description: '구체화 단계 스펙. 다른 노드의 이름을 쓰지 않고 자기 포트 이름으로만 쓴다',
  properties: {
    scope: {
      type: 'object',
      properties: { include: strs, exclude: strs },
      required: ['include'],
      description: '프로젝트 루트 기준 상대 경로',
    },
    inputs: { type: 'array', items: port, description: '필요로 하는 것. 누가 줄지는 쓰지 않는다' },
    outputs: { type: 'array', items: port, description: '내놓는 것. 누가 쓸지는 쓰지 않는다' },
    decisions: { type: 'array', items: decision, description: '실행자가 혼자 내렸을 갈림길을 미리 확정' },
    references: {
      type: 'array',
      items: { type: 'object', properties: { target: str, note: str }, required: ['target', 'note'] },
      description: '재사용할 기존 코드(경로나 심볼)',
    },
    constraints: { ...strs, description: '하지 말 것' },
    acceptance: {
      type: 'array',
      items: { type: 'object', properties: { statement: str, check: str }, required: ['statement'] },
      description: '관찰 가능한 완료 조건. 1개 이상',
    },
  },
  required: ['scope', 'inputs', 'outputs', 'acceptance'],
}
const nodeRef = { type: 'object', properties: { graph_id: graphId, node_id: str }, required: ['graph_id', 'node_id'] }

export const TOOLS: ToolSpec[] = [
  { name: 'graph_list', description: '이 프로젝트의 그래프 목록과 진행 요약.', inputSchema: { type: 'object' } },
  {
    name: 'graph_create',
    description: '새 그래프를 만든다. 목표 하나에 그래프 하나.',
    inputSchema: {
      type: 'object',
      properties: { graph_id: graphId, title: str, goal: str },
      required: ['graph_id', 'title', 'goal'],
    },
  },
  {
    name: 'graph_open',
    description: '이 세션의 활성 그래프를 바꾸고 패널에 띄운다.',
    inputSchema: { type: 'object', properties: { graph_id: graphId }, required: ['graph_id'] },
  },
  {
    name: 'graph_get',
    description: '그래프 전체: 노드, 간선, 그리고 계산된 상태(노드 상태, 실행 가능 여부, 간선 상태, scope 충돌).',
    inputSchema: { type: 'object', properties: { graph_id: graphId }, required: ['graph_id'] },
  },
  {
    name: 'graph_diagram',
    description:
      '그래프를 세로 한 줄기 텍스트 도식으로 그린다(노드 순서, 간선 배선, 입력·출력 포트). ' +
      '사람이 그래프 모양을 보고 싶어 할 때 결과를 손대지 않고 코드 블록으로 보여준다.',
    inputSchema: { type: 'object', properties: { graph_id: graphId }, required: ['graph_id'] },
  },
  {
    name: 'node_put',
    description:
      '노드를 만들거나 고친다. 처음엔 title·summary만으로 추상 노드를 만들고, 실행 직전에 detail을 채워 구체화한다. ' +
      'detail을 바꾸면 기존 승인은 무효가 된다. detail을 생략하면 기존 detail을 유지한다.',
    inputSchema: {
      type: 'object',
      properties: { graph_id: graphId, id: str, title: str, summary: { ...str, description: '무슨 작업인지(추상 스펙)' }, detail },
      required: ['graph_id', 'id', 'title', 'summary'],
    },
  },
  { name: 'node_delete', description: '노드와 그 노드에 닿는 간선을 지운다.', inputSchema: nodeRef },
  {
    name: 'edge_put',
    description:
      '간선을 만들거나 배선을 바꾼다. 간선이 있으면 to가 from에 의존한다. bindings는 from의 출력 포트를 to의 입력 포트에 연결한다(양쪽이 구체화된 뒤). ' +
      '배선은 사람이 패널에서 확인해야 유효하다.',
    inputSchema: {
      type: 'object',
      properties: {
        graph_id: graphId,
        from: str,
        to: str,
        bindings: {
          type: 'array',
          items: { type: 'object', properties: { output: str, input: str }, required: ['output', 'input'] },
        },
      },
      required: ['graph_id', 'from', 'to'],
    },
  },
  {
    name: 'edge_delete',
    description: '간선을 지운다.',
    inputSchema: { type: 'object', properties: { graph_id: graphId, from: str, to: str }, required: ['graph_id', 'from', 'to'] },
  },
  {
    name: 'node_context',
    description: '노드의 실행 맥락: 노드 스펙 + 간선을 따라 입력 포트에 꽂힌 앞 노드의 출력(끝났으면 실제 결과). 구체화와 실행 전에 읽는다.',
    inputSchema: nodeRef,
  },
  { name: 'node_start', description: '노드 작업 시작을 기록한다. 승인되고 선행이 모두 끝난 노드만 가능.', inputSchema: nodeRef },
  {
    name: 'node_finish',
    description: '노드 작업 완료를 기록한다. outcome.outputs는 실제로 내놓은 것, decisions_made는 스펙에 없어 실행 중에 내린 결정.',
    inputSchema: {
      type: 'object',
      properties: {
        graph_id: graphId,
        node_id: str,
        outcome: {
          type: 'object',
          properties: { outputs: { type: 'array', items: port }, decisions_made: { type: 'array', items: decision } },
          required: ['outputs', 'decisions_made'],
        },
      },
      required: ['graph_id', 'node_id', 'outcome'],
    },
  },
]

export const TOOL_NAMES = TOOLS.map(t => t.name)

export type ToolEnv = {
  base: string
  open: (id: string, dir: string) => Promise<void>
}

const queues = new Map<string, Promise<unknown>>()

// One writer per graph at a time inside this session; saveGraph guards against other sessions.
export function mutate<T>($: $, dir: string, fn: (graph: Graph, now: number) => { graph: Graph; result: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const loaded = await loadGraph($, dir)
    const now = await $.clock.now()
    const draft = structuredClone(loaded.graph)
    const { graph, result } = fn(draft, now)
    await saveGraph($, dir, loaded, graph)
    return result
  }
  const next = (queues.get(dir) ?? Promise.resolve()).then(run, run)
  queues.set(dir, next.catch(() => undefined))
  return next
}

const json = (value: unknown): string => JSON.stringify(value, null, 2)

function graphDir(env: ToolEnv, id: unknown): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new ToolRefusal(`graph_id 형식 오류: ${String(id)}`)
  return `${env.base}/${id}`
}

function requireNode(graph: Graph, id: unknown): TodoNode {
  const node = typeof id === 'string' ? graph.nodes[id] : undefined
  if (!node) throw new ToolRefusal(`노드 없음: ${String(id)}`)
  return node
}

export function describeGraph(graph: Graph): unknown {
  const ids = Object.keys(graph.nodes)
  return {
    meta: graph.meta,
    progress: progress(graph),
    nodes: ids.map(id => {
      const node = graph.nodes[id]!
      const r = readiness(graph, id)
      return { ...node, status: nodeStatus(node), ready: r.ready, stale: r.stale, blocked_by: r.reasons }
    }),
    edges: graph.edges.map(e => ({ ...e, state: edgeState(graph, e) })),
    scope_conflicts: scopeConflicts(graph),
  }
}

export async function handleTool($: $, name: string, input: Record<string, unknown>, env: ToolEnv): Promise<string> {
  switch (name) {
    case 'graph_list': {
      const graphs = await listGraphs($, env.base)
      return json(graphs.map(g => ({ id: g.id, title: g.graph.meta.title, goal: g.graph.meta.goal, progress: progress(g.graph) })))
    }
    case 'graph_create': {
      const dir = graphDir(env, input.graph_id)
      const now = new Date(await $.clock.now()).toISOString()
      await createGraph($, dir, {
        id: String(input.graph_id),
        title: String(input.title),
        goal: String(input.goal),
        node_order: [],
        created_at: now,
      })
      await env.open(String(input.graph_id), dir)
      return `그래프 ${String(input.graph_id)}를 만들고 활성 그래프로 열었다.`
    }
    case 'graph_open': {
      const dir = graphDir(env, input.graph_id)
      await loadGraph($, dir)
      await env.open(String(input.graph_id), dir)
      return `활성 그래프: ${String(input.graph_id)}`
    }
    case 'graph_get': {
      const { graph } = await loadGraph($, graphDir(env, input.graph_id))
      return json(describeGraph(graph))
    }
    case 'graph_diagram': {
      const { graph } = await loadGraph($, graphDir(env, input.graph_id))
      return diagram(graph)
    }
    case 'node_context': {
      const { graph } = await loadGraph($, graphDir(env, input.graph_id))
      requireNode(graph, input.node_id)
      return json(nodeContext(graph, String(input.node_id)))
    }
    case 'node_put':
      return putNode($, env, input)
    case 'node_delete':
      return write($, env, input, (graph) => {
        const node = requireNode(graph, input.node_id)
        delete graph.nodes[node.id]
        graph.edges = graph.edges.filter(e => e.from !== node.id && e.to !== node.id)
        graph.meta.node_order = graph.meta.node_order.filter(id => id !== node.id)
        return `노드 ${node.id}와 연결된 간선을 지웠다.`
      })
    case 'edge_put':
      return putEdge($, env, input)
    case 'edge_delete':
      return write($, env, input, (graph) => {
        const before = graph.edges.length
        graph.edges = graph.edges.filter(e => !(e.from === input.from && e.to === input.to))
        if (graph.edges.length === before) throw new ToolRefusal(`간선 없음: ${String(input.from)} → ${String(input.to)}`)
        return '간선을 지웠다.'
      })
    case 'node_start':
      return write($, env, input, (graph, now) => {
        const node = requireNode(graph, input.node_id)
        const r = readiness(graph, node.id)
        if (!r.ready) throw new ToolRefusal(`시작할 수 없음:\n- ${r.reasons.join('\n- ')}`)
        node.started_at = stampAfter(now, latestStamp(node))
        return `노드 ${node.id} 시작을 기록했다.`
      })
    case 'node_finish':
      return finishNode($, env, input)
    default:
      throw new ToolRefusal(`알 수 없는 도구: ${name}`)
  }
}

async function write(
  $: $,
  env: ToolEnv,
  input: Record<string, unknown>,
  fn: (graph: Graph, now: number) => string,
): Promise<string> {
  return mutate($, graphDir(env, input.graph_id), (graph, now) => ({ graph, result: fn(graph, now) }))
}

function putNode($: $, env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  return write($, env, input, (graph, now) => {
    const id = String(input.id)
    const fields = {
      id,
      title: String(input.title ?? ''),
      summary: String(input.summary ?? ''),
      detail: input.detail === undefined ? undefined : normalizeDetail(input.detail as NodeDetail),
    }
    const errors = validateNodeFields(fields)
    if (errors.length > 0) throw new ToolRefusal(`노드 검증 실패:\n- ${errors.join('\n- ')}`)

    const existing = graph.nodes[id]
    const notes: string[] = []
    const node: TodoNode = existing ?? { id, title: fields.title, summary: fields.summary, created_at: new Date(now).toISOString() }
    const wasApproved = existing !== undefined && nodeStatus(existing) !== 'abstract' && nodeStatus(existing) !== 'concrete'
    node.title = fields.title
    node.summary = fields.summary
    if (fields.detail && canonicalJson(fields.detail) !== canonicalJson(node.detail ?? null)) {
      node.detail = fields.detail
      node.detail_updated_at = stampAfter(now, latestStamp(node))
      if (wasApproved) notes.push('detail이 바뀌어 기존 승인이 무효가 됨. 사람이 패널에서 다시 승인해야 함')
    }
    graph.nodes[id] = node
    if (!graph.meta.node_order.includes(id)) graph.meta.node_order.push(id)

    notes.push(...mentionWarnings(graph, id))
    for (const c of scopeConflicts(graph).filter(c => c.a === id || c.b === id)) {
      notes.push(`scope 충돌: ${c.a}(${c.paths[0]}) ↔ ${c.b}(${c.paths[1]}). 간선으로 순서를 정하거나 scope를 나눌 것`)
    }
    for (const e of graph.edges.filter(e => e.from === id || e.to === id)) notes.push(...edgeState(graph, e).broken)
    return [`노드 ${id}: ${nodeStatus(node)}`, ...notes.map(n => `- ${n}`)].join('\n')
  })
}

function normalizeDetail(d: NodeDetail): NodeDetail {
  return {
    scope: { include: d.scope?.include ?? [], exclude: d.scope?.exclude ?? [] },
    inputs: d.inputs ?? [],
    outputs: d.outputs ?? [],
    decisions: (d.decisions ?? []).map(x => ({ ...x, alternatives: x.alternatives ?? [] })),
    references: d.references ?? [],
    constraints: d.constraints ?? [],
    acceptance: d.acceptance ?? [],
  }
}

function putEdge($: $, env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  return write($, env, input, (graph) => {
    const from = String(input.from)
    const to = String(input.to)
    const bindings = ((input.bindings as Edge['bindings'] | undefined) ?? []).map(b => ({ output: b.output, input: b.input }))
    const existing = graph.edges.find(e => e.from === from && e.to === to)
    const edge: Edge = { from, to, bindings, confirmation: existing?.confirmation }
    const errors = validateEdge(graph, edge)
    if (errors.length > 0) throw new ToolRefusal(`간선 검증 실패:\n- ${errors.join('\n- ')}`)
    graph.edges = [...graph.edges.filter(e => e !== existing), edge]
    const state = edgeState(graph, edge)
    const notes = [`간선 ${from} → ${to} (배선 ${bindings.length}개)`]
    if (!state.confirmed) notes.push('- 배선 확인 대기: 사람이 패널에서 확인해야 실행 가능')
    for (const c of scopeConflicts(graph)) notes.push(`- scope 충돌: ${c.a} ↔ ${c.b}`)
    return notes.join('\n')
  })
}

function finishNode($: $, env: ToolEnv, input: Record<string, unknown>): Promise<string> {
  return write($, env, input, (graph, now) => {
    const node = requireNode(graph, input.node_id)
    if (nodeStatus(node) !== 'in_progress') throw new ToolRefusal(`진행 중인 노드가 아님: ${nodeStatus(node)}`)
    const raw = input.outcome as NodeOutcome
    const outcome: NodeOutcome = {
      outputs: raw.outputs ?? [],
      decisions_made: (raw.decisions_made ?? []).map(x => ({ ...x, alternatives: x.alternatives ?? [] })),
    }
    const errors = validatePorts('outcome.outputs', outcome.outputs)
    if (errors.length > 0) throw new ToolRefusal(errors.join('\n'))
    const planned = outputsOf(node).ports
    node.outcome = outcome
    node.finished_at = stampAfter(now, latestStamp(node))
    const notes = [`노드 ${node.id} 완료를 기록했다.`]
    const differs = (name: string): boolean =>
      planned.find(p => p.name === name)?.signature !== outcome.outputs.find(p => p.name === name)?.signature
    for (const e of outgoing(graph, node.id)) {
      const changed = e.bindings.filter(b => differs(b.output))
      if (changed.length > 0) notes.push(`- 계획과 다른 출력이 ${e.to}로 연결됨(${changed.map(b => b.output).join(', ')}). 배선 재확인 필요`)
    }
    return notes.join('\n')
  })
}

export async function approveNode($: $, dir: string, id: string): Promise<void> {
  await mutate($, dir, (graph, now) => {
    const node = requireNode(graph, id)
    if (nodeStatus(node) !== 'concrete') throw new ToolRefusal(`승인할 수 없는 상태: ${nodeStatus(node)}`)
    node.approved_at = stampAfter(now, latestStamp(node))
    return { graph, result: undefined }
  })
}

export async function confirmEdge($: $, dir: string, from: string, to: string): Promise<void> {
  await mutate($, dir, (graph, now) => {
    const edge = graph.edges.find(e => e.from === from && e.to === to)
    if (!edge) throw new ToolRefusal('간선 없음')
    const state = edgeState(graph, edge)
    if (state.broken.length > 0) throw new ToolRefusal(state.broken.join('\n'))
    edge.confirmation = confirmationFor(graph, edge, new Date(now).toISOString())
    return { graph, result: undefined }
  })
}
