import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActiveGraph } from '../types'
import { diagram, nodeReport } from './diagram'
import { progress } from './model'
import { baseDir, listGraphs, loadGraph, projectRoot } from './repo'
import { approveNode, confirmEdge, handleTool, TOOL_NAMES, TOOLS } from './tools'

type $ = EngineInterface

const PREFIX = 'mcp__todo-graph__'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const active = atom({ plugin: 'todo-graph', key: 'active' } as const, null as ActiveGraph | null, { shape: 'active-1' })

const USAGE = `/graph 사용법
  /graph [list]                   그래프 목록
  /graph use <graph-id>           활성 그래프로 연다
  /graph diagram                  활성 그래프 도식
  /graph show <node-id>           노드 스펙
  /graph approve <node-id>        노드 승인
  /graph confirm <from> <to>      간선 배선 확인
  /graph off                      모드 끄기`

const RULES = (g: ActiveGraph, base: string): string => `## todo-graph 모드 (활성 그래프: ${g.id})

작업 목록을 노드·간선 그래프로 관리한다. 노드는 격리된 작업 단위이고, 간선은 의존이자 출력 포트 → 입력 포트 배선이다.

- 그래프는 ${base}/ 아래 JSON이다. 이 파일들을 직접 쓰지 않는다(Edit/Write는 거부된다). ${PREFIX}* 도구만 쓴다. 도구는 ToolSearch "select:${TOOL_NAMES.map(n => PREFIX + n).join(',')}" 로 불러온다. 모든 도구는 graph_id를 명시한다.
- 노드는 먼저 title·summary만으로 추상적으로 나눈다. 구체화(detail)는 그 노드를 실행하기 직전에, node_context로 앞 노드의 실제 출력을 보고 한다.
- 노드 본문에는 다른 노드의 id나 제목을 쓰지 않는다. 필요한 것은 detail.inputs, 내놓는 것은 detail.outputs 포트로 선언하고, 연결은 edge_put의 bindings로 한다.
- detail.decisions에는 실행자가 혼자 내렸을 갈림길(질문·선택·이유)을 미리 확정한다.
- 승인과 배선 확인은 사람이 /graph approve <node-id>, /graph confirm <from> <to> 명령으로만 한다. 승인되지 않았거나 선행이 끝나지 않은 노드는 node_start가 거부한다. 승인이 필요하면 사람에게 그 명령을 알려준다.
- 노드 실행은 node_start → 작업(코드는 이 레포의 지침을 따른다) → node_finish(outcome) 순서다. 스펙에 없어 직접 내린 결정은 outcome.decisions_made에 남긴다.
- 기본 Task 목록은 노드 하나를 실행하는 동안의 세부 단계에만 쓴다.
- 사람이 그래프 모양을 보고 싶어 하면 graph_diagram 결과를 손대지 않고 코드 블록으로 보여준다.`

let dirName = '.todos'
let base: string | undefined

async function baseOf($: $): Promise<string> {
  base ??= baseDir(await projectRoot($), dirName)
  return base
}

// A policy plugin seated above may pass prompt.compose on past this mod, so the rules
// also go into the conversation itself each time a graph becomes active.
async function activate($: $, id: string, dir: string): Promise<void> {
  await update($, active, () => ({ id, dir }))
  await note($, `${RULES({ id, dir }, await baseOf($))}\n\n이후 작업은 활성 그래프 ${id} 기준이다.`)
}

async function note($: $, text: string): Promise<void> {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

async function graphList($: $): Promise<string> {
  const root = await baseOf($)
  const graphs = await listGraphs($, root).catch(() => [])
  if (graphs.length === 0) return `그래프가 없다 (${root}). Claude에게 목표를 말하면 그래프를 만든다.`
  const current = (await read($, active))?.id
  return graphs
    .map(item => {
      const p = progress(item.graph)
      return `${item.id === current ? '▸' : ' '} ${item.id}  ${item.graph.meta.title} · 완료 ${p.done}/${p.total} · 실행 가능 ${p.ready}`
    })
    .join('\n')
}

export const register: Register = (on, options) => {
  dirName = typeof options.dirName === 'string' && options.dirName.trim() ? options.dirName.trim() : '.todos'
  base = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'graph',
      description: 'todo-graph 모드: 그래프 목록·도식·노드 스펙을 보고, 노드 승인과 배선 확인을 한다',
      argumentHint: '[list | use <graph-id> | diagram | show <node> | approve <node> | confirm <from> <to> | off]',
    })
    for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: true })
    // Earlier versions opened a pane; a reload keeps it open with nothing left to draw it.
    await $.ui.close({ id: 'todo-graph' }).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'graph' }, async ($, e) => {
    const [verb = 'list', a, b] = e.args.trim().split(/\s+/).filter(Boolean)
    if (verb === 'list') return { text: await graphList($) }
    if (verb === 'off') {
      await update($, active, () => null)
      return { text: 'todo-graph 모드를 껐다.', context: ['todo-graph 모드가 꺼졌다. 이후로는 그래프 규칙을 따르지 않는다.'] }
    }
    if (verb === 'use') {
      if (!a) return { text: USAGE }
      const dir = `${await baseOf($)}/${a}`
      const exists = await loadGraph($, dir).then(() => true, () => false)
      if (!exists) return { text: `그래프 없음: ${a}` }
      await activate($, a, dir)
      return { text: `활성 그래프: ${a}` }
    }

    const g = await read($, active)
    if (!g) return { text: '활성 그래프가 없다. /graph use <graph-id> 로 먼저 연다.' }
    try {
      if (verb === 'diagram') return { text: diagram((await loadGraph($, g.dir)).graph) }
      if (verb === 'show' && a) {
        const { graph } = await loadGraph($, g.dir)
        return { text: graph.nodes[a] ? nodeReport(graph, a) : `노드 없음: ${a}` }
      }
      if (verb === 'approve' && a) {
        await approveNode($, g.dir, a)
        return { text: `승인: ${g.id}/${a}` }
      }
      if (verb === 'confirm' && a && b) {
        await confirmEdge($, g.dir, a, b)
        return { text: `배선 확인: ${a} → ${b}` }
      }
    } catch (err) {
      return { text: `거부: ${err instanceof Error ? err.message : String(err)}` }
    }
    return { text: USAGE }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const g = await read($, active)
    if (!g) return result
    return { sections: [...result.sections, { id: 'todo-graph:rules', text: RULES(g, await baseOf($)), scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith(PREFIX)) {
      const env = { base: await baseOf($), open: (id: string, dir: string) => activate($, id, dir) }
      try {
        return { result: await handleTool($, tool.slice(PREFIX.length), e as unknown as Record<string, unknown>, env) }
      } catch (err) {
        return { deny: err instanceof Error ? err.message : String(err) }
      }
    }
    if (EDIT_TOOLS.has(tool) && (await isGraphPath($, e as unknown as Record<string, unknown>, await baseOf($)))) {
      return { deny: `todo-graph: 그래프 파일은 직접 고칠 수 없다. ${PREFIX}* 도구를 쓸 것` }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}

async function isGraphPath($: $, input: Record<string, unknown>, base: string): Promise<boolean> {
  const raw = input.file_path ?? input.notebook_path
  if (typeof raw !== 'string') return false
  const path = raw.startsWith('/') ? raw : `${await $.session.cwd()}/${raw}`
  const normalized = path.replace(/\/\.\//g, '/')
  return normalized === base || normalized.startsWith(`${base}/`)
}
