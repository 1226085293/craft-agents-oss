/**
 * `baseUrl` has three legitimate shapes in the wild, and users paste all of
 * them. These tests pin the resolution contract: the stored value is never
 * rewritten, the request always lands on a real chat endpoint, and a query
 * string survives because relays use it to select the tenant.
 *
 * 261027-long-bronze: `http://127.0.0.1:8788/v1` was POSTed verbatim, the relay
 * answered 404 on its root in 25 ms, and the gateway reported a generic 502.
 * The same relay answers 200 on `/v1/chat/completions`.
 */

import { describe, expect, it } from 'bun:test';
import { chatEndpointFor, modelsEndpointFor } from '../llm-endpoint.ts';

describe('chatEndpointFor — openai-completions', () => {
  it('appends the chat path to a version root', () => {
    expect(chatEndpointFor('http://127.0.0.1:8788/v1', 'openai-completions')).toBe(
      'http://127.0.0.1:8788/v1/chat/completions',
    );
  });

  it('leaves a full chat endpoint untouched', () => {
    expect(
      chatEndpointFor('http://127.0.0.1:8788/v1/chat/completions', 'openai-completions'),
    ).toBe('http://127.0.0.1:8788/v1/chat/completions');
  });

  it('adds v1 to a bare origin', () => {
    expect(chatEndpointFor('https://api.example.cn', 'openai-completions')).toBe(
      'https://api.example.cn/v1/chat/completions',
    );
  });

  it('keeps a custom version root instead of forcing v1', () => {
    expect(chatEndpointFor('https://api.example.cn/api/v3', 'openai-completions')).toBe(
      'https://api.example.cn/api/v3/chat/completions',
    );
  });

  it('keeps the version segment a relay needs', () => {
    expect(chatEndpointFor('https://api.example.cn/v1beta', 'openai-completions')).toBe(
      'https://api.example.cn/v1beta/chat/completions',
    );
  });

  it('tolerates a trailing slash', () => {
    expect(chatEndpointFor('http://127.0.0.1:8788/v1/', 'openai-completions')).toBe(
      'http://127.0.0.1:8788/v1/chat/completions',
    );
  });

  it('preserves a query string on a version root', () => {
    expect(chatEndpointFor('https://relay.example.cn/v1?realm=cn', 'openai-completions')).toBe(
      'https://relay.example.cn/v1/chat/completions?realm=cn',
    );
  });

  it('preserves a query string on a full endpoint', () => {
    // This is the shape the settings form suggests and the one `modelsEndpointFor`
    // already had to learn to keep.
    expect(
      chatEndpointFor(
        'https://relay.example.cn/v1/chat/completions?realm=cn&tenant=acme',
        'openai-completions',
      ),
    ).toBe('https://relay.example.cn/v1/chat/completions?realm=cn&tenant=acme');
  });

  it('does not invent a v1 inside an Azure deployment path', () => {
    // The deployment URL is already an endpoint; adding /v1 would 404.
    expect(
      chatEndpointFor(
        'https://acme.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-05-01',
        'openai-completions',
      ),
    ).toBe(
      'https://acme.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-05-01',
    );
  });

  it('preserves the protocol and port of a loopback relay', () => {
    expect(chatEndpointFor('http://127.0.0.1:8788/v1', 'openai-completions')).toContain(
      'http://127.0.0.1:8788',
    );
  });
});

describe('chatEndpointFor — anthropic-messages', () => {
  it('appends /messages to a version root', () => {
    expect(chatEndpointFor('https://api.anthropic.com/v1', 'anthropic-messages')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
  });

  it('leaves a full messages endpoint untouched', () => {
    expect(
      chatEndpointFor('https://api.example.cn/v1/messages', 'anthropic-messages'),
    ).toBe('https://api.example.cn/v1/messages');
  });

  it('adds v1/messages to a bare origin', () => {
    expect(chatEndpointFor('https://proxy.example.cn', 'anthropic-messages')).toBe(
      'https://proxy.example.cn/v1/messages',
    );
  });

  it('replaces an OpenAI chat path instead of appending to it', () => {
    // Flipping the protocol on an existing provider must not produce
    // `…/chat/completions/messages`.
    expect(
      chatEndpointFor('https://relay.example.cn/v1/chat/completions', 'anthropic-messages'),
    ).toBe('https://relay.example.cn/v1/messages');
  });
});

describe('modelsEndpointFor', () => {
  it('drops a chat suffix and appends /models', () => {
    expect(modelsEndpointFor('https://api.example.cn/v1/chat/completions')).toBe(
      'https://api.example.cn/v1/models',
    );
    expect(modelsEndpointFor('https://api.example.cn/v1/messages')).toBe(
      'https://api.example.cn/v1/models',
    );
  });

  it('keeps a version root and adds /models', () => {
    expect(modelsEndpointFor('http://127.0.0.1:8788/v1')).toBe(
      'http://127.0.0.1:8788/v1/models',
    );
  });

  it('adds v1 to a bare origin', () => {
    expect(modelsEndpointFor('https://api.example.cn')).toBe(
      'https://api.example.cn/v1/models',
    );
  });

  it('preserves the query string', () => {
    expect(modelsEndpointFor('https://relay.example.cn/v1/chat/completions?realm=cn')).toBe(
      'https://relay.example.cn/v1/models?realm=cn',
    );
  });

  it('returns an empty string for degenerate input', () => {
    expect(modelsEndpointFor('')).toBe('');
    expect(modelsEndpointFor('not a url')).toBe('');
  });
});

describe('chatEndpointFor — degenerate input', () => {
  it('returns an empty string for an empty baseUrl', () => {
    expect(chatEndpointFor('', 'openai-completions')).toBe('');
    expect(chatEndpointFor('   ', 'openai-completions')).toBe('');
  });

  it('returns the trimmed input when it cannot be parsed', () => {
    // The caller must fail with a transport error naming the real string, not a
    // URL this helper invented.
    expect(chatEndpointFor('  not a url  ', 'openai-completions')).toBe('not a url');
  });

  it('drops a hash, which carries no meaning on the wire', () => {
    expect(chatEndpointFor('https://api.example.cn/v1#frag', 'openai-completions')).toBe(
      'https://api.example.cn/v1/chat/completions',
    );
  });
});
