import type { EngineInterface } from 'claude-code'

import { canonicalJson, type Edge, type Graph, type GraphMeta, sortEdges, type TodoNode } from './model'

type $ = EngineInterface

export type Loaded = { graph: Graph; snapshot: Map<string, string | null> }

export class ConflictError extends Error {}

export async function projectRoot($: $): Promise<string> {
  const cwd = await $.session.cwd()
  const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined)
  const top = git?.exitCode === 0 ? git.stdout.trim() : ''
  return top || cwd
}

export const baseDir = (root: string, dirName: string): string => `${root}/${dirName}`

const paths = (dir: string) => ({
  meta: `${dir}/graph.json`,
  nodes: `${dir}/nodes`,
  node: (id: string) => `${dir}/nodes/${id}.json`,
  edges: `${dir}/edges.json`,
})

async function readOrNull($: $, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
}

export async function listGraphs($: $, base: string): Promise<{ id: string; dir: string; graph: Graph }[]> {
  if (!(await $.fs.exists(base))) return []
  const entries = (await $.fs.list(base)).filter(e => e.kind === 'dir').map(e => e.name).sort()
  const found: { id: string; dir: string; graph: Graph }[] = []
  for (const id of entries) {
    const dir = `${base}/${id}`
    if (!(await $.fs.exists(paths(dir).meta))) continue
    found.push({ id, dir, graph: (await loadGraph($, dir)).graph })
  }
  return found
}

export async function loadGraph($: $, dir: string): Promise<Loaded> {
  const p = paths(dir)
  const snapshot = new Map<string, string | null>()
  const metaText = await readOrNull($, p.meta)
  if (metaText === null) throw new Error(`그래프 없음: ${dir}`)
  snapshot.set(p.meta, metaText)
  const meta = JSON.parse(metaText) as GraphMeta
  const nodes: Record<string, TodoNode> = {}
  if (await $.fs.exists(p.nodes)) {
    for (const entry of await $.fs.list(p.nodes)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const path = `${p.nodes}/${entry.name}`
      const text = String(await $.fs.read(path))
      snapshot.set(path, text)
      const node = JSON.parse(text) as TodoNode
      nodes[node.id] = node
    }
  }
  const edgesText = await readOrNull($, p.edges)
  snapshot.set(p.edges, edgesText)
  const edges = edgesText === null ? [] : (JSON.parse(edgesText) as Edge[])
  return { graph: { meta, nodes, edges }, snapshot }
}

// Writes only the files whose canonical text changed, and refuses when any of them
// changed on disk since it was read: another session or a checkout got there first.
export async function saveGraph($: $, dir: string, loaded: Loaded, next: Graph): Promise<void> {
  const p = paths(dir)
  const wanted = new Map<string, string | null>()
  wanted.set(p.meta, canonicalJson(next.meta))
  wanted.set(p.edges, canonicalJson(sortEdges(next.edges)))
  for (const node of Object.values(next.nodes)) wanted.set(p.node(node.id), canonicalJson(node))
  for (const id of Object.keys(loaded.graph.nodes)) if (!next.nodes[id]) wanted.set(p.node(id), null)

  const changes = [...wanted].filter(([path, text]) => (loaded.snapshot.get(path) ?? null) !== text)
  for (const [path] of changes) {
    const onDisk = await readOrNull($, path)
    if (onDisk !== (loaded.snapshot.get(path) ?? null)) {
      throw new ConflictError(`${path}가 읽은 뒤에 바뀌었음. 다시 읽고 시도할 것`)
    }
  }
  for (const [path, text] of changes) {
    if (text === null) await $.process.run(['rm', '-f', path])
    else await $.fs.write(path, text)
  }
}

export async function createGraph($: $, dir: string, meta: GraphMeta): Promise<void> {
  const p = paths(dir)
  if (await $.fs.exists(p.meta)) throw new Error(`이미 있는 그래프: ${meta.id}`)
  await $.fs.write(p.meta, canonicalJson(meta))
  await $.fs.write(p.edges, canonicalJson([]))
}
