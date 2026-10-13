import { describe, expect, it } from 'bun:test';
import { DSML_TAG, containsDsmlMarkup, stripDsmlResidue } from '../dsml-strip.ts';

// The 2026-10-12 incident residue (261008-plain-stag, final reply): asymmetric
// tags — parameter OPEN tags without the marker, CLOSE tags with it, no
// `<＼DSML＼invoke>` opener, stray closers at the end.
const malformedLeak =
  '<parameter name="_displayName">查看剩余 diff</' + DSML_TAG + 'parameter>\n' +
  '<parameter name="_intent" string="true">确认并行改动性质（删除 caching 通道？）</' + DSML_TAG + 'parameter>\n' +
  '<parameter name="command" string="true">cd "E:/craft-agents-oss" && git diff | head -80</' + DSML_TAG + 'parameter>\n' +
  '<parameter name="timeout" string="false">30</' + DSML_TAG + 'parameter>\n' +
  '</' + DSML_TAG + 'invoke>\n' +
  '</' + DSML_TAG + 'tool_calls>';

// A well-formed leak (complete structure, matched by the bridge normally).
const wellFormedLeak =
  '<' + DSML_TAG + 'tool_calls>\n' +
  '<' + DSML_TAG + 'invoke name="read"><' + DSML_TAG + 'parameter name="arguments" string="false">{"path":"a.txt"}</' + DSML_TAG + 'parameter></' + DSML_TAG + 'invoke>\n' +
  '</' + DSML_TAG + 'tool_calls>';

describe('stripDsmlResidue', () => {
  it('strips the malformed asymmetric leak (261008-plain-stag shape) entirely', () => {
    expect(stripDsmlResidue(malformedLeak)).toBe('');
  });

  it('strips a well-formed leak block entirely', () => {
    expect(stripDsmlResidue(wellFormedLeak)).toBe('');
  });

  it('keeps surrounding prose intact around a stripped block', () => {
    const text = `已完成调查。\n${malformedLeak}\n以上就是发现的改动。`;
    const out = stripDsmlResidue(text);
    expect(out).toContain('已完成调查。');
    expect(out).toContain('以上就是发现的改动。');
    expect(out).not.toContain('parameter');
    expect(out).not.toContain(DSML_TAG);
  });

  it('returns input unchanged when no marker is present (no false scrub)', () => {
    const normal = '用户讨论 <parameter name="x">XML</parameter> 是正常内容';
    expect(stripDsmlResidue(normal)).toBe(normal);
    expect(stripDsmlResidue('<invoke name="read"></invoke>')).toBe('<invoke name="read"></invoke>');
  });

  it('handles marker-only garbage and empty strings', () => {
    expect(stripDsmlResidue('</' + DSML_TAG + 'tool_calls>')).toBe('');
    expect(stripDsmlResidue('')).toBe('');
    expect(containsDsmlMarkup(malformedLeak)).toBe(true);
    expect(containsDsmlMarkup('plain text')).toBe(false);
  });

  it('is idempotent', () => {
    const once = stripDsmlResidue(`前文\n${malformedLeak}\n后文`);
    expect(stripDsmlResidue(once)).toBe(once);
  });
});
