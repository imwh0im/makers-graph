# makers-graph

A Claude Code marketplace holding **todo-graph**: a mode that turns a task list into a graph of nodes and edges.

- A **node** is an isolated unit of work. It never names another node; it declares the input ports it needs and the output ports it produces.
- An **edge** is both a dependency and a wiring: it binds an output port of one node to an input port of the next.
- Status is derived from a chain of timestamps (abstract → concrete → approved → in progress → done). Changing an approved spec drops the node back to concrete.
- Only a person approves a node or confirms a wiring, through the `/graph` command. Claude cannot start a node that is not approved or whose predecessors are not done.

Graphs live as JSON under `.todos/` at the project root (the git top level), so they can be committed and reviewed. Claude edits them only through the plugin's tools; direct `Edit`/`Write` on those files is refused.

## Install

At the prompt of a terminal session:

```
/plugin install todo-graph --marketplace imwh0im/makers-graph
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install todo-graph --marketplace imwh0im/makers-graph
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `imwh0im/makers-graph`, then Add plugin.

## Usage

Tell Claude the goal and ask it to plan it as a graph. Claude creates the graph and its abstract nodes, then fills in each node's spec (scope, ports, decisions, acceptance criteria) right before running it.

```
/graph [list]                   list graphs
/graph use <graph-id>           open a graph as the active one
/graph diagram                  diagram of the active graph
/graph show <node-id>           a node's spec
/graph approve <node-id>        approve a node
/graph confirm <from> <to>      confirm an edge's wiring
/graph off                      turn the mode off
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `dirName` | `.todos` | Directory under the project root that holds the graphs |

## License

MIT
