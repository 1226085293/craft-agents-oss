import { describe, expect, it } from "bun:test";
import { transformDsmlSse } from "./dsml-receiver.ts";
import type { DsmlReceiverDeps } from "./dsml-receiver.ts";

const KNOWN = ["read", "bash", "web_fetch", "edit", "write"];

const bareBash =
  "<tool_calls>\n" +
  "<invoke name=\"bash\">\n" +
  "<parameter name=\"appDisplayName\" string=\"true\">Check Waiting In Watchdog</parameter>\n" +
  "<parameter name=\"appIntent\" string=\"true\">看门狗是否处理 waiting 任务</parameter>\n" +
  "<parameter name=\"command\" string=\"true\">cd /e/craft-agents-oss && grep -n \"waiting\" packages/server-core/src/tasks/task-watchdog.ts</parameter>\n" +
  "<parameter name=\"timeout\" string=\"false\">150</parameter>\n" +
  "</invoke>\n" +
  "</tool_calls>";

const M = "\uFF5CDSML\uFF5C";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function depsWith(known?: readonly string[]): DsmlReceiverDeps {
  return {
    isLlmRequest: () => true,
    debugLog: () => {},
    ...(known ? { knownToolNames: () => known } : {}),
  };
}

function sse(leak: string, extra = ""): string {
  return (
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: leak }, finish_reason: null }] })}\n\n` +
    extra +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

async function callsOf(output: string): Promise<Array<{ id: string; name: string; args: Record<string, unknown> }>> {
  const dataLines = output.split("\n").filter((line) => line.startsWith("data: "));
  const events = dataLines
    .map((line) => line.slice(6))
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line));
  const callEvents = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
  return callEvents.map((call: { id: string; function: { name: string; arguments: string } }) => ({
    id: call.id,
    name: call.function.name,
    args: JSON.parse(call.function.arguments),
  }));
}

describe("DSML receiver — bare (marker-less) leak form (2026-11-10)", () => {
  it("converts a bare envelope at the end of the reply into a native tool_call", async () => {
    const output = await readStream(transformDsmlSse(streamOf(sse("Some prose.\n" + bareBash)), () => {}, depsWith(KNOWN)));
    const calls = await callsOf(output);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("bash");
    expect(calls[0]!.args.command).toContain("task-watchdog.ts");
    expect(calls[0]!.args.timeout).toBe(150);
    expect(calls[0]!.args.appDisplayName).toBe("Check Waiting In Watchdog");
    expect(output).toContain('"finish_reason":"tool_calls"');
    expect(output.indexOf('"tool_calls"')).toBeLessThan(output.indexOf("[DONE]"));
  });

  it("repairs a leading-underscore tool name onto the advertised name", async () => {
    const mangled = bareBash.replace('<invoke name="bash">', '<invoke name="_bash">');
    const output = await readStream(transformDsmlSse(streamOf(sse(mangled)), () => {}, depsWith(KNOWN)));
    const calls = await callsOf(output);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("bash");
  });

  it("does NOT convert when the tool name is not advertised (bare is prose until proven)", async () => {
    const output = await readStream(transformDsmlSse(streamOf(sse(bareBash)), () => {}, depsWith(["read"])));
    expect(output).not.toContain("call_dsml_");
    // Untouched passthrough: the content is still delivered verbatim (only
    // JSON-escaped by the SSE envelope, as it was before this change).
    expect(output).toContain(bareBash.replaceAll('"', '\\"').replaceAll("\n", "\\n"));
  });

  it("does NOT convert when the envelope is not at the end of the reply", async () => {
    const output = await readStream(transformDsmlSse(streamOf(sse(bareBash + "\nmore text")), () => {}, depsWith(KNOWN)));
    expect(output).not.toContain("call_dsml_");
  });

  it("does NOT convert a fenced code example", async () => {
    const output = await readStream(transformDsmlSse(streamOf(sse("```\n" + bareBash + "\n```")), () => {}, depsWith(KNOWN)));
    expect(output).not.toContain("call_dsml_");
  });

  it("does NOT convert when no knownToolNames dep is provided (conservative)", async () => {
    const output = await readStream(transformDsmlSse(streamOf(sse(bareBash)), () => {}, depsWith()));
    expect(output).not.toContain("call_dsml_");
  });

  it("does NOT convert when structured tool_calls are already present", async () => {
    const input =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: bareBash, tool_calls: [{ index: 0, id: "native", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
      "data: [DONE]\n\n";
    const output = await readStream(transformDsmlSse(streamOf(input), () => {}, depsWith(KNOWN)));
    expect(output).toContain('"id":"native"');
    expect(output).not.toContain("call_dsml_");
  });

  it("keeps the marker path working beside the bare path (regression)", async () => {
    const leaked =
      "<" + M + "tool_calls>\n" +
      "<" + M + "invoke name=\"read\"><" + M + "parameter name=\"arguments\" string=\"false\">{\"path\":\"a.txt\"}</" + M + "parameter></" + M + "invoke>\n" +
      "</" + M + "tool_calls>";
    const output = await readStream(transformDsmlSse(streamOf(sse(leaked)), () => {}, depsWith(KNOWN)));
    const calls = await callsOf(output);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read");
    expect(calls[0]!.args).toEqual({ path: "a.txt" });
  });
});