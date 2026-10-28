import { type Edge, edgeState, type Graph, incoming, layers, nodeStatus, type NodeStatus, orderIndex, outgoing, outputsOf, type Port, progress, readiness } from './model'

export const STATUS_LABEL: Record<NodeStatus, string> = {
  abstract: '· 추상',
  concrete: '○ 구체화',
  approved: '◎ 승인',
  in_progress: '◐ 진행',
  done: '● 완료',
}

// Predecessors before successors; within a layer, the order the nodes were created in.
export function topoOrder(graph: Graph): string[] {
  const order = orderIndex(graph)
  const layer = layers(graph)
  return [...order.keys()].sort((a, b) => (layer.get(a) ?? 0) - (layer.get(b) ?? 0) || order.get(a)! - order.get(b)!)
}

export function edgeTag(graph: Graph, edge: Edge): string {
  const s = edgeState(graph, edge)
  return s.broken.length > 0 ? '끊김' : s.stale ? '재점검' : !s.confirmed ? '미확인' : s.satisfied ? '충족' : '대기'
}

export const wiring = (edge: Edge): string =>
  edge.bindings.length > 0 ? edge.bindings.map(b => `${b.output} → ${b.input}`).join(', ') : '순서만'

export const portLine = (p: Port): string => `${p.name} [${p.kind}] ${p.signature}`

export function inputSource(graph: Graph, id: string, input: string): { from: string; output: string } | null {
  for (const edge of incoming(graph, id)) {
    const b = edge.bindings.find(x => x.input === input)
    if (b) return { from: edge.from, output: b.output }
  }
  return null
}

export function progressLine(graph: Graph): string {
  const p = progress(graph)
  return `완료 ${p.done}/${p.total} · 실행 가능 ${p.ready} · 승인 대기 ${p.concrete} · 추상 ${p.abstract}`
}

// One column top to bottom, so no terminal width cuts it: the edge to the next node is the
// arrow between them, any other incoming edge is a ◀ line under the node it enters.
export function diagram(graph: Graph): string {
  const ids = topoOrder(graph)
  const num = new Map(ids.map((id, i) => [id, i + 1]))
  const lines = [graph.meta.title, `목표: ${graph.meta.goal}`, progressLine(graph), '']
  if (ids.length === 0) return [...lines, '(노드 없음)'].join('\n')

  ids.forEach((id, i) => {
    const node = graph.nodes[id]!
    const prev = ids[i - 1]
    lines.push(`[${num.get(id)}] ${node.title}  ${STATUS_LABEL[nodeStatus(node)]} (${id})`)
    for (const edge of incoming(graph, id).filter(e => e.from !== prev)) {
      lines.push(`    ◀ [${num.get(edge.from)}] ${wiring(edge)} · ${edgeTag(graph, edge)}`)
    }
    if (node.detail) {
      for (const p of node.detail.inputs) {
        const src = inputSource(graph, id, p.name)
        lines.push(`    in   ${portLine(p)}  ← ${src ? `[${num.get(src.from)}].${src.output}` : '미연결'}`)
      }
      for (const p of outputsOf(node).ports) lines.push(`    out  ${portLine(p)}`)
    } else {
      lines.push(`    (추상: 포트 미정) ${node.summary}`)
    }
    const next = ids[i + 1]
    if (!next) return
    const edge = graph.edges.find(e => e.from === id && e.to === next)
    lines.push(...(edge ? ['     │', `     ▼ ${wiring(edge)} · ${edgeTag(graph, edge)}`] : ['']))
  })
  return lines.join('\n')
}

export function nodeReport(graph: Graph, id: string): string {
  const node = graph.nodes[id]!
  const status = nodeStatus(node)
  const ready = readiness(graph, id)
  const d = node.detail
  const outs = outputsOf(node)
  const lines = [`${node.title} (${id})  ${STATUS_LABEL[status]}${ready.stale ? '  ! 앞 노드가 바뀌어 재점검 필요' : ''}`]
  const section = (title: string, items: string[]) => {
    if (items.length > 0) lines.push('', title, ...items.map(x => `  ${x}`))
  }
  section('요약', [node.summary])
  if (d) {
    section('범위', [...d.scope.include.map(p => `+ ${p}`), ...d.scope.exclude.map(p => `- ${p}`)])
    section('입력 포트', d.inputs.map(portLine))
    section(
      outs.source === 'outcome' ? '출력 포트 (실제 결과)' : '출력 포트',
      outs.ports.map(p => {
        const planned = d.outputs.find(q => q.name === p.name)
        return `${portLine(p)}${outs.source === 'outcome' && planned?.signature !== p.signature ? '  ≠ 계획' : ''}`
      }),
    )
    section('결정', d.decisions.map(x => `${x.question} → ${x.choice}${x.reason ? ` (${x.reason})` : ''}`))
    section('참고', d.references.map(r => `${r.target} · ${r.note}`))
    section('제약', d.constraints)
    section('완료 조건', d.acceptance.map(c => `□ ${c.statement}${c.check ? `  ⟨${c.check}⟩` : ''}`))
  } else {
    lines.push('', '아직 추상 노드다. 실행 직전에 구체화한다.')
  }
  if (node.outcome) section('실행 중 내린 결정', node.outcome.decisions_made.map(x => `${x.question} → ${x.choice}`))
  section('선행', incoming(graph, id).map(e => `← ${e.from}  ${wiring(e)} · ${edgeTag(graph, e)}`))
  section('후행', outgoing(graph, id).map(e => `→ ${e.to}  ${wiring(e)}`))
  lines.push('', ready.ready ? '실행 가능' : `실행 불가: ${ready.reasons.join(', ')}`)
  return lines.join('\n')
}
