export type ActiveGraph = { dir: string; id: string }

declare module 'claude-code' {
  interface PluginState {
    'todo-graph': {
      active: Shaped<ActiveGraph | null>
    }
  }
}
