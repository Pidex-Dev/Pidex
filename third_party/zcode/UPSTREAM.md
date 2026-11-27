# ZCode upstream sources

Pidex adapts code and model-option data from [zai-org/ZCode](https://github.com/zai-org/ZCode). Copyright the ZCode authors. See the [Apache License 2.0](LICENSE).

## Model option data

The bundled v2 model snapshot includes a static extract of the ZCode built-in model-option rules. The source extract is maintained in the `pidex-model-catalog` repository.

- **Source file** `config/provider/zcode-builtin.json`
- **Source revision** `33` (git `3c5b227649371507ddc4eb46ac5133afe6db1cab`, package version `3.16.2`)
- **License** Apache-2.0
- **Extracted scope** The `optionSpecs` contribution of `config.modelConfigRules` for model, protocol, and site rules.

## Restricted CEL and JSON Merge Patch

Adapted from `packages/model-option-map`.

- Upstream revision: `3c5b227649371507ddc4eb46ac5133afe6db1cab`
  ("chore: sync ZCode source", 2026-10-20)
- Upstream files ported: `src/types.ts`, `src/tokenizer.ts`, `src/parser.ts`,
  `src/evaluator.ts`, `src/compiler.ts`, `src/merge-patch.ts`,
  `src/option-maps.ts`, `src/index.ts`

### Local modifications

- ESM `.js` import specifiers removed to match the repository bundler style
  (extensionless relative imports).
- `ModelOptionValues.reasoningLevel` is modeled as optional to reflect the
  fail-closed runtime check when a declared reasoning map has no effective value.
- Added a barrel that also re-exports the tokenizer/parser/evaluator internals.
- Ported tests live in `apps/agent/test/option-map/` (rewritten for `bun:test`),
  plus one extra case asserting illegal expressions are rejected at compile time
  with a safe error that leaks no filesystem paths or credentials.
- No runtime `eval`, `Function`, or dynamic code loading is used.

## Browser and permissions

At revision `872ad96`, the Playwright injected runtime loader and keyboard input mappings were adapted for the Electron browser. The permission design draws on `apps/zcode-cli/packages/core/src/tool/executor/permission-capability.ts`, `permission-input-recheck.ts`, and `permission-rules.ts` for host-owned capability facts and authorization after input changes. Pidex integrates these with its own tool registry, command parser, executor and approval store.

The Agent prompt also draws on ZCode communication and context-management guidance.
