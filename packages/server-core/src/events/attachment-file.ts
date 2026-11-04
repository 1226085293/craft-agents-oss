/**
 * Attachment file access for the Event Center.
 *
 * A listener writes attachments next to its own state and reports the absolute
 * path in the event envelope. Two rules follow from that:
 *
 * 1. The path is only trusted after `realpath` proves it lives inside the
 *    workspace's `events-data`. The ingest endpoint accepts payloads from any
 *    local process, so an unchecked path would turn "open attachment" into an
 *    arbitrary file reader for the renderer.
 * 2. Content is read on demand and capped per kind — a 200 MB attachment must
 *    not be pulled into the renderer just because someone expanded a row.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { EventAttachmentContentDto } from '@craft-agent/shared/protocol';

/** Per-mode caps. Above these the attachment is reported as unsupported. */
export const ATTACHMENT_LIMITS = {
  /** Text previews are for reading, not for loading a whole dump. */
  textBytes: 2 * 1024 * 1024,
  /** Data URLs are ~1.37x the file size in memory; keep images sane. */
  imageBytes: 12 * 1024 * 1024,
  /** PDFs are handed to pdf.js, which needs the whole file. */
  pdfBytes: 24 * 1024 * 1024,
} as const;

export type AttachmentReadMode = 'text' | 'dataUrl' | 'bytes';

export class AttachmentAccessError extends Error {
  constructor(
    message: string,
    readonly code: 'attachment_not_found' | 'attachment_outside_events_data' | 'attachment_too_large',
  ) {
    super(message);
    this.name = 'AttachmentAccessError';
  }
}

/**
 * Resolve an attachment path and prove it stays inside `events-data`.
 *
 * Both sides go through `realpath` so a symlink cannot point the read at, say,
 * `~/.ssh/id_rsa` while the lexical path still looks contained.
 */
export function resolveAttachmentPath(workspaceRoot: string, candidate: string): string {
  let dataRoot: string;
  try {
    dataRoot = realpathSync(join(workspaceRoot, 'events-data'));
  } catch {
    throw new AttachmentAccessError(
      `workspace has no events-data directory: ${workspaceRoot}`,
      'attachment_outside_events_data',
    );
  }

  let target: string;
  try {
    target = realpathSync(candidate);
  } catch {
    throw new AttachmentAccessError(`attachment file is missing: ${candidate}`, 'attachment_not_found');
  }

  const rel = relative(dataRoot, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new AttachmentAccessError(
      'attachment path is outside the workspace events-data directory',
      'attachment_outside_events_data',
    );
  }
  return target;
}

/** Read one attachment in the shape the preview overlays expect. */
export function readAttachmentContent(
  filePath: string,
  mode: AttachmentReadMode,
  mime: string,
): EventAttachmentContentDto {
  const stats = statSync(filePath);
  const bytes = stats.size;

  if (mode === 'bytes') {
    if (bytes > ATTACHMENT_LIMITS.pdfBytes) {
      return {
        kind: 'unsupported',
        reason: `文件 ${formatSize(bytes)} 超过 PDF 预览上限 ${formatSize(ATTACHMENT_LIMITS.pdfBytes)}`,
        bytes,
      };
    }
    const data = readFileSync(filePath);
    return { kind: 'pdf', data: new Uint8Array(data), bytes };
  }

  if (mode === 'dataUrl') {
    if (bytes > ATTACHMENT_LIMITS.imageBytes) {
      return {
        kind: 'unsupported',
        reason: `文件 ${formatSize(bytes)} 超过图片预览上限 ${formatSize(ATTACHMENT_LIMITS.imageBytes)}`,
        bytes,
      };
    }
    const data = readFileSync(filePath);
    return { kind: 'image', dataUrl: `data:${mime || 'application/octet-stream'};base64,${data.toString('base64')}`, bytes };
  }

  // Text: read at most the cap and say so rather than silently cutting.
  const truncated = bytes > ATTACHMENT_LIMITS.textBytes;
  const data = readFileSync(filePath);
  const slice = truncated ? data.subarray(0, ATTACHMENT_LIMITS.textBytes) : data;
  return { kind: 'text', text: slice.toString('utf8'), truncated, bytes };
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
