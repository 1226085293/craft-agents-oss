import { describe, expect, it } from 'bun:test';
import { detectLeakedToolCall } from './leaked-toolcall.ts';

// The exact shape observed in the 2026-10-04 incident (261004-tall-nickel):
// deepseek-v4-flash leaked the DSML tool-call block as literal text.
const INCIDENT_TEXT = [
  '\n\n',
  '',
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="read">',
  '<｜DSML｜parameter name="arguments" string="false">{"_displayName": "查看模式分析", "_intent": "读取结果", "path": "C:\\\\Users\\\\12260\\\\pattern.txt"}</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls>',
].join('\n');

describe('detectLeakedToolCall', () => {
  it('detects the incident text and extracts the intended tool name', () => {
    const r = detectLeakedToolCall(INCIDENT_TEXT);
    expect(r.leaked).toBe(true);
    expect(r.callNames).toEqual(['read']);
  });

  it('extracts multiple distinct invoke names (deduplicated)', () => {
    const text =
      '<｜DSML｜tool_calls>\n' +
      '<｜DSML｜invoke name="bash"><｜DSML｜parameter name="arguments" string="false">{"command":"ls"}</｜DSML｜parameter></｜DSML｜invoke>\n' +
      '<｜DSML｜invoke name="read"><｜DSML｜parameter name="arguments" string="false">{"path":"a.txt"}</｜DSML｜parameter></｜DSML｜invoke>\n' +
      '<｜DSML｜invoke name="read"><｜DSML｜parameter name="arguments" string="false">{"path":"b.txt"}</｜DSML｜parameter></｜DSML｜invoke>\n' +
      '</｜DSML｜tool_calls>';
    const r = detectLeakedToolCall(text);
    expect(r.leaked).toBe(true);
    expect(r.callNames).toEqual(['bash', 'read']);
  });

  it('does not flag plain text mentioning the markers without a block', () => {
    const r = detectLeakedToolCall('The model supports 12 tool types like read and bash.');
    expect(r.leaked).toBe(false);
    expect(r.callNames).toEqual([]);
  });

  it('does not flag text that only contains a bare marker', () => {
    // A mention of the token itself without an invoke/tool_calls block.
    const r = detectLeakedToolCall('Some docs describe the ｜DSML｜ special token format.');
    expect(r.leaked).toBe(false);
  });

  it('treats empty/undefined input as not leaked', () => {
    expect(detectLeakedToolCall('').leaked).toBe(false);
    expect(detectLeakedToolCall(undefined as unknown as string).leaked).toBe(false);
  });
});
