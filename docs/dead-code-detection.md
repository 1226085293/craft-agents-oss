# Dead Code Detection

Craft Agent uses **knip** for static dead-code analysis, combined with a verification
harness that removes false positives before anything is deleted.

## Quick start

```bash
bun run knip              # full report (files, exports, types, duplicates, deps)
bun run knip:files        # only unused files
bun run deadcode:verify   # files + codegraph/grep evidence per candidate
```

### Windows: `KNIP_DISABLE_RAW_TRANSFER=1`

All `knip` scripts in `package.json` set `KNIP_DISABLE_RAW_TRANSFER=1`. Without it,
knip aborts partway through with:

```
RangeError: Array buffer allocation failed
  at createBuffer (.../oxc-parser/src-js/raw-transfer/common.js:294)
```

knip's AST layer (`dist/typescript/ast-nodes.js`) enables oxc-parser's experimental
`rawTransfer` when supported. On Windows the shared-memory buffer allocation fails
regardless of available RAM — the process dies at ~25 MB heap, so raising
`--max-old-space-size` does not help. Setting `KNIP_DISABLE_RAW_TRANSFER=1` makes knip
fall back to the normal parser path and it completes normally.

## What knip detects

| Issue type | Meaning |
|---|---|
| `Unused files` | Not reachable from any entry point |
| `Unused exports` | Exported but never imported |
| `Unused exported types` | Exported type never imported |
| `Duplicate exports` | Same symbol exported from two places |
| `Unused dependencies` | Declared in package.json but never imported |
| `Unlisted dependencies` | Imported but missing from package.json |
| `Unlisted binaries` | Binary invoked but not declared |

## Configuration

`knip.jsonc` at the repo root. Entries mirror what the real build actually reaches:
`package.json` `main`/`exports`, esbuild entry points, and vite HTML roots.

Two non-obvious decisions worth knowing:

### Renderer entries are declared as `.tsx`, not `.html`

knip's Vite plugin resolves `<script src>` entries only via `getIndexHtmlEntries()`,
which reads exactly `<cwd>/index.html`. The `electron-vite` plugin (which does walk
`rollupOptions.input`) requires a config file named `electron.vite.config.*`.

`apps/electron` uses a single `vite.config.ts` with `root: src/renderer` and **four**
HTML entries, so the vite plugin is disabled for that workspace and the four renderer
entries are declared directly:

```jsonc
"vite": false,
"entry": [
  "src/renderer/main.tsx",
  "src/renderer/playground.tsx",
  "src/renderer/browser-toolbar.tsx",
  "src/renderer/browser-empty-state.tsx"
]
```

Without this, ~57 playground files are falsely reported as unused.

### Test files are not "dead"

`*.isolated.ts` files are discovered by the root `package.json` test script via
`find . -name '*.isolated.ts'`, never by an import statement. Static analysis reports
them as unused; they are not. Same for `*.test.ts` run by `bun test`.

## Verification workflow

Never delete straight from a knip report. Run `bun run deadcode:verify`, which for each
candidate collects three independent evidence channels:

1. **codegraph callers** — semantic call-graph edges
2. **git grep** — literal symbol/basename references in tracked source and config
3. **indirect signals** — dynamic `import()`, `require(variable)`, glob-discovered test
   files, config/doc references

A candidate is only `DEAD` when all three channels are silent.

### Known false-positive traps

- **Name collisions across packages.** `HANDLED_CHANNELS` and
  `registerOnboardingHandlers` exist in both `apps/electron/src/main/onboarding.ts`
  and `packages/server-core/src/handlers/rpc/onboarding.ts`. A grep hit in one file
  says nothing about the other. Always confirm the importing path.
- **Cross-package relative imports.** `apps/electron/src/runtime/platform-headless.ts`
  is imported by `packages/server-core/src/bootstrap/headless-start.ts` via
  `../runtime/platform-headless`. knip reports the file as unused; it is live.
- **Path-only references.** Build tooling, eslint config, and code generators reference
  files by string path (`npx tsx .../generate-icons.ts`). No import exists.

## History

`scripts/dead-code-sweep.mjs` (v2) was removed on 2026-10-19. It only performed
file-level reachability and applied a filename-mention safety net that matched any
`.ts`/`.md`/`.json`/`.yml`/`.html` file — which reduced every sweep to zero candidates
while missing symbol-level, unreachable-but-imported, and duplicate code entirely.
