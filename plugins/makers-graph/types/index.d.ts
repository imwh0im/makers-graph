export type ActiveGraph = { dir: string; id: string }

declare module 'claude-code' {
  interface PluginState {
    'makers-graph': {
      active: Shaped<ActiveGraph | null>
    }
  }
}
