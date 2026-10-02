/**
 * 生成并校验 workspace config/tool_layering.json + config/tool_categories.json
 * （Step 4 数据文件落位；校验 34 工具全覆盖、无重复、分类数 4-6）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getSessionToolProxyDefs } from '../packages/shared/src/agent/backend/pi/session-tool-defs.ts';
import { DEFAULT_TOOL_LAYERING, DEFAULT_TOOL_CATEGORIES } from '../packages/shared/src/tool-layering/defaults.ts';
import { validateToolLayering } from '../packages/shared/src/tool-layering/validation.ts';

const WS = process.env.WORKSPACE_ROOT || 'C:/Users/12260/.craft-agent/workspaces/my-workspace';
const realTools = getSessionToolProxyDefs().map((d) => d.name.replace('mcp__session__', ''));

console.log('real session tools:', realTools.length);

// ── 校验 defaults 覆盖 ──
const cfg = DEFAULT_TOOL_CATEGORIES;
const v = validateToolLayering(cfg, DEFAULT_TOOL_LAYERING.fixedLayer, realTools, false /*allowMisc=false → 孤儿即错*/);
console.log('validation ok:', v.ok);
v.errors.forEach((e) => console.log('  ERR:', e));
v.warnings.forEach((e) => console.log('  WARN:', e));

const bucketed = new Set<string>();
for (const c of cfg.categories) for (const t of c.tools) bucketed.add(t);
const missing = realTools.filter((t) => !bucketed.has(t));
const extra = [...bucketed].filter((t) => !realTools.includes(t));
if (missing.length) console.log('MISSING(孤儿):', missing);
if (extra.length) console.log('EXTRA(分类里不存在于运行时):', extra);

if (!v.ok || missing.length || extra.length) {
  console.error('DEFAULTS 不完整，先修 defaults 再落磁盘');
  process.exit(1);
}

// ── 2. 落盘到 workspace config/ ──
const dir = join(WS, 'config');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'tool_layering.json'), JSON.stringify(DEFAULT_TOOL_LAYERING, null, 2) + '\n', 'utf-8');
writeFileSync(join(dir, 'tool_categories.json'), JSON.stringify(DEFAULT_TOOL_CATEGORIES, null, 2) + '\n', 'utf-8');
console.log('written:');
console.log('  ' + join(WS, 'config/tool_layering.json'));
console.log('  ' + join(WS, 'config/tool_categories.json'));