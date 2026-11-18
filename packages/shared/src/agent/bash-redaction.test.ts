/**
 * String-level redaction: the common leaks, and the things that must survive.
 *
 * The negative cases matter as much as the positive ones — a redactor that eats
 * checksums and base64 build output makes every transcript useless, and people
 * turn it off.
 */
import { describe, expect, it } from 'bun:test';

import { redactBashOutput, redactCommand } from './bash-redaction.ts';

describe('env dump', () => {
  it('masks credential-named exports and keeps the name', () => {
    const out = redactBashOutput('export GITHUB_TOKEN=ghp_abcdefghijklmnopqrst\nPATH=/usr/bin');
    expect(out).toContain('GITHUB_TOKEN=');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrst');
    // Non-secret variables are untouched.
    expect(out).toContain('PATH=/usr/bin');
  });

  it('leaves an empty value alone (it is a hint, not a leak)', () => {
    expect(redactBashOutput('OPENAI_API_KEY=')).toBe('OPENAI_API_KEY=');
  });

  it('handles the non-export form too', () => {
    const out = redactBashOutput('DB_PASSWORD=hunter2hunter2');
    expect(out).not.toContain('hunter2hunter2');
  });
});

describe('structured leaks', () => {
  it('masks credentials in URLs but keeps scheme, user and host', () => {
    const out = redactBashOutput('Cloning https://alice:s3cr3t-token@github.com/x/y.git');
    expect(out).toContain('https://alice:');
    expect(out).toContain('@github.com/x/y.git');
    expect(out).not.toContain('s3cr3t-token');
  });

  it('masks credential flags', () => {
    const out = redactBashOutput('mysql --password=hunter2hunter2 -u root');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).toContain('--password=');
  });

  it('masks vendor-shaped tokens', () => {
    const out = redactBashOutput('sk-abcdefghijklmnopqrstuvwx');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwx');
  });

  it('masks an echoed Authorization header', () => {
    const out = redactBashOutput('> Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(out).toContain('Authorization:');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig');
  });

  it('masks a whole PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nmore\n-----END RSA PRIVATE KEY-----';
    const out = redactBashOutput(pem);
    expect(out).toBe('[REDACTED PRIVATE KEY]');
    expect(out).not.toContain('MIIEow');
  });
});

describe('what must survive', () => {
  it('leaves git hashes and checksums alone', () => {
    const text = 'commit 3f786850e387550fdab836ed7e6dc881de23001b sha256:9f86d081884c7d659a2feaa0c55ad015';
    expect(redactBashOutput(text)).toBe(text);
  });

  it('leaves ordinary build output alone', () => {
    const text = 'added 132 packages, and audited 133 packages in 4s\nfound 0 vulnerabilities';
    expect(redactBashOutput(text)).toBe(text);
  });

  it('leaves non-secret-looking env alone', () => {
    const text = 'NODE_ENV=production\nHOME=/home/alice';
    expect(redactBashOutput(text)).toBe(text);
  });

  it('returns empty input unchanged', () => {
    expect(redactBashOutput('')).toBe('');
  });
});

describe('redactCommand', () => {
  it('masks a token passed as an argument', () => {
    const out = redactCommand('curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com');
    expect(out).not.toContain('abcdefghijklmnop');
  });
});
