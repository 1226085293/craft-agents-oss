import { describe, it, expect } from 'bun:test';
import { SLASH_COMMANDS, formatSlashCommandHelp, parseSlashCommand } from './slash-commands';

describe('parseSlashCommand', () => {
  it('parses a bare command', () => {
    expect(parseSlashCommand('/stop')).toEqual({ name: 'stop', args: '' });
  });

  it('parses the @bot-suffixed group form', () => {
    expect(parseSlashCommand('/stop@CraftBot')).toEqual({ name: 'stop', args: '' });
  });

  it('keeps the arguments', () => {
    expect(parseSlashCommand('/stop now')).toEqual({ name: 'stop', args: 'now' });
  });

  it('tolerates leading whitespace', () => {
    expect(parseSlashCommand('  /help')).toEqual({ name: 'help', args: '' });
  });

  it('is case-insensitive on the command name', () => {
    expect(parseSlashCommand('/STOP')).toEqual({ name: 'stop', args: '' });
  });

  it('does not recognise names outside the catalogue', () => {
    expect(parseSlashCommand('/compact')).toBeNull();
    expect(parseSlashCommand('/new')).toBeNull();
  });

  it('treats plain text as non-command even when it mentions a command', () => {
    expect(parseSlashCommand('run /stop please')).toBeNull();
    expect(parseSlashCommand('help me with /help')).toBeNull();
  });

  it('handles undefined text', () => {
    expect(parseSlashCommand(undefined)).toBeNull();
  });

  it('accepts a custom catalogue', () => {
    expect(parseSlashCommand('/deploy', [{ name: 'deploy', description: 'x' }])).toEqual({
      name: 'deploy',
      args: '',
    });
    expect(parseSlashCommand('/stop', [{ name: 'deploy', description: 'x' }])).toBeNull();
  });
});

describe('SLASH_COMMANDS', () => {
  it('is the authoritative catalogue', () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual(['stop', 'help']);
  });

  it('keeps menu descriptions phone-readable (Telegram truncates at 25)', () => {
    for (const command of SLASH_COMMANDS) {
      expect(command.description.length).toBeLessThanOrEqual(25);
    }
  });
});

describe('formatSlashCommandHelp', () => {
  it('lists every command in the catalogue', () => {
    const help = formatSlashCommandHelp();
    expect(help).toContain('/stop');
    expect(help).toContain('/help');
    expect(help.split('\n')).toHaveLength(SLASH_COMMANDS.length + 1);
  });
});
