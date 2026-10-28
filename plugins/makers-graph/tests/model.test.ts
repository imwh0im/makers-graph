import { expect, test } from 'claude-code/testing'

import { signupGraph } from './fixture'
import { diagram, nodeReport, topoOrder } from '../hooks/diagram'
import {
  edgeState,
  mentionWarnings,
  nodeStatus,
  readiness,
  scopeConflicts,
  stampAfter,
  validateEdge,
} from '../hooks/model'

const DIAGRAM = [
  "회원가입 기능 구현",
  "목표: 이메일 회원가입",
  "완료 1/6 · 실행 가능 0 · 승인 대기 1 · 추상 3",
  "",
  "[1] DB 마이그레이션  ● 완료 (migration)",
  "    out  users [table] users(id, email UNIQUE, email_verified_at)",
  "",
  "[2] 가드  ○ 구체화 (guard)",
  "    out  auth_guard [function] guard(req) -> 401 | next",
  "",
  "[3] 서비스 로직  ◐ 진행 (service)",
  "    ◀ [1] users → user_store · 충족",
  "    in   user_store [table] users(id, email UNIQUE, email_verified_at)  ← [1].users",
  "    out  signup [function] signup(email, password) -> Result<User>",
  "     │",
  "     ▼ 순서만 · 대기",
  "[4] API 엔드포인트  · 추상 (api)",
  "    ◀ [2] 순서만 · 대기",
  "    (추상: 포트 미정) API 엔드포인트 작업",
  "     │",
  "     ▼ 순서만 · 대기",
  "[5] 가입 화면 UI  · 추상 (ui)",
  "    (추상: 포트 미정) 가입 화면 UI 작업",
  "     │",
  "     ▼ 순서만 · 대기",
  "[6] 통합 검증  · 추상 (e2e)",
  "    ◀ [1] 순서만 · 충족",
  "    (추상: 포트 미정) 통합 검증 작업"
].join('\n')

test('도식은 선행부터 한 줄기로 그리고 배선과 포트를 함께 적는다', async () => {
  const g = signupGraph()
  expect(topoOrder(g)).toEqual(['migration', 'guard', 'service', 'api', 'ui', 'e2e'])
  expect(diagram(g)).toBe(DIAGRAM)
  expect(diagram(signupGraph())).toBe(DIAGRAM)
})

test('노드 스펙은 포트, 선행 배선, 실행 가능 여부를 텍스트로 보여준다', async () => {
  const report = nodeReport(signupGraph(), 'service')
  expect(report).toContain('서비스 로직 (service)  ◐ 진행')
  expect(report).toContain('  user_store [table] users(id, email UNIQUE, email_verified_at)')
  expect(report).toContain('← migration  users → user_store · 충족')
  expect(report).toContain('→ api  순서만')
  expect(nodeReport(signupGraph(), 'api')).toContain('아직 추상 노드다.')
})

test('상태는 timestamp 사슬에서 계산된다', async () => {
  const g = signupGraph()
  expect(nodeStatus(g.nodes.migration!)).toBe('done')
  expect(nodeStatus(g.nodes.service!)).toBe('in_progress')
  expect(nodeStatus(g.nodes.guard!)).toBe('concrete')
  expect(nodeStatus(g.nodes.api!)).toBe('abstract')
  const edited = { ...g.nodes.service!, detail_updated_at: stampAfter(0, g.nodes.service!.started_at) }
  expect(nodeStatus(edited)).toBe('concrete')
})

test('앞 노드가 다시 열리면 간선이 재점검 상태가 된다', async () => {
  const g = signupGraph()
  const edge = g.edges.find(e => e.from === 'migration' && e.to === 'service')!
  expect(edgeState(g, edge)).toEqual({ satisfied: true, stale: false, confirmed: true, broken: [] })
  g.nodes.migration!.detail_updated_at = stampAfter(0, g.nodes.migration!.finished_at)
  expect(edgeState(g, edge).stale).toBe(true)
  expect(readiness(g, 'service').stale).toBe(true)
})

test('출력 시그니처가 바뀌면 배선 확인이 무효가 된다', async () => {
  const g = signupGraph()
  const edge = g.edges.find(e => e.from === 'migration' && e.to === 'service')!
  g.nodes.migration!.outcome!.outputs[0]!.signature = 'users(id, email)'
  expect(edgeState(g, edge).confirmed).toBe(false)
})

test('실행 가능 여부는 승인, 선행 완료, 배선 확인, 입력 연결을 모두 본다', async () => {
  const g = signupGraph()
  g.nodes.guard!.approved_at = stampAfter(0, g.nodes.guard!.detail_updated_at)
  expect(readiness(g, 'guard').ready).toBe(true)
  g.nodes.guard!.detail!.inputs.push({ name: 'session', kind: 'type', signature: 'Session' })
  g.nodes.guard!.detail_updated_at = stampAfter(0, g.nodes.guard!.approved_at)
  g.nodes.guard!.approved_at = stampAfter(0, g.nodes.guard!.detail_updated_at)
  expect(readiness(g, 'guard').reasons).toEqual(['연결되지 않은 입력: session'])
})

test('간선 검증은 순환과 중복 입력을 거부한다', async () => {
  const g = signupGraph()
  expect(validateEdge(g, { from: 'e2e', to: 'migration', bindings: [] })[0]).toMatch(/순환/)
  expect(validateEdge(g, { from: 'api', to: 'api', bindings: [] })).toContain('자기 자신으로 가는 간선')
  expect(validateEdge(g, { from: 'guard', to: 'service', bindings: [{ output: 'auth_guard', input: 'user_store' }] })).toContain(
    '입력 포트 service.user_store는 이미 다른 배선에 연결됨',
  )
})

test('경로 없는 노드끼리 scope가 겹치면 충돌이다', async () => {
  const g = signupGraph()
  expect(scopeConflicts(g)).toEqual([])
  g.nodes.guard!.detail!.scope.include = ['src/signup/guard.ts']
  expect(scopeConflicts(g)).toEqual([{ a: 'service', b: 'guard', paths: ['src/signup', 'src/signup/guard.ts'] }])
})

test('노드 본문에 다른 노드 이름이 나오면 경고한다', async () => {
  const g = signupGraph()
  g.nodes.guard!.summary = '서비스 로직이 만든 세션을 검사'
  expect(mentionWarnings(g, 'guard')).toHaveLength(1)
})
