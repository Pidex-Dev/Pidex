# Computer Use JavaScript API

`mcp__node_repl__js` is the host-provided model entry point for computer control. This page documents parameters and return fields; see `skills/computer-use/SKILL.md` for the workflow.

## Calling conventions

- Each chat owns an isolated process and persistent evaluation context. Bindings persist across cells until js_reset or connection shutdown; separate chats remain isolated. Timeout or cancellation ends the active cell.
- Only `computer` and `nodeRepl` are exposed. No arbitrary imports, Shell, filesystem, network or native helper credentials.
- Top-level await is supported. Script errors become tool errors; nodeRepl.write text becomes tool output.

## nodeRepl

```ts
nodeRepl.write(value: unknown): void
nodeRepl.emitImage(data: Uint8Array | string, mimeType?: string): void
```

Screenshots from computer.read already use model image results. Do not emit the same screenshot again; a second raster in one result causes images to be removed.

## computer

```ts
await computer.apps(): { windows: { ref: string; name: string; appId?: string; pid?: number }[] }
await computer.read(windowRef: string): {
  text: string
  observationId?: string
  token?: string
  images?: { data: string; mimeType: string }[]
  code?: string
  isError?: boolean
}
await computer.action(
  windowRef: string,
  observationId: string,
  operation: ComputerOperation,
): { text: string; code?: string; isError?: boolean; images?: ... }
```

### ComputerOperation

```ts
type ComputerOperation = {
  action:
    | 'click'
    | 'double_click'
    | 'right_click'
    | 'type_text'
    | 'press_key'
    | 'hotkey'
    | 'scroll'
    | 'drag'
  elementToken?: string
  x?: number
  y?: number
  endX?: number
  endY?: number
  text?: string
  key?: string
  keys?: string[]
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  delivery?: 'background' | 'foreground'
}
```

Constraints match the host computer tools: type_text requires text; press_key requires key; hotkey requires keys; scroll requires direction. Click actions require elementToken or x/y. Drag always requires x, y, endX and endY.

## Authorization and approval

- computer.apps and computer.read observe only. computer.action changes external state and interacts with applications; it is unavailable in Plan.
- Every computer API call passes host registration, validation, hooks, authorization and approval, audited as ComputerApps/ComputerRead/ComputerAction.
- Initial computer.read access requires chat approval. The script ends when approval is needed and the read is checkpointed. Approval executes only that read and returns its result for the MCP call; remaining script code does not execute.
