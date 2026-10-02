import { getSystemPrompt } from '../packages/shared/src/prompts/system.ts';
import { formatDebugModeContext } from '../packages/shared/src/prompts/system.ts';

const full = getSystemPrompt(undefined, { enabled: false }, '/tmp/ws');

function zhCount(s: string) {
  return (s.match(/[\u4e00-\u9fff]/g) || []).length;
}
function estTok(s: string) {
  return Math.round(zhCount(s) / 1.7 + (s.length - zhCount(s)) / 4);
}

const titles = [
  '## Browser Tools', '## External Sources', '## Skills', '## Project Context',
  '## Configuration Documentation', '## Craft Agent CLI', '## User preferences',
  '## Interaction Guidelines', '## Git Conventions', '## Permission Modes',
  '## Web Search', '## Code Diffs and Visualization', '## Structured Data (Tables & Spreadsheets)',
  '## LLM Tool', '## Browser Tools', '## Document Tools', '## Tool Metadata',
  '## Pages', '## Diagrams and Visualization', '## HTML Preview', '## PDF Preview',
  '## Image Preview', '## Markdown Preview', '## Multiple Items (Tabs)',
  '## Source Templates', '## File-Backed Tables'
];
const positions: [string, number][] = titles.map(t => [t, full.indexOf(t)]).filter(([, i]) => i >= 0) as any;
positions.sort((a, b) => a[1] - b[1]);

console.log('=== 静态系统提示词章节分解 (总 ' + full.length + ' chars) ===');
positions.forEach(([t, i], idx) => {
  const end = idx + 1 < positions.length ? positions[idx + 1][1] : full.length;
  const seg = full.slice(i, end);
  console.log(String(seg.length).padStart(6) + ' chars  ~' + String(estTok(seg)).padStart(5) + ' tok   ' + t);
});

const headEnd = positions.length ? positions[0][1] : full.length;
const head = full.slice(0, headEnd);
console.log(String(head.length).padStart(6) + ' chars  ~' + String(estTok(head)).padStart(5) + ' tok   (头部 marker + 核心介绍)');