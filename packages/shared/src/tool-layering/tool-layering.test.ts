/**
 * Tool Layering tests: defaults coverage, validation, estimator, storage.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_TOOL_LAYERING,
  DEFAULT_TOOL_CATEGORIES,
  ESTIMATOR_DIVISOR,
  MISC_CATEGORY_NAME,
  decideToolMode,
  estimateFoldableTokens,
  loadToolLayering,
  validateToolLayering,
  ensureMiscBucket,
  serializeToolForRequest,
} from './index.ts';
import {
  assembleTools,
  buildExpandPayload,
  nearestToolNames,
  SESSION_PREFIX,
} from './assembler.ts';

const ALL_TOOLS = (() => {
  const set = new Set<string>();
  for (const c of DEFAULT_TOOL_CATEGORIES.categories) for (const t of c.tools) set.add(t);
  return [...set];
})();

describe('defaults coverage', () => {
  it('defaults cover all 34 session tools exactly once', () => {
    const v = validateToolLayering(DEFAULT_TOOL_CATEGORIES, [], ALL_TOOLS, false);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(DEFAULT_TOOL_CATEGORIES.categories.length).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_TOOL_CATEGORIES.categories.length).toBeLessThanOrEqual(6);
  });

  it('each default category description is short enough', () => {
    for (const c of DEFAULT_TOOL_CATEGORIES.categories) {
      const zh = (c.description.match(/[\u4e00-\u9fff]/g) || []).length;
      const tok = zh / 1.7 + (c.description.length - zh) / 4;
      expect(tok, `${c.name} desc ${c.description}`).toBeLessThanOrEqual(80);
    }
  });
});

describe('validation', () => {
  it('rejects duplicate tool across categories', () => {
    const cats = {
      categories: [
        { name: 'a', metaToolName: 'tools_a', description: 'd', tools: ['t1', 't2'] },
        { name: 'b', metaToolName: 'tools_b', description: 'd', tools: ['t2', 't3'] },
      ],
    };
    const v = validateToolLayering(cats, [], ['t1', 't2', 't3'], false);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('t2');
  });

  it('rejects duplicate category names', () => {
    const cats = {
      categories: [
        { name: 'a', metaToolName: 'x', description: 'd', tools: ['t1'] },
        { name: 'a', metaToolName: 'y', description: 'd', tools: ['t2'] },
      ],
    };
    const v = validateToolLayering(cats, [], ['t1', 't2'], false);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('重复');
  });

  it('orphan tool errors when allowMisc=false, warns+misc when true', () => {
    const cats = DEFAULT_TOOL_CATEGORIES;
    const withOrphan = [...ALL_TOOLS, 'future_tool'];
    const strict = validateToolLayering(cats, [], withOrphan, false);
    expect(strict.ok).toBe(false);
    expect(strict.errors.join()).toContain('future_tool');

    const loose = validateToolLayering(cats, [], withOrphan, true);
    expect(loose.ok).toBe(true);
    expect(loose.warnings.join()).toContain('future_tool');
  });

  it('misc bucket is lazily created', () => {
    const cats = JSON.parse(JSON.stringify(DEFAULT_TOOL_CATEGORIES.categories));
    const before = cats.length;
    const out = ensureMiscBucket(cats, 'future_tool');
    expect(out.length).toBe(before + 1);
    expect(out.find((c: any) => c.name === MISC_CATEGORY_NAME)!.tools).toContain('future_tool');
  });
});

describe('estimator', () => {
  const fakeTools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];
  for (let i = 0; i < 2; i++) {
    fakeTools.push({
      name: `t${i}`,
      description: 'tool '.repeat(60), // 300 chars
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    });
  }

  it('estimates with calibrated divisor', () => {
    const chars = fakeTools.reduce((n, t) => n + serializeToolForRequest(t).length, 0);
    const est = estimateFoldableTokens(fakeTools);
    expect(est).toBeCloseTo(chars / ESTIMATOR_DIVISOR, 5);
  });

  it('decideToolMode: forced wins', () => {
    const r = decideToolMode('flat', fakeTools, 1000);
    expect(r.mode).toBe('flat');
    expect(r.forced).toBe(true);
  });

  it('decideToolMode: auto threshold (est >= 8000 → layered)', () => {
    const big = [...fakeTools, ...fakeTools, ...fakeTools, ...fakeTools, ...fakeTools]; // 10x chars
    const est = estimateFoldableTokens(big);
    const r = decideToolMode(undefined, big, 8000);
    expect(r.mode).toBe(est >= 8000 ? 'layered' : 'flat');
  });

  it('decideToolMode: low est stays flat', () => {
    const r = decideToolMode(undefined, fakeTools, 8000);
    expect(r.mode).toBe('flat');
  });
});

describe('storage', () => {
  it('loads config dir, defaults on missing, throws on invalid', () => {
    const ws = mkdtempSync(join(tmpdir(), 'tl-'));
    try {
      const resolved = loadToolLayering(ws, ALL_TOOLS, true);
      expect(resolved.mode).toBe('auto');
      expect(resolved.enterThresholdTokens).toBe(8000);
      expect(resolved.byTool.size).toBe(ALL_TOOLS.length);

      // invalid: duplicate tools in one category file
      mkdirSync(join(ws, 'config'));
      writeFileSync(
        join(ws, 'config/tool_categories.json'),
        JSON.stringify({
          categories: DEFAULT_TOOL_CATEGORIES.categories.map((c, i) =>
            i === 0 ? { ...c, tools: ['get_session_info', 'get_session_info'] } : c,
          ),
        }),
      );
      expect(() => loadToolLayering(ws, ALL_TOOLS, true)).toThrow(/重复/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
describe('assembler', () => {
  const mkDef = (name: string, description = 'd', inputSchema: Record<string, unknown> = {}) => ({
    name, description, inputSchema,
  });
  const session = [...ALL_TOOLS].map((n) => mkDef(SESSION_PREFIX + n, `desc ${n}`, { type: 'object' }));
  const mcp = [mkDef('mcp__github__search_code', 'desc mcp', { type: 'object' })];

  it('flat mode keeps everything top-level', () => {
    const layering = {
      mode: 'flat' as const, fixedLayer: [], categories: DEFAULT_TOOL_CATEGORIES.categories,
      enterThresholdTokens: 8000, byTool: new Map(),
    };
    const a = assembleTools(layering, session, mcp);
    expect(a.mode).toBe('flat');
    expect(a.topLevel.length).toBe(ALL_TOOLS.length + 1);
    expect(a.registry.size).toBe(ALL_TOOLS.length + 1);
  });

  it('layered mode folds foldable tools behind meta + call_tool', () => {
    const layering = {
      mode: 'layered' as const,
      fixedLayer: ['get_session_info'],
      categories: DEFAULT_TOOL_CATEGORIES.categories,
      enterThresholdTokens: 8000,
      byTool: new Map(DEFAULT_TOOL_CATEGORIES.categories.flatMap((c) => c.tools.map((t) => [t, c] as const))),
    };
    const a = assembleTools(layering, session, mcp);
    expect(a.mode).toBe('layered');
    // fixed(1) + meta(N) + call_tool(1)
    const metas = a.metaTools.length;
    expect(metas).toBe(DEFAULT_TOOL_CATEGORIES.categories.length);
    expect(a.topLevel.length).toBe(1 + metas + 1);
    expect(a.topLevel[0]!.name).toBe(SESSION_PREFIX + 'get_session_info');
    expect(a.topLevel.some((t) => t.name === SESSION_PREFIX + 'call_tool')).toBe(true);
    // registry unchanged — every tool reachable
    expect(a.registry.size).toBe(ALL_TOOLS.length + 1);
    const entry = a.registry.get(SESSION_PREFIX + 'get_page')!;
    expect(entry.category).toBe('pages');
    expect(entry.fixed).toBe(false);
  });

  it('expand payload lists category tools with usage', () => {
    const cat = DEFAULT_TOOL_CATEGORIES.categories.find((c) => c.name === 'pages')!;
    const registry = new Map(
      cat.tools.map((n) => [SESSION_PREFIX + n, {
        fullName: SESSION_PREFIX + n, callName: n,
        def: mkDef(SESSION_PREFIX + n, 'd'), category: 'pages', fixed: false,
      }]),
    );
    const p = buildExpandPayload(cat, registry);
    expect(p.category).toBe('pages');
    expect(p.tools.map((t) => t.name)).toEqual(cat.tools);
    expect(p.usage).toContain('call_tool');
  });

  it('nearestToolNames returns suggestions', () => {
    const registry = new Map(
      ALL_TOOLS.map((n) => [SESSION_PREFIX + n, {
        fullName: SESSION_PREFIX + n, callName: n,
        def: mkDef(n), category: 'x', fixed: false,
      }]),
    );
    const near = nearestToolNames(registry, 'get_pages');
    expect(near).toContain('get_page');
    expect(near.length).toBeLessThanOrEqual(3);
  });
});

describe('invariants (spec §5/§6)', () => {
  const mkDef = (name: string, description = 'd', inputSchema: Record<string, unknown> = {}) => ({
    name, description, inputSchema,
  });
  const session = ALL_TOOLS.map((n) => mkDef(SESSION_PREFIX + n, `desc ${n}`, { type: 'object' }));
  const mcp = [mkDef('mcp__github__search_code', 'desc mcp', { type: 'object' })];

  const layeredResolved = {
    mode: 'layered' as const,
    fixedLayer: [],
    categories: DEFAULT_TOOL_CATEGORIES.categories,
    enterThresholdTokens: 8000,
    byTool: new Map(DEFAULT_TOOL_CATEGORIES.categories.flatMap((c) => c.tools.map((t) => [t, c] as const))),
  };

  it('folded tools never appear top-level in layered mode', () => {
    const a = assembleTools(layeredResolved, session, mcp);
    const topNames = new Set(a.topLevel.map((t) => t.name));
    for (const t of ALL_TOOLS) {
      expect(topNames.has(SESSION_PREFIX + t)).toBe(false);
    }
    // every tool still reachable via registry
    expect(a.registry.size).toBe(ALL_TOOLS.length + 1);
  });

  it('subset superset: flat-mode topLevel covers all foldable + meta/call', () => {
    const flat = assembleTools({ mode: 'flat', fixedLayer: [], categories: [], enterThresholdTokens: 8000, byTool: new Map() }, session, []);
    expect(flat.topLevel.length).toBe(ALL_TOOLS.length);
  });
});
