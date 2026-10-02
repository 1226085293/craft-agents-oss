/**
 * Step 3 校准：token 估算器除数
 *
 * 规格书 §3: est = sum(len(serialize_for_request(t)) / 4) —— 除数需发一次真实请求校准。
 *
 * 方法（差分法）：同一 system + user 消息，分别发「带 tools」与「不带 tools」两个请求，
 * 真实工具 token = prompt_tokens(withTools) - prompt_tokens(withoutTools)，
 * 校准除数 = Σ len(serialize(t)) / 真实工具 token。
 *
 * 序列化格式与真实链路对齐：OpenAI chat/completions（PiAgent piAuthProvider=openai）。
 *
 * 用法：npx tsx scripts/calibrate-estimator.ts
 */
import { getToolDefsAsJsonSchema } from '@craft-agent/session-tools-core';
import { getSystemPrompt } from '../packages/shared/src/prompts/system.ts';
import { getSessionToolProxyDefs } from '../packages/shared/src/agent/backend/pi/session-tool-defs.ts';

const GATEWAY = process.env.CALIBRATE_URL || 'http://localhost:8000/v1/chat/completions';
const API_KEY = process.env.CALIBRATE_KEY || 'sk-omni-local-2026';
const MODEL = process.env.CALIBRATE_MODEL || 'auto';

/** 与真实链路一致的 OpenAI tools 序列化 */
function serializeOpenAITools(defs: { name: string; description: string; inputSchema: Record<string, unknown> }[]) {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.inputSchema },
  }));
}

function totalChars(tools: unknown[]): number {
  return tools.reduce((acc, t) => acc + JSON.stringify(t).length, 0);
}

async function chat(payload: unknown): Promise<{ promptTokens: number; error?: string }> {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as any;
  if (!res.ok) return { prompt: 0, error: `${res.status} ${JSON.stringify(json).slice(0, 300)}` };
  const usage = json?.usage ?? json?.message?.usage;
  return { prompt: usage?.prompt_tokens ?? usage?.input ?? 0 };
}

async function main() {
  // ── 1. foldable 工具集（session tools + pi 前缀；与真实会话一致）──
  const raw = getSessionToolProxyDefs();
  const plain = raw.map((d) => ({ name: d.name.replace(/^mcp__session__/, ''), description: d.description, inputSchema: d.inputSchema }));
  const pipeline = raw;
  console.log(`foldable session tools: ${plain.length}`);

  const sys = getSystemPrompt(undefined, { enabled: false }, '/tmp/ws');

  const toolsA = serializeOpenAITools(pipeline); // 完整（与真实发送一致，含前缀）
  const charTotal = JSON.stringify(toolsA).length;
  const charsPerTool = plain.map((d) => ({ name: d.name, chars: JSON.stringify(serializeTool(d)).length }));
  const sysLen = sys.length;

  // ── 2. 基准消息（system + 一条最小 user）──
  const baseMsg = [
    { role: 'system', content: sys },
    { role: 'user', content: 'hi' },
  ];

  console.log(`system chars: ${sysLen}, tools chars: ${charTotal}, est/@4: ${(charTotal / 4).toFixed(0)}`);
  console.log('--- per-tool chars ---');
  charsPerTool.sort((a, b) => b.chars - a.chars).slice(0, 12).forEach((t) =>
    console.log(`  ${String(t.chars).padStart(6)}  ${t.name}`));
  console.log('  ...');

  // ── 3. 差分请求 ──
  const payloadA = { model: MODEL, messages: baseMsg, tools: toolsA, max_tokens: 8, stream: false };
  const payloadB = { model: MODEL, messages: baseMsg, max_tokens: 8, stream: false };

  console.log('--- request A (with tools) ---');
  const a = await chat(payloadA);
  if (a.error) { console.error('A failed:', a.error); process.exit(1); }
  console.log('A prompt_tokens =', a.prompt);

  console.log('--- request B (without tools) ---');
  const b = await chat(payloadB);
  if (b.error) { console.error('B failed:', b.error); process.exit(1); }
  console.log('B prompt_tokens =', b.prompt);

  const toolTokens = a.prompt - b.prompt;
  if (toolTokens <= 0) { console.error('差分无效: A-B <= 0'); process.exit(1); }

  // ── 4. 校准除数 ──
  const divisor = charTotal / toolTokens;
  console.log('--- calibration ---');
  console.log(`real tool tokens = ${toolTokens}`);
  console.log(`divisor = ${charTotal} / ${toolTokens} = ${divisor.toFixed(3)}`);
  console.log(`est@4 = ${(charTotal / 4).toFixed(0)} vs real ${toolTokens} ⇒ err ${((charTotal / 4 - toolTokens) / toolTokens * 100).toFixed(1)}%`);
  console.log(`>> calibrated divisor: ${divisor.toFixed(3)}`);
}

// 简单 helper 定义（避免与上面重复）
function serializeTool(d: { name: string; description: string; inputSchema: Record<string, unknown> }) {
  return { type: 'function', function: { name: d.name, description: d.description, parameters: d.inputSchema } };
}

main().catch((e) => { console.error(e); process.exit(1); });