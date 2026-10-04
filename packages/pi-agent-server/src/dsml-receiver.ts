import { randomUUID } from "node:crypto";
import { parseLeakedToolCalls } from "./defense/leaked-toolcall.ts";

type FetchFunction = typeof globalThis.fetch;
type UsableCall = { name: string; args: Record<string, unknown> };

export interface DsmlReceiverDeps {
  isLlmRequest: (url: string) => boolean;
  debugLog: (message: string) => void;
}

const DSML_MARKER = String.fromCharCode(0xff5c);
const MAX_CAPTURED_CONTENT_CHARS = 32 * 1024;
const syntheticCallNamespace = randomUUID().replaceAll("-", "");
let nextSyntheticCallId = 0;

interface SseState {
  prefix: string;
  content: string;
  hasStructuredCalls: boolean;
  terminalLines: string[];
  terminalChunk: Record<string, unknown> | null;
}

/** Install a process-local fetch wrapper. Call the returned function on re-init/shutdown. */
export function installDsmlReceiver(deps: DsmlReceiverDeps): () => void {
  const original = globalThis.fetch;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!deps.isLlmRequest(url) || !response.ok || !response.body) return response;
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      return new Response(transformDsmlSse(response.body, deps.debugLog), {
        status: response.status,
        statusText: response.statusText,
        headers: transformedHeaders(response.headers),
      });
    }
    return response;
  }) as FetchFunction;

  globalThis.fetch = wrapped;
  deps.debugLog("[dsml-receiver] installed");
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
    deps.debugLog("[dsml-receiver] restored original fetch");
  };
}

function transformedHeaders(headers: Headers): Headers {
  const result = new Headers(headers);
  result.delete("content-length");
  result.delete("content-encoding");
  result.delete("transfer-encoding");
  return result;
}

/** Pass SSE through line-by-line. Hold the terminal chunk and [DONE] until the
 * whole response is inspected, then inject native tool-call deltas if needed. */
export function transformDsmlSse(body: ReadableStream<Uint8Array>, log: (message: string) => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const state: SseState = { prefix: "", content: "", hasStructuredCalls: false, terminalLines: [], terminalChunk: null };
  let pending = "";
  let newline = "\n";
  let holdingTail = false;
  let finished = false;

  const processLine = (line: string, newline: string): string => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      if (holdingTail) {
        state.terminalLines.push(line + newline);
        return "";
      }
      return line + newline;
    }
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      holdingTail = true;
      state.terminalLines.push(line + newline);
      return "";
    }
    let chunk: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(payload);
      if (value && typeof value === "object") chunk = value as Record<string, unknown>;
    } catch {
      return holdingTail ? (state.terminalLines.push(line + newline), "") : line + newline;
    }
    const choices = chunk?.choices;
    const choice = Array.isArray(choices) ? choices[0] as Record<string, unknown> | undefined : undefined;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) state.hasStructuredCalls = true;
    if (typeof delta?.content === "string") {
      if (state.content.includes(DSML_MARKER)) {
        state.content += delta.content;
      } else {
        const candidate = state.prefix + delta.content;
        if (candidate.includes(DSML_MARKER)) state.content = candidate;
        else state.prefix = candidate.slice(-16);
      }
      if (state.content.length > MAX_CAPTURED_CONTENT_CHARS) {
        state.content = state.content.slice(-MAX_CAPTURED_CONTENT_CHARS);
      }
    }
    if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) {
      holdingTail = true;
      state.terminalChunk = chunk;
      state.terminalLines.push(line + newline);
      return "";
    }
    if (holdingTail) {
      state.terminalLines.push(line + newline);
      return "";
    }
    return line + newline;
  };

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (finished) return;
    finished = true;
    if (pending) {
      const line = pending;
      pending = "";
      const emitted = processLine(line, "");
      if (emitted) {
        const calls = state.hasStructuredCalls ? [] : usableCalls(state.content);
        if (calls.length > 0) state.terminalLines.unshift(emitted + newline);
        else controller.enqueue(encoder.encode(emitted));
      }
    }
    const finishReason = (state.terminalChunk?.choices as Array<{ finish_reason?: unknown }> | undefined)?.[0]?.finish_reason;
    const mayConvert = finishReason === undefined || finishReason === null || finishReason === "stop";
    const calls = state.hasStructuredCalls || !mayConvert ? [] : usableCalls(state.content);
    if (calls.length > 0) {
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        const event = {
          id: "dsml-synth",
          object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: { tool_calls: [{
              index: i,
              id: `call_dsml_${syntheticCallNamespace}_${++nextSyntheticCallId}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            }] },
            finish_reason: null,
          }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}${newline}${newline}`));
      }
      if (state.terminalChunk) {
        const choices = state.terminalChunk.choices as Array<Record<string, unknown>>;
        if (Array.isArray(choices) && choices[0]) choices[0].finish_reason = "tool_calls";
        const rewritten = `data: ${JSON.stringify(state.terminalChunk)}${newline}`;
        state.terminalLines = state.terminalLines.map((line) => {
          if (!line.trim().startsWith("data:")) return line;
          const payload = line.trim().slice(5).trim();
          try {
            const value = JSON.parse(payload) as { choices?: Array<{ finish_reason?: unknown }> };
            if (value.choices?.[0]?.finish_reason !== null && value.choices?.[0]?.finish_reason !== undefined) return rewritten;
          } catch { /* keep non-JSON SSE lines */ }
          return line;
        });
      } else {
        const terminal = {
          id: "dsml-synth",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(terminal)}${newline}${newline}`));
      }
      log(`[dsml-receiver] injected ${calls.length} tool_call(s): ${calls.map((call) => call.name).join(", ")}`);
    }
    for (const line of state.terminalLines) controller.enqueue(encoder.encode(line));
    controller.close();
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = pending.indexOf("\n")) >= 0) {
            const hasCarriageReturn = pending[index - 1] === "\r";
            const lineEnd = hasCarriageReturn ? "\r\n" : "\n";
            const line = pending.slice(0, hasCarriageReturn ? index - 1 : index);
            pending = pending.slice(index + 1);
            newline = lineEnd;
            const emitted = processLine(line, lineEnd);
            if (emitted) controller.enqueue(encoder.encode(emitted));
          }
        }
        pending += decoder.decode();
        finish(controller);
      } catch (error) {
        log(`[dsml-receiver] SSE stream failed: ${error instanceof Error ? error.message : String(error)}`);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function usableCalls(text: string): UsableCall[] {
  if (!text.includes(DSML_MARKER)) return [];
  const parsed = parseLeakedToolCalls(text);
  if (!parsed.leaked) return [];
  return parsed.calls.flatMap((call) => call.name && call.args !== null
    ? [{ name: call.name, args: call.args }]
    : []);
}

