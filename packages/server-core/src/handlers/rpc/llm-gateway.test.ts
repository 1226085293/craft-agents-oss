/**
 * The model-discovery helpers behind the 探测模型 button.
 *
 * Both functions sit between an arbitrary user-pasted baseUrl / an arbitrary
 * upstream response and the config's `models` map, so the cases here are the
 * shapes actually seen in the wild rather than the tidy ones.
 */

import { describe, expect, test } from 'bun:test'
import { extractModelIds, modelsEndpointFor, pickModelKey } from './llm-gateway'

describe('pickModelKey', () => {
  const keys = [
    { id: 'off', key: 'sk-off', enabled: false },
    { id: 'on', key: 'sk-on' },
    { id: 'on2', key: 'sk-on2', enabled: true },
  ]

  test('no keys at all is not an error — the probe goes out unauthenticated', () => {
    // A local relay that trusts its caller has nothing to paste; refusing here
    // made such a provider undiscoverable until a placeholder secret was made up.
    expect(pickModelKey([])).toEqual({ key: undefined })
  })

  test('picks the first enabled key when several exist', () => {
    expect(pickModelKey(keys)?.key?.id).toBe('on')
  })

  test('skips disabled keys', () => {
    expect(pickModelKey([keys[0], keys[2]])?.key?.id).toBe('on2')
  })

  test('all keys disabled degenerates to unauthenticated, not an error', () => {
    expect(pickModelKey([keys[0]])).toEqual({ key: undefined })
  })

  test('an explicit keyId is honoured', () => {
    expect(pickModelKey(keys, 'on2')?.key?.id).toBe('on2')
  })

  test('an explicit keyId that is missing or disabled is an error', () => {
    // The caller asked for that key specifically; falling back silently would
    // probe with a credential they did not choose.
    expect(pickModelKey(keys, 'nope')?.error).toContain('key not found')
    expect(pickModelKey(keys, 'off')?.error).toBe('该 key 已停用')
  })
})

describe('modelsEndpointFor', () => {
  test('a bare origin gets the conventional /v1/models', () => {
    expect(modelsEndpointFor('https://api.example.cn')).toBe('https://api.example.cn/v1/models')
  })

  test('a version root keeps its version segment', () => {
    expect(modelsEndpointFor('https://api.example.cn/v1')).toBe('https://api.example.cn/v1/models')
    expect(modelsEndpointFor('http://localhost:8000/v1')).toBe('http://localhost:8000/v1/models')
  })

  test('a full chat endpoint is trimmed back to the version root', () => {
    expect(modelsEndpointFor('https://api.example.cn/v1/chat/completions')).toBe('https://api.example.cn/v1/models')
  })

  test('anthropic messages and responses paths are trimmed too', () => {
    expect(modelsEndpointFor('https://api.example.cn/v1/messages')).toBe('https://api.example.cn/v1/models')
    expect(modelsEndpointFor('https://api.example.cn/v1/responses')).toBe('https://api.example.cn/v1/models')
  })

  test('a non-v1 prefix is preserved rather than overwritten', () => {
    expect(modelsEndpointFor('https://api.example.cn/api/v3/chat/completions')).toBe('https://api.example.cn/api/v3/models')
  })

  test('surrounding whitespace and a trailing slash are tolerated', () => {
    expect(modelsEndpointFor('  https://api.example.cn/v1/  ')).toBe('https://api.example.cn/v1/models')
  })

  // A relay that selects a tenant by query (`?realm=cn`) needs that parameter on
  // every path, not only the chat one. The path rewrite must not drop it — a
  // probe that loses it gets a 401 from a relay that never checks keys, which
  // reads as "bad key" and sends the user to the wrong screen.
  test('a query string survives the path rewrite', () => {
    expect(modelsEndpointFor('http://127.0.0.1:8788/v1/chat/completions?realm=cn')).toBe(
      'http://127.0.0.1:8788/v1/models?realm=cn',
    )
    expect(modelsEndpointFor('http://127.0.0.1:8788/v1?realm=cn')).toBe(
      'http://127.0.0.1:8788/v1/models?realm=cn',
    )
  })

  test('an empty or non-URL address yields empty so the caller can report it', () => {
    expect(modelsEndpointFor('')).toBe('')
    expect(modelsEndpointFor('   ')).toBe('')
    expect(modelsEndpointFor('not a url')).toBe('')
    expect(modelsEndpointFor('api.example.cn/v1')).toBe('')
  })
})

describe('extractModelIds', () => {
  test('the standard OpenAI shape', () => {
    expect(
      extractModelIds({ object: 'list', data: [{ id: 'gpt-4' }, { id: 'gpt-3.5' }] }),
    ).toEqual(['gpt-4', 'gpt-3.5'])
  })

  test('a bare array of ids', () => {
    expect(extractModelIds(['a', 'b'])).toEqual(['a', 'b'])
  })

  test('a bare array of objects', () => {
    expect(extractModelIds([{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b'])
  })

  test('nested under `models`', () => {
    expect(extractModelIds({ models: [{ id: 'x' }, { id: 'y' }] })).toEqual(['x', 'y'])
  })

  test('a map of id -> object falls back to the keys', () => {
    expect(extractModelIds({ 'gpt-4': {}, 'gpt-3.5': {} })).toEqual(['gpt-4', 'gpt-3.5'])
  })

  test('duplicates are collapsed, order is preserved', () => {
    expect(extractModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] })).toEqual(['b', 'a'])
  })

  test('id wins over name and model', () => {
    expect(extractModelIds({ data: [{ id: 'upstream-id', name: 'Pretty Name', model: 'other' }] })).toEqual(['upstream-id'])
  })

  test('falls back to `model` then `name` when there is no id', () => {
    expect(extractModelIds({ data: [{ model: 'm1' }] })).toEqual(['m1'])
    expect(extractModelIds({ data: [{ name: 'n1' }] })).toEqual(['n1'])
  })

  test('blank and non-string ids are dropped', () => {
    expect(extractModelIds({ data: [{ id: '  ' }, { id: 'ok' }, { id: 42 }] })).toEqual(['ok'])
  })

  test('whitespace around an id is trimmed', () => {
    expect(extractModelIds({ data: [{ id: '  gpt-4  ' }] })).toEqual(['gpt-4'])
  })

  test('an empty or unusable body yields an empty list', () => {
    expect(extractModelIds({})).toEqual([])
    expect(extractModelIds({ data: [] })).toEqual([])
    expect(extractModelIds(null)).toEqual([])
    expect(extractModelIds('nope')).toEqual([])
    expect(extractModelIds(42)).toEqual([])
  })

  test('the real uni-api response shape', () => {
    expect(
      extractModelIds({
        object: 'list',
        data: [
          { id: 'auto', object: 'model', created: 1720524448858, owned_by: 'uni-api' },
          { id: 'agnes-3.0-flash', object: 'model', created: 1720524448858, owned_by: 'uni-api' },
        ],
      }),
    ).toEqual(['auto', 'agnes-3.0-flash'])
  })
})
