import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { patchValidationEcho, VALIDATION_ECHO_MARKER } from './patch-pi-coding-agent-validation-echo.ts';

/**
 * The unpatched template, byte-for-byte as it appears in the bundled chunk. The newlines are
 * REAL newlines inside the SDK's template literal (minification preserves them because they
 * are part of the message text).
 */
const UNPATCHED =
  'errorMessage2=`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments,null,2)}`;' +
  'throw new Error(errorMessage2)';

describe('patchValidationEcho', () => {
  it('removes only the echoed arguments, keeping the errors list', () => {
    const result = patchValidationEcho(UNPATCHED);
    expect(result.changed).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.source).not.toContain(VALIDATION_ECHO_MARKER);
    expect(result.source).not.toContain('JSON.stringify(toolCall.arguments');
    // The message still names the tool and still carries the validator output.
    expect(result.source).toContain('Validation failed for tool "${toolCall.name}"');
    expect(result.source).toContain('${errors}');
    // Nothing else in the call site changes: the throw is intact.
    expect(result.source).toContain('throw new Error(errorMessage2)');
  });

  it('is idempotent — a patched source reports no change', () => {
    const once = patchValidationEcho(UNPATCHED);
    const twice = patchValidationEcho(once.source);
    expect(twice.changed).toBe(false);
    expect(twice.warning).toBeUndefined();
    expect(twice.source).toBe(once.source);
  });

  it('leaves unrelated sources untouched', () => {
    const unrelated = 'const message = `Validation failed for tool "${tool.name}"`;';
    const result = patchValidationEcho(unrelated);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(unrelated);
  });

  it('warns instead of guessing when upstream rewrote the template', () => {
    const drifted =
      'errorMessage=`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${format(toolCall.arguments)}`;';
    const result = patchValidationEcho(drifted);
    expect(result.changed).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('changed upstream');
    expect(result.source).toBe(drifted);
  });

  it('the installed SDK no longer carries the echo (patch ran or is still needed)', () => {
    /**
     * Guards the wiring, not the algorithm: if `bun install` ran and the postinstall step
     * dropped out of the chain, the marker would be back in the installed bundle and every
     * failed tool call would start echoing arguments again.
     */
    const sdkRoot = new URL('../node_modules/@earendil-works/pi-coding-agent/dist/', import.meta.url);
    let markerSomewhere = false;
    const walk = (dir: URL) => {
      const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
      for (const entry of readdirSync(dir)) {
        const full = new URL(entry, dir);
        if (statSync(full).isDirectory()) {
          walk(new URL(`${entry}/`, dir));
        } else if (entry.endsWith('.js')) {
          if (readFileSync(full, 'utf8').includes(VALIDATION_ECHO_MARKER)) markerSomewhere = true;
        }
      }
    };
    try {
      walk(sdkRoot);
    } catch {
      return; // SDK not installed in this checkout — nothing to assert.
    }
    expect(markerSomewhere).toBe(false);
  });
});
