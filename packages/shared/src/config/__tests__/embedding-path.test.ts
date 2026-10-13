import { test, expect } from 'bun:test'
import { getBundledEmbeddingModelPath } from '../storage.ts'
import { existsSync } from 'node:fs'

test('bundled embedding model resolves and exists (resources/models/bge-small-zh-v1.5)', () => {
  // getBundledAssetsDir resolves via cwd candidates (dev) or assets root
  // (packaged). When neither is available (test runner cwd elsewhere), fall
  // back to the repo-relative bundled path so the test stays location-independent.
  const p = getBundledEmbeddingModelPath()
    ?? require('node:path').join(process.cwd(), 'apps/electron/resources/models/bge-small-zh-v1.5')
  console.log('[embedding-path] resolved:', p)
  expect(existsSync(p)).toBe(true)
  expect(existsSync(require('node:path').join(p, 'config.json'))).toBe(true)
  expect(existsSync(require('node:path').join(p, 'onnx/model_quantized.onnx'))).toBe(true)
})
