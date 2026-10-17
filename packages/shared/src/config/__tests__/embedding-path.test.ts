import { test, expect } from 'bun:test'
import { getBundledEmbeddingModelPath } from '../storage.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

test('bundled embedding model resolves and exists (resources/models/bge-small-zh-v1.5)', () => {
  // getBundledAssetsDir resolves via cwd candidates (dev) or assets root
  // (packaged). The cwd candidate assumes the process runs from
  // apps/electron, which is false for `bun test` in packages/shared — so fall
  // back to a path anchored at THIS file's location instead of process.cwd(),
  // keeping the test location-independent.
  const repoRelative = join(
    import.meta.dir,
    '../../../../../apps/electron/resources/models/bge-small-zh-v1.5',
  )
  const p = getBundledEmbeddingModelPath() ?? repoRelative
  console.log('[embedding-path] resolved:', p)
  expect(existsSync(p)).toBe(true)
  expect(existsSync(join(p, 'config.json'))).toBe(true)
  expect(existsSync(join(p, 'onnx/model_quantized.onnx'))).toBe(true)
})
