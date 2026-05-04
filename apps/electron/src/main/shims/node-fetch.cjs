/**
 * Shim: replaces the bundled `node-fetch@2` with Electron/Node 18+ native `fetch`.
 *
 * Why: grammY's `shim.node.js` imports `node-fetch` and `abort-controller`.
 * When esbuild bundles `abort-controller`'s `class AbortSignal`, it renames it
 * to `_AbortSignal` to avoid collision with the global, which breaks
 * `node-fetch@2`'s check `signal.constructor.name === 'AbortSignal'`.
 *
 * Native `fetch` (undici) accepts the global `AbortSignal` natively and is
 * faster, so we sidestep both polyfills. This file is wired in via esbuild's
 * `--alias:node-fetch=...` flag in package.json's build:main script.
 */
function fetchCompat(url, init) {
  if (!init) return globalThis.fetch(url)

  const next = { ...init }

  // grammY builds multipart uploads as Node Readable streams because it expects
  // node-fetch@2. Native fetch (undici, used by Electron/Node 18+) requires
  // `duplex: 'half'` for streaming request bodies. Without this, outbound
  // Telegram files fail as: "Network request for 'sendDocument' failed".
  if (next.body && typeof next.body === 'object' && typeof next.body.pipe === 'function') {
    next.duplex = 'half'
  }

  // These are node-fetch-specific options provided by grammY's Node platform
  // adapter. Native fetch does not use them, and passing the old `agent` can
  // interfere with undici's request handling.
  delete next.agent
  delete next.compress

  return globalThis.fetch(url, next)
}

module.exports = fetchCompat
module.exports.default = fetchCompat
module.exports.Headers = globalThis.Headers
module.exports.Request = globalThis.Request
module.exports.Response = globalThis.Response
