import { describe, expect, it } from "bun:test";
import { transformDsmlSse } from "./dsml-receiver.ts";

const leaked =
  '<｜DSML｜tool_calls>\n' +
  '<｜DSML｜invoke name="read"><｜DSML｜parameter name="arguments" string="false">{"path":"a.txt"}</｜DSML｜parameter></｜DSML｜invoke>\n' +
  '</｜DSML｜tool_calls>';

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

describe("DeepSeek DSML receiver", () => {
  it("converts leaked DSML into a native tool_call and tool_calls finish reason", async () => {
    const input =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: leaked }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n";
    const output = await readStream(transformDsmlSse(streamOf(input), () => {}));
    const dataLines = output.split("\n").filter((line) => line.startsWith("data: "));
    const events = dataLines.map((line) => line.slice(6)).filter((line) => line !== "[DONE]").map((line) => JSON.parse(line));
    const call = events.find((event) => event.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe("read");
    expect(JSON.parse(call.function.arguments)).toEqual({ path: "a.txt" });
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(output.indexOf('"tool_calls"')).toBeLessThan(output.indexOf("[DONE]"));
  });

  it("uses distinct tool_call IDs across separate DSML responses", async () => {
    const nl = String.fromCharCode(10);
    const input = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: leaked }, finish_reason: null }] })}${nl}${nl}` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}${nl}${nl}` +
      `data: [DONE]${nl}${nl}`;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const output = await readStream(transformDsmlSse(streamOf(input), () => {}));
      const events = output.split(nl).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).filter((line) => line !== "[DONE]").map((line) => JSON.parse(line));
      const call = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? [])[0];
      ids.push(call.id);
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("passes healthy SSE through unchanged", async () => {
    const input =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n";
    expect(await readStream(transformDsmlSse(streamOf(input), () => {}))).toBe(input);
  });

  it("executes N identical leaked calls only once (dedup)", async () => {
    const NL = String.fromCharCode(10);
    const invokeLine = leaked.split(NL)[1];
    const bashLine = invokeLine.replaceAll("read", "bash").replaceAll('{"path":"a.txt"}', '{"command":"echo 0"}');
    const repeated = leaked.split(NL).map((line, i) => (i === 1 ? [bashLine, bashLine, bashLine].join(NL) : line)).join(NL);
    const input =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: repeated }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n";
    const output = await readStream(transformDsmlSse(streamOf(input), () => {}));
    const dataLines = output.split("\n").filter((line) => line.startsWith("data: "));
    const events = dataLines.map((line) => line.slice(6)).filter((line) => line !== "[DONE]").map((line) => JSON.parse(line));
    const call = events.find((event) => event.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe("bash");
    expect(JSON.parse(call.function.arguments)).toEqual({ command: "echo 0" });
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    const calls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
    expect(calls).toHaveLength(1);

    expect(output.indexOf('"tool_calls"')).toBeLessThan(output.indexOf("[DONE]"));
  });

  it("keeps distinct leaked calls separate (no over-dedup)", async () => {
    const NL = String.fromCharCode(10);
    const invokeLine = leaked.split(NL)[1];
    const bash0 = invokeLine.replaceAll("read", "bash").replaceAll('{"path":"a.txt"}', '{"command":"echo 0"}');
    const bash1 = invokeLine.replaceAll("read", "bash").replaceAll('{"path":"a.txt"}', '{"command":"echo 1"}');
    const distinct = [bash0, bash1, invokeLine].join(NL);
    const input =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: distinct }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n";
    const output = await readStream(transformDsmlSse(streamOf(input), () => {}));
    const dataLines = output.split("\n").filter((line) => line.startsWith("data: "));
    const events = dataLines.map((line) => line.slice(6)).filter((line) => line !== "[DONE]").map((line) => JSON.parse(line));
    const call = events.find((event) => event.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe("bash");
    expect(JSON.parse(call.function.arguments)).toEqual({ command: "echo 0" });
    expect(events.at(-1).choices[0].finish_reason).toBe("tool_calls");
    const calls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => JSON.parse(call.function.arguments).command ?? JSON.parse(call.function.arguments).path)).toEqual(["echo 0", "echo 1", "a.txt"]);

    expect(output.indexOf('"tool_calls"')).toBeLessThan(output.indexOf("[DONE]"));
  });

  it("does not add synthetic calls when structured tool_calls already exist", async () => {
    const input =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: leaked, tool_calls: [{ index: 0, id: "native", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
      "data: [DONE]\n\n";
    const output = await readStream(transformDsmlSse(streamOf(input), () => {}));
    expect(output).toContain('"id":"native"');
    expect(output).not.toContain('"id":"call_dsml_1"');
  });
});
