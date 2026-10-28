import type { Graph, NodeDetail, TodoNode } from '../hooks/model'

const T = (n: number): string => new Date(Date.UTC(2026, 9, 28, 0, 0, n)).toISOString()

const detail = (over: Partial<NodeDetail>): NodeDetail => ({
  scope: { include: [], exclude: [] },
  inputs: [],
  outputs: [],
  decisions: [],
  references: [],
  constraints: [],
  acceptance: [{ statement: '동작한다' }],
  ...over,
})

const node = (id: string, title: string, over: Partial<TodoNode> = {}): TodoNode => ({
  id,
  title,
  summary: `${title} 작업`,
  created_at: T(0),
  ...over,
})

// 회원가입: 마이그레이션 → 서비스 → API → UI, 가드는 서비스와 병렬로 API에 연결, 통합 검증은 UI 뒤.
export function signupGraph(): Graph {
  return {
    meta: { id: 'signup', title: '회원가입 기능 구현', goal: '이메일 회원가입', created_at: T(0),
      node_order: ['migration', 'service', 'guard', 'api', 'ui', 'e2e'] },
    nodes: {
      migration: node('migration', 'DB 마이그레이션', {
        detail: detail({ scope: { include: ['db/migrations'], exclude: [] },
          outputs: [{ name: 'users', kind: 'table', signature: 'users(id, email UNIQUE, email_verified_at)' }] }),
        detail_updated_at: T(1), approved_at: T(2), started_at: T(3), finished_at: T(4),
        outcome: { outputs: [{ name: 'users', kind: 'table', signature: 'users(id, email UNIQUE, email_verified_at)' }], decisions_made: [] },
      }),
      service: node('service', '서비스 로직', {
        detail: detail({ scope: { include: ['src/signup'], exclude: [] },
          inputs: [{ name: 'user_store', kind: 'table', signature: 'users(id, email UNIQUE, email_verified_at)' }],
          outputs: [{ name: 'signup', kind: 'function', signature: 'signup(email, password) -> Result<User>' }] }),
        detail_updated_at: T(5), approved_at: T(6), started_at: T(7),
      }),
      guard: node('guard', '가드', {
        detail: detail({ scope: { include: ['src/auth/guards'], exclude: [] },
          outputs: [{ name: 'auth_guard', kind: 'function', signature: 'guard(req) -> 401 | next' }] }),
        detail_updated_at: T(8),
      }),
      api: node('api', 'API 엔드포인트'),
      ui: node('ui', '가입 화면 UI'),
      e2e: node('e2e', '통합 검증'),
    },
    edges: [
      { from: 'migration', to: 'service', bindings: [{ output: 'users', input: 'user_store' }],
        confirmation: { at: T(6), pairs: [{ output: 'users', input: 'user_store',
          output_signature: 'users(id, email UNIQUE, email_verified_at)', input_signature: 'users(id, email UNIQUE, email_verified_at)' }] } },
      { from: 'service', to: 'api', bindings: [] },
      { from: 'guard', to: 'api', bindings: [] },
      { from: 'api', to: 'ui', bindings: [] },
      { from: 'ui', to: 'e2e', bindings: [] },
      { from: 'migration', to: 'e2e', bindings: [] },
    ],
  }
}
