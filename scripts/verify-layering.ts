/**
 * Spec v2 §9 acceptance check: layered vs flat top-level serialized size.
 * Mirrors the real chain: session tools (prefixed) + MCP pool defs, using the
 * same serialize/estimate functions the runtime uses.
 */
import { SESSION_PREFIX } from '../packages/shared/src/tool-layering/assembler.ts';
import { loadToolLayering } from '../packages/shared/src/tool-layering/storage.ts';
import { assembleTools } from '../packages/shared/src/tool-layering/assembler.ts';
import { serializeToolForRequest } from '../packages/shared/src/tool-layering/estimator.ts';
import { getSessionToolProxyDefs } from '../packages/shared/src/agent/backend/pi/session-tool-defs.ts';

const WORKSPACE = 'C:/Users/12260/.craft-agent/workspaces/my-workspace';

function charsOf(defs: { name: string; description: string; inputSchema: unknown }[]): number {
  return defs.reduce((acc, d) => acc + serializeToolForRequest(d as never).length, 0);
}

(async () => {
  const sessionDefs = getSessionToolProxyDefs() as unknown as { name: string; description: string; inputSchema: unknown }[];
  console.log(`session tools: ${sessionDefs.length}`);

  const known = sessionDefs.map(d => d.name.replace(SESSION_PREFIX, ''));
  const resolved = loadToolLayering(WORKSPACE, known, false);
  const assembled = assembleTools(resolved, sessionDefs, []);

  const flatChars = charsOf(sessionDefs);
  const topChars = charsOf(assembled.topLevel);
  console.log(`mode: ${assembled.mode} (${assembled.decideReason})`);
  console.log(`topLevel count: ${assembled.topLevel.length} (flat would be ${sessionDefs.length})`);
  console.log(`registry: ${assembled.registry.size} tools`);

  const fmt = (chars: number) => `${chars.toLocaleString()} chars ≈ ${Math.round(chars / 3.636).toLocaleString()} tok`;
  console.log(`\nflat  top-level serialized: ${fmt(flatChars)}`);
  console.log(`layer top-level serialized: ${fmt(topChars)}`);
  console.log(`folded savings: ${fmt(flatChars - topChars)} (${((1 - topChars / flatChars) * 100).toFixed(1)}% cut)`);

  // Forced-layered counterfactual: same tools, same serializers.
  const forcedLayered = assembleTools({ ...resolved, mode: 'layered' }, sessionDefs, []);
  const lChars = charsOf(forcedLayered.topLevel);
  console.log(`\n[forced-layered counterfactual]`);
  console.log(`  top-level serialized: ${fmt(lChars)}`);
  console.log(`  top-level count: ${forcedLayered.topLevel.length} (meta+call_tool; registry keeps ${forcedLayered.registry.size} tools)`);
  console.log(`  vs flat: ${fmt(flatChars - lChars)} saved (${((1 - lChars / flatChars) * 100).toFixed(1)}%)`);
})();