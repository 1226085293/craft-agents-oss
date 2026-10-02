import { describe, it, expect } from 'bun:test';
import type { LoadedSkill } from '../types.ts';
import { renderSkillsBlock, DEFAULT_SKILLS_BUDGET_TOKENS } from '../skills-prompt.ts';

function skill(slug: string, source: LoadedSkill['source'], description: string): LoadedSkill {
  return {
    slug,
    metadata: { name: slug, description },
    content: '',
    path: '/tmp/' + slug,
    source,
  };
}

const D = 'Do X and Y expertly, handle edge cases, and produce great output.';

describe('renderSkillsBlock', () => {
  it('orders by source priority project > workspace > global', () => {
    const skills = [
      skill('a-global', 'global', D),
      skill('b-project', 'project', D),
      skill('c-workspace', 'workspace', D),
    ];
    const out = renderSkillsBlock(skills);
    const idxProject = out.indexOf('b-project');
    const idxWorkspace = out.indexOf('c-workspace');
    const idxGlobal = out.indexOf('a-global');
    expect(idxProject).toBeGreaterThan(-1);
    expect(idxWorkspace).toBeGreaterThan(idxProject);
    expect(idxGlobal).toBeGreaterThan(idxWorkspace);
  });

  it('formats lines as - slug: description inside skills tags', () => {
    const out = renderSkillsBlock([skill('alpha', 'global', 'Does alpha things well.')]);
    expect(out).toContain('<skills>');
    expect(out).toContain('</skills>');
    expect(out).toContain('- alpha: Does alpha things well.');
  });

  it('returns empty string for zero skills', () => {
    expect(renderSkillsBlock([])).toBe('');
  });

  it('keeps full descriptions when within budget', () => {
    const long = 'x'.repeat(300);
    const out = renderSkillsBlock([skill('big', 'global', long)]);
    expect(out).toContain(long);
  });

  it('truncates long descriptions when over budget instead of dropping', () => {
    const longDesc1 = 'x'.repeat(5000);
    const longDesc2 = 'y'.repeat(5000);
    const out = renderSkillsBlock(
      [skill('one', 'global', longDesc1), skill('two', 'global', longDesc2)],
      500,
    );
    expect(out).toContain('- one:');
    expect(out).toContain('- two:');
    expect(out).not.toContain(longDesc1);
    expect(out).toContain('\u2026');
  });

  it('drops lowest-priority skills when budget is tiny, keeping at least one', () => {
    const skills = [];
    for (let i = 0; i < 100; i++) {
      skills.push(skill('s' + String(i).padStart(3, '0'), 'global', 'g'.repeat(300)));
    }
    skills.push(skill('top-priority', 'project', 'p'.repeat(300)));
    const out = renderSkillsBlock(skills, 150);
    expect(out).toContain('- top-priority:');
    const lineCount = out.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(lineCount).toBeLessThan(10);
    expect(lineCount).toBeGreaterThanOrEqual(1);
  });

  it('collapses newlines in descriptions to keep one line per skill', () => {
    const multi = skill('multi', 'global', 'line one\nline two\nline three');
    const out = renderSkillsBlock([multi]);
    expect(out).toContain('- multi: line one line two line three');
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(1);
  });

  it('default budget constant is 4000', () => {
    expect(DEFAULT_SKILLS_BUDGET_TOKENS).toBe(4000);
  });
});
