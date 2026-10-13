/**
 * Build-asset validation — runs at the END of `build`/`build:win` so a
 * missing critical output fails the build early instead of shipping a
 * packaged app with broken internals.
 *
 * Checks (all under dist/):
 *  - main.cjs (electron main bundle)
 *  - bootstrap-preload.cjs (preload)
 *  - browser-toolbar-preload.cjs (browser toolbar preload)
 *  - interceptor.cjs (unified network interceptor)
 *  - renderer/index.html (vite output)
 *  - resources/pi-agent-server/index.js (Pi agent subprocess)
 *  - resources/models/bge-small-zh-v1.5/onnx/model_quantized.onnx (embedding)
 *  - resources/config-defaults.json + resources/docs/ (bundled assets)
 *
 * Exits non-zero with a message naming the first missing file.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = [
  'main.cjs',
  'bootstrap-preload.cjs',
  'browser-toolbar-preload.cjs',
  'interceptor.cjs',
  'renderer/index.html',
  'resources/pi-agent-server/index.js',
  'resources/models/bge-small-zh-v1.5/onnx/model_quantized.onnx',
  'resources/config-defaults.json',
  'resources/docs',
];

let fail = false;
for (const rel of REQUIRED) {
  const p = join('dist', rel);
  if (!existsSync(p)) {
    console.error(`✗ MISSING build asset: ${p}`);
    fail = true;
  } else {
    console.log(`✓ ${rel} (${(statSync(p).size / 1024).toFixed(0)} KB)`);
  }
}

// Bundled docs must be non-empty (empty docs dir = copy-assets skipped silently).
const docsDir = join('dist', 'resources', 'docs');
if (existsSync(docsDir)) {
  const { readdirSync } = require('node:fs');
  if (readdirSync(docsDir).length === 0) {
    console.error('✗ resources/docs is EMPTY — bundled docs missing');
    fail = true;
  }
}

// Embedding runtime guard: @huggingface/transformers must be EXTERNAL in
// main.cjs. If esbuild inlines it (missing --external flag), the onnxruntime
// native-binding loader is dead-code-eliminated and the embedding engine
// silently fails in the Electron MAIN process (encodeEmbedding callback
// never runs → no semantic retrieval → memories never injected). Detect
// both directions: the dynamic import must be present, and the inlined
// onnxruntime binding loader must be absent.
const mainCjs = join('dist', 'main.cjs');
if (existsSync(mainCjs)) {
  const main = readFileSync(mainCjs, 'utf8');
  const hasExternalTransformers = main.includes('import("@huggingface/transformers")');
  const hasInlinedBinding = main.includes('onnxruntime_binding');
  if (!hasExternalTransformers) {
    console.error('✗ main.cjs is MISSING `import("@huggingface/transformers")` — transformers was inlined (add --external:@huggingface/transformers to the esbuild args in build:main / build:main:win / build-win.ps1)');
    fail = true;
  } else if (hasInlinedBinding) {
    console.error('✗ main.cjs contains inlined `onnxruntime_binding` — onnxruntime native loader was bundled (transformers must be external)');
    fail = true;
  } else {
    console.log('✓ main.cjs external @huggingface/transformers (embedding runtime OK)');
  }
}

if (fail) {
  console.error('\nBuild-asset validation FAILED. Fix the missing outputs above, then re-run build.');
  process.exit(1);
}
console.log('\n✓ Build assets OK');
