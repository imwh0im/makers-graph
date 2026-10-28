export const INTERFACE_KINDS = ['table', 'type', 'function', 'endpoint', 'component', 'other'] as const
export type InterfaceKind = (typeof INTERFACE_KINDS)[number]

export type Port = { name: string; kind: InterfaceKind; signature: string }
export type Decision = { question: string; choice: string; reason: string; alternatives: string[] }
export type Reference = { target: string; note: string }
export type Criterion = { statement: string; check?: string }
export type Scope = { include: string[]; exclude: string[] }

export type NodeDetail = {
  scope: Scope
  inputs: Port[]
  outputs: Port[]
  decisions: Decision[]
  references: Reference[]
  constraints: string[]
  acceptance: Criterion[]
}

export type NodeOutcome = { outputs: Port[]; decisions_made: Decision[] }

export type TodoNode = {
  id: string
  title: string
  summary: string
  detail?: NodeDetail
  outcome?: NodeOutcome
  created_at: string
  detail_updated_at?: string
  approved_at?: string
  started_at?: string
  finished_at?: string
}

export type Binding = { output: string; input: string }

export type ConfirmedPair = Binding & { output_signature: string; input_signature: string }

export type Edge = {
  from: string
  to: string
  bindings: Binding[]
  confirmation?: { at: string; pairs: ConfirmedPair[] }
}

export type GraphMeta = {
  id: string
  title: string
  goal: string
  node_order: string[]
  created_at: string
}

export type Graph = { meta: GraphMeta; nodes: Record<string, TodoNode>; edges: Edge[] }

export type NodeStatus = 'abstract' | 'concrete' | 'approved' | 'in_progress' | 'done'

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

// Each timestamp counts only when later than the step before it, so editing
// an approved detail drops the node back to concrete without erasing history.
export function nodeStatus(node: TodoNode): NodeStatus {
  const concretized = node.detail ? node.detail_updated_at : undefined
  if (!concretized) return 'abstract'
  const approved = after(node.approved_at, concretized)
  if (!approved) return 'concrete'
  const started = after(node.started_at, approved)
  if (!started) return 'approved'
  return after(node.finished_at, started) ? 'done' : 'in_progress'
}

function after(stamp: string | undefined, than: string): string | undefined {
  return stamp !== undefined && stamp > than ? stamp : undefined
}

export function isStarted(node: TodoNode): boolean {
  const status = nodeStatus(node)
  return status === 'in_progress' || status === 'done'
}

export function outputsOf(node: TodoNode): { ports: Port[]; source: 'outcome' | 'plan' } {
  if (node.outcome && nodeStatus(node) === 'done') return { ports: node.outcome.outputs, source: 'outcome' }
  return { ports: node.detail?.outputs ?? [], source: 'plan' }
}

export type EdgeState = {
  satisfied: boolean
  stale: boolean
  confirmed: boolean
  broken: string[]
}

export function edgeState(graph: Graph, edge: Edge): EdgeState {
  const from = graph.nodes[edge.from]
  const to = graph.nodes[edge.to]
  if (!from || !to) return { satisfied: false, stale: false, confirmed: false, broken: ['missing endpoint'] }
  const fromDone = nodeStatus(from) === 'done'
  const stale =
    isStarted(to) && (!fromDone || (from.finished_at ?? '') > (to.started_at ?? ''))
  const outputs = outputsOf(from).ports
  const inputs = to.detail?.inputs ?? []
  const broken: string[] = []
  for (const b of edge.bindings) {
    if (!outputs.some(p => p.name === b.output)) broken.push(`출력 포트 없음: ${edge.from}.${b.output}`)
    if (!inputs.some(p => p.name === b.input)) broken.push(`입력 포트 없음: ${edge.to}.${b.input}`)
  }
  return { satisfied: fromDone, stale, confirmed: isConfirmed(edge, outputs, inputs), broken }
}

function isConfirmed(edge: Edge, outputs: Port[], inputs: Port[]): boolean {
  if (edge.bindings.length === 0) return true
  const pairs = edge.confirmation?.pairs
  if (!pairs || pairs.length !== edge.bindings.length) return false
  return edge.bindings.every(b => {
    const pair = pairs.find(p => p.output === b.output && p.input === b.input)
    const out = outputs.find(p => p.name === b.output)
    const inp = inputs.find(p => p.name === b.input)
    return (
      pair !== undefined &&
      out !== undefined &&
      inp !== undefined &&
      pair.output_signature === out.signature &&
      pair.input_signature === inp.signature
    )
  })
}

export function confirmationFor(graph: Graph, edge: Edge, at: string): Edge['confirmation'] {
  const outputs = outputsOf(graph.nodes[edge.from]!).ports
  const inputs = graph.nodes[edge.to]?.detail?.inputs ?? []
  return {
    at,
    pairs: edge.bindings.map(b => ({
      ...b,
      output_signature: outputs.find(p => p.name === b.output)?.signature ?? '',
      input_signature: inputs.find(p => p.name === b.input)?.signature ?? '',
    })),
  }
}

export const incoming = (graph: Graph, id: string): Edge[] => graph.edges.filter(e => e.to === id)
export const outgoing = (graph: Graph, id: string): Edge[] => graph.edges.filter(e => e.from === id)

export type Readiness = { ready: boolean; stale: boolean; reasons: string[] }

export function readiness(graph: Graph, id: string): Readiness {
  const node = graph.nodes[id]!
  const edges = incoming(graph, id)
  const states = edges.map(e => ({ edge: e, state: edgeState(graph, e) }))
  const reasons: string[] = []
  const status = nodeStatus(node)
  if (status !== 'approved') reasons.push(`상태가 ${status}`)
  for (const { edge, state } of states) {
    if (!state.satisfied) reasons.push(`선행 미완료: ${edge.from}`)
    if (!state.confirmed) reasons.push(`배선 미확인: ${edge.from} → ${edge.to}`)
    reasons.push(...state.broken)
  }
  const bound = new Set(edges.flatMap(e => e.bindings.map(b => b.input)))
  for (const port of node.detail?.inputs ?? []) {
    if (!bound.has(port.name)) reasons.push(`연결되지 않은 입력: ${port.name}`)
  }
  return { ready: reasons.length === 0, stale: states.some(s => s.state.stale), reasons }
}

export function orderIndex(graph: Graph): Map<string, number> {
  const ids = [
    ...graph.meta.node_order.filter(id => graph.nodes[id]),
    ...Object.keys(graph.nodes)
      .filter(id => !graph.meta.node_order.includes(id))
      .sort(),
  ]
  return new Map(ids.map((id, i) => [id, i]))
}

// Longest-path layering: a node sits one layer right of its deepest predecessor.
export function layers(graph: Graph): Map<string, number> {
  const order = orderIndex(graph)
  const ids = [...order.keys()]
  const indegree = new Map(ids.map(id => [id, 0]))
  for (const e of graph.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
  const layer = new Map<string, number>()
  let queue = ids.filter(id => indegree.get(id) === 0)
  for (const id of queue) layer.set(id, 0)
  while (queue.length > 0) {
    const next: string[] = []
    for (const id of queue) {
      for (const e of outgoing(graph, id)) {
        layer.set(e.to, Math.max(layer.get(e.to) ?? 0, (layer.get(id) ?? 0) + 1))
        const left = (indegree.get(e.to) ?? 0) - 1
        indegree.set(e.to, left)
        if (left === 0) next.push(e.to)
      }
    }
    queue = next.sort((a, b) => order.get(a)! - order.get(b)!)
  }
  return layer
}

export function reaches(graph: Graph, from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of outgoing(graph, id)) stack.push(e.to)
  }
  return false
}

const normalizePath = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '')

function overlaps(a: string, b: string): boolean {
  const x = normalizePath(a)
  const y = normalizePath(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`) || x === '' || y === ''
}

export type ScopeConflict = { a: string; b: string; paths: [string, string] }

// Nodes with no path between them run in parallel, so a shared path breaks isolation.
export function scopeConflicts(graph: Graph): ScopeConflict[] {
  const ids = [...orderIndex(graph).keys()].filter(id => graph.nodes[id]!.detail)
  const found: ScopeConflict[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!
      const b = ids[j]!
      if (reaches(graph, a, b) || reaches(graph, b, a)) continue
      const hit = firstOverlap(graph.nodes[a]!.detail!.scope.include, graph.nodes[b]!.detail!.scope.include)
      if (hit) found.push({ a, b, paths: hit })
    }
  }
  return found
}

function firstOverlap(xs: string[], ys: string[]): [string, string] | undefined {
  for (const x of xs) for (const y of ys) if (overlaps(x, y)) return [x, y]
  return undefined
}

export function nodeText(node: TodoNode): string {
  const d = node.detail
  const parts = [node.summary]
  if (d) {
    parts.push(
      ...d.decisions.flatMap(x => [x.question, x.choice, x.reason, ...x.alternatives]),
      ...d.references.map(r => r.note),
      ...d.constraints,
      ...d.acceptance.flatMap(c => [c.statement, c.check ?? '']),
      ...[...d.inputs, ...d.outputs].map(p => p.signature),
    )
  }
  return parts.join('\n')
}

// A node names only its own ports; another node's id or title in its text is a hidden dependency.
export function mentionWarnings(graph: Graph, id: string): string[] {
  const text = nodeText(graph.nodes[id]!)
  const warnings: string[] = []
  for (const other of Object.values(graph.nodes)) {
    if (other.id === id) continue
    const names = [other.id, other.title].filter(n => n.length >= 2)
    const hit = names.find(n => text.includes(n))
    if (hit) warnings.push(`노드 본문에 다른 노드(${other.id})의 이름 "${hit}"이 있음. 포트 이름으로 바꿀 것`)
  }
  return warnings
}

export function validateNodeFields(node: Pick<TodoNode, 'id' | 'title' | 'summary' | 'detail'>): string[] {
  const errors: string[] = []
  if (!ID_PATTERN.test(node.id)) errors.push(`id 형식 오류: ${node.id} (소문자·숫자·_·-, 64자 이하)`)
  if (!node.title.trim()) errors.push('title이 비어 있음')
  if (!node.summary.trim()) errors.push('summary가 비어 있음')
  if (node.detail) errors.push(...validateDetail(node.detail))
  return errors
}

function validateDetail(d: NodeDetail): string[] {
  const errors: string[] = []
  errors.push(...validatePorts('inputs', d.inputs), ...validatePorts('outputs', d.outputs))
  if (d.acceptance.length === 0) errors.push('acceptance는 1개 이상')
  d.acceptance.forEach((c, i) => {
    if (!c.statement.trim()) errors.push(`acceptance[${i}].statement가 비어 있음`)
  })
  d.decisions.forEach((x, i) => {
    if (!x.question.trim() || !x.choice.trim()) errors.push(`decisions[${i}]의 question·choice가 비어 있음`)
  })
  return errors
}

export function validatePorts(label: string, ports: Port[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const p of ports) {
    if (!ID_PATTERN.test(p.name)) errors.push(`${label} 포트 이름 형식 오류: ${p.name}`)
    if (seen.has(p.name)) errors.push(`${label} 포트 이름 중복: ${p.name}`)
    if (!(INTERFACE_KINDS as readonly string[]).includes(p.kind)) errors.push(`${label}.${p.name} kind 오류: ${p.kind}`)
    seen.add(p.name)
  }
  return errors
}

export function validateEdge(graph: Graph, edge: Edge): string[] {
  const errors: string[] = []
  const from = graph.nodes[edge.from]
  const to = graph.nodes[edge.to]
  if (!from) errors.push(`노드 없음: ${edge.from}`)
  if (!to) errors.push(`노드 없음: ${edge.to}`)
  if (edge.from === edge.to) errors.push('자기 자신으로 가는 간선')
  if (!from || !to || errors.length > 0) return errors
  const existing = graph.edges.some(e => e.from === edge.from && e.to === edge.to)
  if (!existing && reaches(graph, edge.to, edge.from)) errors.push(`순환: ${edge.to}에서 ${edge.from}로 가는 경로가 이미 있음`)
  if (edge.bindings.length > 0 && (!from.detail || !to.detail)) {
    errors.push('배선은 양쪽 노드가 구체화된 뒤에만 가능')
    return errors
  }
  const outputs = outputsOf(from).ports
  const taken = new Set(
    graph.edges.filter(e => e.to === edge.to && e.from !== edge.from).flatMap(e => e.bindings.map(b => b.input)),
  )
  const seenInputs = new Set<string>()
  for (const b of edge.bindings) {
    if (!outputs.some(p => p.name === b.output)) errors.push(`${edge.from}에 출력 포트 ${b.output} 없음`)
    if (!to.detail!.inputs.some(p => p.name === b.input)) errors.push(`${edge.to}에 입력 포트 ${b.input} 없음`)
    if (taken.has(b.input) || seenInputs.has(b.input)) errors.push(`입력 포트 ${edge.to}.${b.input}는 이미 다른 배선에 연결됨`)
    seenInputs.add(b.input)
  }
  return errors
}

export type NodeContext = {
  node: Pick<TodoNode, 'id' | 'title' | 'summary' | 'detail'>
  status: NodeStatus
  inputs: {
    input: string
    expected: string
    provided_by: { node: string; output: string; signature: string; source: 'outcome' | 'plan'; status: NodeStatus }
  }[]
  unbound_inputs: string[]
  readiness: Readiness
}

// The node never names its providers; the context is assembled here, along the edges.
export function nodeContext(graph: Graph, id: string): NodeContext {
  const node = graph.nodes[id]!
  const inputs: NodeContext['inputs'] = []
  for (const edge of incoming(graph, id)) {
    const from = graph.nodes[edge.from]!
    const out = outputsOf(from)
    for (const b of edge.bindings) {
      inputs.push({
        input: b.input,
        expected: node.detail?.inputs.find(p => p.name === b.input)?.signature ?? '',
        provided_by: {
          node: from.id,
          output: b.output,
          signature: out.ports.find(p => p.name === b.output)?.signature ?? '',
          source: out.source,
          status: nodeStatus(from),
        },
      })
    }
  }
  const bound = new Set(inputs.map(i => i.input))
  return {
    node: { id: node.id, title: node.title, summary: node.summary, detail: node.detail },
    status: nodeStatus(node),
    inputs,
    unbound_inputs: (node.detail?.inputs ?? []).map(p => p.name).filter(n => !bound.has(n)),
    readiness: readiness(graph, id),
  }
}

export type Progress = Record<NodeStatus, number> & { total: number; ready: number }

export function progress(graph: Graph): Progress {
  const counts: Progress = { abstract: 0, concrete: 0, approved: 0, in_progress: 0, done: 0, total: 0, ready: 0 }
  for (const id of Object.keys(graph.nodes)) {
    counts[nodeStatus(graph.nodes[id]!)] += 1
    counts.total += 1
    if (readiness(graph, id).ready) counts.ready += 1
  }
  return counts
}

export function latestStamp(node: TodoNode): string {
  return [node.created_at, node.detail_updated_at, node.approved_at, node.started_at, node.finished_at]
    .filter((s): s is string => s !== undefined)
    .sort()
    .at(-1)!
}

// Status compares stamps strictly, so a new stamp must land after every stamp the node already has.
export function stampAfter(nowMs: number, ...previous: (string | undefined)[]): string {
  const floor = Math.max(...previous.filter((s): s is string => s !== undefined).map(s => Date.parse(s) + 1), 0)
  return new Date(Math.max(nowMs, floor)).toISOString()
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeys(v)
    }
    return out
  }
  return value
}

export function sortEdges(edges: Edge[]): Edge[] {
  return [...edges].sort((a, b) => (a.from === b.from ? cmp(a.to, b.to) : cmp(a.from, b.from)))
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
