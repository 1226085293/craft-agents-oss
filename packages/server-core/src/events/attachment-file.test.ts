import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AttachmentAccessError,
  readAttachmentContent,
  resolveAttachmentPath,
} from './attachment-file.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'craft-attach-'));
  mkdirSync(join(root, 'events-data', 'listener-1'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveAttachmentPath', () => {
  it('accepts a file inside the workspace events-data directory', () => {
    const file = join(root, 'events-data', 'listener-1', 'report.txt');
    writeFileSync(file, 'ok');

    expect(resolveAttachmentPath(root, file)).toContain('report.txt');
  });

  /**
   * The ingest endpoint takes payloads from any local process, so an unchecked
   * path would let a crafted event read arbitrary files through the renderer.
   */
  it('rejects a file outside events-data', () => {
    const outside = join(root, 'secrets.txt');
    writeFileSync(outside, 'nope');

    try {
      resolveAttachmentPath(root, outside);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AttachmentAccessError);
      expect((error as AttachmentAccessError).code).toBe('attachment_outside_events_data');
    }
  });

  it('rejects a path that only escapes via the parent directory', () => {
    const nested = join(root, 'events-data', 'listener-1', 'x.txt');
    writeFileSync(nested, 'ok');
    const escaping = join(root, 'events-data', 'listener-1', '..', '..', 'secrets.txt');
    writeFileSync(join(root, 'secrets.txt'), 'nope');

    expect(() => resolveAttachmentPath(root, escaping)).toThrow(AttachmentAccessError);
  });

  it('reports a missing file distinctly from an out-of-bounds one', () => {
    try {
      resolveAttachmentPath(root, join(root, 'events-data', 'listener-1', 'missing.txt'));
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as AttachmentAccessError).code).toBe('attachment_not_found');
    }
  });
});

describe('readAttachmentContent', () => {
  it('reads text with its real size', () => {
    const file = join(root, 'events-data', 'listener-1', 'note.md');
    writeFileSync(file, '# 标题\n正文', 'utf8');
    const resolved = resolveAttachmentPath(root, file);

    const content = readAttachmentContent(resolved, 'text', 'text/markdown');

    expect(content.kind).toBe('text');
    if (content.kind !== 'text') throw new Error('unreachable');
    expect(content.text).toContain('正文');
    expect(content.truncated).toBe(false);
  });

  it('wraps images as a data URL of the given mime type', () => {
    const file = join(root, 'events-data', 'listener-1', 'shot.png');
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const resolved = resolveAttachmentPath(root, file);

    const content = readAttachmentContent(resolved, 'dataUrl', 'image/png');

    expect(content.kind).toBe('image');
    if (content.kind !== 'image') throw new Error('unreachable');
    expect(content.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});
