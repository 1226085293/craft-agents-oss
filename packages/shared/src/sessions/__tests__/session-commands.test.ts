import { describe, expect, it } from 'bun:test';
import { isSessionCommand, parseSessionCommand } from '../session-commands.ts';

describe('parseSessionCommand', () => {
  it('recognizes /stop', () => {
    expect(parseSessionCommand('/stop')).toEqual({ name: 'stop', raw: '/stop' });
  });

  it('tolerates surrounding whitespace, case and the Telegram @Bot suffix', () => {
    expect(parseSessionCommand('  /STOP  ')?.name).toBe('stop');
    expect(parseSessionCommand('/stop\n')?.name).toBe('stop');
    expect(parseSessionCommand('/stop@MyBot')?.name).toBe('stop');
  });

  it('rejects arguments so sentences still reach the model', () => {
    expect(parseSessionCommand('/stop the server')).toBeNull();
    expect(parseSessionCommand('/stop\nplease')).toBeNull();
  });

  it('rejects unknown commands, including the internal /reject plan prompt', () => {
    // `/reject` travels through SessionManager.sendMessage; a generic `/xxx`
    // matcher would swallow it and break plan approval.
    expect(parseSessionCommand('/reject')).toBeNull();
    expect(parseSessionCommand('/compact')).toBeNull();
    expect(parseSessionCommand('/clear')).toBeNull();
  });

  it('rejects near-misses', () => {
    expect(parseSessionCommand('/stopx')).toBeNull();
    expect(parseSessionCommand('//stop')).toBeNull();
    expect(parseSessionCommand('stop')).toBeNull();
    expect(parseSessionCommand('please /stop')).toBeNull();
    expect(parseSessionCommand('')).toBeNull();
  });

  it('isSessionCommand mirrors the parser', () => {
    expect(isSessionCommand('/stop')).toBe(true);
    expect(isSessionCommand('/stop@MyBot')).toBe(true);
    expect(isSessionCommand('/reject')).toBe(false);
    expect(isSessionCommand('hello')).toBe(false);
  });
});
