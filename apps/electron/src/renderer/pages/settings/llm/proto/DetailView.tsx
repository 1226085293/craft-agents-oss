/**
 * 提供商详情 — port of the prototype's `vDetail()`:
 * header card (address / keys / state / quota), the model pill editor with
 * 限时 windows, the sticky key-filter bar, and the key list.
 *
 * Inline edits (key value / note) replace the prototype's contenteditable-ish
 * swap: click → input, ✓ saves through config, Esc cancels.
 */

import * as React from 'react'

import type { LlmConfigShape } from '../types'
import { selectKeyRows, modelOptionsSummary, compactTokens, presetOptionIds, resolvePresetId } from '../helpers'
import { Badge, Dot, Minibar, fmtRemain } from './atoms'
import type { ProtoKeyRow, ProtoProvider } from './viewmodel'
import { useProtoShell } from './state'
import { useListModels } from '../hooks'

interface Props {
  config: LlmConfigShape
  provider: ProtoProvider
  onSave: (next: LlmConfigShape) => Promise<boolean>
}

function winSummaryText(p: ProtoProvider, model: string): string | null {
  const w = p.windows[model]
  if (!w) return null
  const spans = (w.spans ?? []).map((s) => `${s.start}–${s.end}`).join('、')
  return spans || (w.from || w.to ? `${w.from ?? '…'} → ${w.to ?? '…'}` : '')
}

export function DetailView(props: Props): React.JSX.Element {
  const shell = useProtoShell()
  const { config, provider: p } = props
  const [q, setQ] = React.useState('')
  const [excludeDis, setExcludeDis] = React.useState(false)
  const [excludeCool, setExcludeCool] = React.useState(false)
  const [typeFilter, setTypeFilter] = React.useState('all')
  const [sort, setSort] = React.useState<'created-desc' | 'type'>('created-desc')
  const [testing, setTesting] = React.useState<Record<string, 'ok' | 'cool' | 'dis' | 'busy'>>({})
  const [editKey, setEditKey] = React.useState<{ id: string; field: 'key' | 'note'; value: string } | null>(null)
  // The note editor is a textarea that grows with its content, as in the
  // prototype's autosize(): reset to auto, then clamp at 140px so a pasted
  // paragraph scrolls instead of pushing the key row down the page.
  const noteTaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const autosizeNote = React.useCallback((): void => {
    const ta = noteTaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(140, ta.scrollHeight)}px`
  }, [])
  // Size it once on mount: autosize on change alone leaves a two-line note
  // squashed into the rows={2} default until the first keystroke.
  React.useEffect(() => {
    if (editKey?.field === 'note') autosizeNote()
  }, [editKey?.field, editKey?.id, autosizeNote])
  const [discovering, setDiscovering] = React.useState(false)
  const [discovered, setDiscovered] = React.useState<{ models: string[]; ms: number } | null>(null)
  const listModels = useListModels()

  const presetIds = presetOptionIds(config)
  // What a key with no type of its own actually runs: the provider default when
  // that type still exists, else the built-in default. A dangling provider
  // default must not be advertised as the inherited type.
  const inheritType = resolvePresetId(config, p.defaultType)
  const dotc = p.state === 'ok' ? 'green' : p.state === 'cool' ? 'amber' : p.state === 'unavailable' ? 'red' : 'gray'
  const stateLabel = p.state === 'ok' ? '正常' : p.state === 'cool' ? '全部冷却' : p.state === 'unavailable' ? '暂不可用' : '禁用'

  // Filtering lives in helpers so the 继承默认 rule is unit tested: it compares
  // the effective type, and a raw-preset compare hid every inheriting key.
  const rows = selectKeyRows(
    p.keyRows,
    {
      query: q,
      excludeDisabled: excludeDis,
      excludeCooling: excludeCool,
      type: typeFilter,
      inherit: inheritType,
    },
    sort,
  )

  const coolOnes = p.keyRows.filter((k) => k.cool && k.coolUntil)
  const coolHint = coolOnes.length && p.keys.cool ? ` · 最早 ${fmtRemain(Math.min(...coolOnes.map((k) => k.coolUntil ?? 0)))}` : ''

  const writeProvider = async (mut: (cp: LlmConfigShape['providers'][number]) => LlmConfigShape['providers'][number]): Promise<void> => {
    await props.onSave({
      ...config,
      providers: config.providers.map((cp) => (cp.id === p.id ? mut(cp) : cp)),
    })
  }

  const toggleModel = (model: string): void => {
    const on = p.modelList.includes(model)
    void writeProvider((cp) => {
      const models = { ...(cp.models ?? {}) }
      if (on) {
        Object.keys(models).forEach((up) => {
          if (models[up] === model) delete models[up]
        })
      } else {
        models[model] = model
      }
      const timeWindows = { ...(cp.timeWindows ?? {}) }
      if (on) delete timeWindows[model]
      return { ...cp, models, timeWindows }
    })
    shell.toast(on ? `已停用 ${model}` : `已启用 ${model}`)
  }

  const testOne = async (keyId: string): Promise<void> => {
    setTesting((t) => ({ ...t, [keyId]: 'busy' }))
    try {
      const res = await window.electronAPI.llmGatewayTestConnection?.({ providerId: p.id, keyId })
      const tone = res?.success ? 'ok' : /429|rate/i.test(res?.error ?? '') ? 'cool' : 'dis'
      setTesting((t) => ({ ...t, [keyId]: tone }))
      if (!res?.success) shell.toast(res?.error ?? '测试失败')
    } catch {
      setTesting((t) => ({ ...t, [keyId]: 'dis' }))
    }
  }

  /**
   * Ask the upstream what it serves, then show the answer.
   *
   * Results are held in state rather than written straight into the config:
   * the picker below is what commits a selection, so a probe never silently
   * enables models the user did not choose.
   */
  const discover = async (): Promise<void> => {
    setDiscovering(true)
    try {
      const res = await listModels(p.id)
      if (res.ok) {
        setDiscovered({ models: res.models, ms: res.elapsedMs ?? 0 })
        shell.toast(`探测到 ${res.models.length} 个模型`)
      } else {
        setDiscovered(null)
        shell.toast(res.error ?? '探测失败')
      }
    } catch {
      setDiscovered(null)
      shell.toast('探测失败')
    } finally {
      setDiscovering(false)
    }
  }

  /**
   * Commit an inline key/note edit.
   *
   * Enter and the ✓ button both land here; Esc and the ✗ button discard by
   * clearing `editKey`. The input no longer saves on blur — losing focus to a
   * stray click used to commit whatever was half-typed, with no way back.
   */
  const saveInline = (): void => {
    if (!editKey) return
    const { id, field, value } = editKey
    setEditKey(null)
    if (field === 'key' && !value.trim()) {
      shell.toast('Key 不能为空')
      return
    }
    void writeProvider((cp) => ({
      ...cp,
      keys: cp.keys.map((k) => (k.id === id ? { ...k, [field]: value.trim() } : k)),
    }))
    shell.toast(field === 'key' ? 'key 已更新' : '备注已更新')
  }

  const keyRow = (k: ProtoKeyRow): React.JSX.Element => {
    const t = testing[k.id]
    const testTxt = t === 'busy' ? '…' : t === 'ok' ? '✓ 通过' : t === 'cool' ? '✗ 限流 429' : t === 'dis' ? '✗ 不可用' : '测试'
    const testStyle: React.CSSProperties = t === 'ok'
      ? { color: 'var(--state-ok)' }
      : t === 'cool'
        ? { color: 'var(--state-warn)' }
        : t === 'dis'
          ? { color: 'var(--state-bad)' }
          : {}
    const pct = k.rpd ? Math.min(100, Math.round((k.rpd.used / k.rpd.max) * 100)) : 0
    const barTone = k.rpd && k.rpd.used >= k.rpd.max ? 'bad' : pct >= 80 ? 'warn' : 'ok'
    return (
      <div key={k.id} className={`keyitem ${k.enabled ? '' : 'dis'}`}>
        <div className="left">
          {editKey && editKey.id === k.id && editKey.field === 'key' ? (
            // Ported verbatim from the prototype's editKey(): a flex row whose
            // input grows and the two actions sit beside it. ✓ is the plain
            // .btn, cancel is .btn.ghost with ✕ — matching the prototype keeps
            // the visual weight where the design put it.
            <div className="kv-edit">
              <input
                autoFocus
                className="mono"
                value={editKey.value}
                onChange={(e) => setEditKey({ ...editKey, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveInline()
                  if (e.key === 'Escape') setEditKey(null)
                }}
              />
              <div className="edit-actions">
                <button type="button" className="btn" title="保存" onClick={saveInline}>
                  ✓
                </button>
                <button type="button" className="btn ghost" title="取消" onClick={() => setEditKey(null)}>
                  ✕
                </button>
              </div>
            </div>
          ) : (
            <div className="kv mono" title="点击编辑" onClick={() => setEditKey({ id: k.id, field: 'key', value: k.key })}>
              {k.key}
            </div>
          )}
          {editKey && editKey.id === k.id && editKey.field === 'note' ? (
            // The prototype edits notes in an autosizing textarea, not an
            // input: notes are free-form and can wrap.
            <div className="kv-edit">
              <textarea
                autoFocus
                ref={noteTaRef}
                rows={2}
                value={editKey.value}
                onChange={(e) => {
                  setEditKey({ ...editKey, value: e.target.value })
                  autosizeNote()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditKey(null)
                }}
              />
              <div className="edit-actions">
                <button type="button" className="btn" title="保存" onClick={saveInline}>
                  ✓
                </button>
                <button type="button" className="btn ghost" title="取消" onClick={() => setEditKey(null)}>
                  ✕
                </button>
              </div>
            </div>
          ) : (
            <div className="subline" title={k.note} onClick={() => setEditKey({ id: k.id, field: 'note', value: k.note })}>
              {k.note || '点击添加备注'}
            </div>
          )}
          <div className="row" style={{ gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
            {k.cool ? (
              <Badge kind={k.coolReason === 'quota' ? 'red' : 'amber'}>
                {`${k.coolReason === 'quota' ? '配额耗尽' : '限流冷却'} · ${fmtRemain(k.coolUntil ?? Date.now())}`}
              </Badge>
            ) : k.enabled && !k.available ? (
              <Badge kind="red">暂不可用</Badge>
            ) : null}
            {k.rpd ? (
              <>
                <span className="xs faint">{`RPD ${k.rpd.used}/${k.rpd.max}`}</span>
                <Minibar pct={pct} tone={barTone} />
              </>
            ) : null}
          </div>
        </div>
        <div className="right">
          <select
            className="sm"
            value={k.type}
            onChange={(e) => {
              const preset = e.target.value
              void writeProvider((cp) => ({
                ...cp,
                keys: cp.keys.map((ck) => (ck.id === k.id ? { ...ck, preset } : ck)),
              }))
            }}
          >
            <option value="">{`继承默认（${inheritType}）`}</option>
            {presetIds.map((t2) => (
              <option key={t2} value={t2}>
                {t2}
              </option>
            ))}
          </select>
          {/* Two controls stacked in one column: side by side they made the row
              four controls wide and squeezed the key value. The column also
              keeps the delete target from sitting next to the switch, where a
              mis-click would toggle instead of delete. */}
          <div className="keyacts">
            <button
              type="button"
              className="btn sm"
              style={{ padding: '4px 10px', fontSize: 12, ...testStyle }}
              disabled={!k.enabled || t === 'busy'}
              onClick={() => void testOne(k.id)}
            >
              {testTxt}
            </button>
            <button
              type="button"
              className="btn sm danger-ghost"
              style={{ padding: '3px 10px', fontSize: 12 }}
              title="删除这个 key"
              onClick={() => shell.openDialog({ kind: 'key-delete', providerId: p.id, keyId: k.id })}
            >
              删除
            </button>
          </div>
          <button
            type="button"
            className={`switch ${k.enabled ? 'on' : ''}`}
            onClick={() => {
              void writeProvider((cp) => ({
                ...cp,
                keys: cp.keys.map((ck) => (ck.id === k.id ? { ...ck, enabled: !k.enabled } : ck)),
              }))
            }}
          />
        </div>
      </div>
    )
  }

  // This provider's models only. The pool used to union every provider's
  // configured ids, so a freshly created provider offered models that belong
  // to a *different* upstream — clicking one enabled a model this connection
  // has never served.
  const pool = Array.from(new Set([
    ...p.modelList,
    // Probed ids are shown alongside the configured ones so the user can
    // enable what the upstream actually offers. They are NOT written to the
    // config here — toggleModel commits a choice.
    ...(discovered?.models ?? []),
  ]))

  return (
    <>
      <div className="card detail-head">
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <button type="button" className="btn sm" style={{ padding: '4px 10px' }} onClick={shell.goBack}>
              ← 返回
            </button>
            <div>
              <div className="t">
                {p.name} <Dot color={dotc as 'green' | 'amber' | 'red' | 'gray'} />
              </div>
              <div className="small muted">{p.note || '—'}</div>
            </div>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="dinfo">
              <span className="lab">API 地址</span>
              {/* A full chat endpoint is long, and .val clips at 220px — without
                  the title the value reads as "gone" rather than truncated. */}
              <span className="val mono" title={p.url || '(未设置)'}>
                {p.url || <span className="muted">(未设置)</span>}
              </span>
              <span className="lab">协议</span>
              <span className="val">{p.protocol === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI 兼容'}</span>
              <span className="lab">Key</span>
              <span className="val">{`${p.keys.avail} 可用 / ${p.keys.cool} 冷却 / ${p.keys.unavailable} 暂不可用 / ${p.keys.dis} 禁用${coolHint}`}</span>
              <span className="lab">状态</span>
              <span className="val">{stateLabel}</span>
              <span className="lab">模型</span>
              <span className="val">{`${p.modelList.length} 个`}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
              <button type="button" className="btn" onClick={() => shell.openDialog({ kind: 'provider-edit', providerId: p.id })}>
                编辑
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const enable = p.state === 'disabled'
                  void writeProvider((cp) => ({ ...cp, enabled: enable }))
                  shell.toast(enable ? '已启用' : '已禁用')
                }}
              >
                {p.state === 'disabled' ? '启用' : '禁用'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="xs muted" style={{ marginBottom: 8 }}>
              支持的模型 · 悬停标签可移除 · 点击可设置模型（上下文 / 最大输出 / 支持类型 / 限时启用）
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {p.modelList.map((m) => {
                const w = p.windows[m]
                const summary = winSummaryText(p, m)
                const opts = p.modelOptions[m]
                const capa = modelOptionsSummary(opts)
                const tips = [m]
                if (capa) tips.push(`能力 ${capa}`)
                if (w) tips.push(`限时 ${summary} (${w.tz}) —— 窗口内可用，窗口外从调度剔除`)
                tips.push('点击设置模型')
                return (
                  <span
                    key={m}
                    className={`pill wrap${w ? ' win' : ''}`}
                    title={tips.join('\n')}
                    onClick={() => shell.openDialog({ kind: 'model-settings', providerId: p.id, model: m })}
                  >
                    {m}
                    {capa ? <i className="win-sfx">{compactTokens(opts?.contextWindow ?? 0) || '能力'}</i> : null}
                    {w ? <i className="win-sfx">限时</i> : null}
                    <button
                      type="button"
                      className="rm"
                      title="移除（停用）"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleModel(m)
                      }}
                    >
                      ✕
                    </button>
                  </span>
                )
              })}
              <button type="button" className="pill add" title="在下方全部模型中选择" onClick={() => shell.toast('在「全部模型」中点击即可启用')}>
                ＋
              </button>
            </div>
          </div>
        </div>
        <div className="hr" style={{ margin: '14px -16px 10px' }} />
        <div className="spread" style={{ marginBottom: 8 }}>
          <div className="xs muted">
            全部模型 · 点击切换启用状态
            {discovered ? <span className="muted">{` · 探测到 ${discovered.models.length} 个（${discovered.ms}ms）`}</span> : null}
            {p.keys.avail === 0 ? (
              // Probing works without a key; forwarding does not, because the
              // chat call is authenticated from a key row. Say which is which
              // instead of implying both are blocked.
              <span className="muted">{' · 探测不需要 Key；调用需要至少一个可用 Key'}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="btn sm"
            style={{ flexShrink: 0, padding: '3px 10px', fontSize: 12 }}
            disabled={discovering}
            title="向上游请求模型列表（不需要 Key）"
            onClick={() => void discover()}
          >
            {discovering ? '探测中…' : '探测模型'}
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {pool.map((m) => {
            const on = p.modelList.includes(m)
            return (
              <button
                key={m}
                type="button"
                className="pill"
                style={on ? { borderColor: 'var(--color-accent)', color: 'var(--color-accent)', background: 'var(--color-accent-soft)' } : undefined}
                onClick={() => toggleModel(m)}
              >
                {on ? '✓ ' : ''}
                {m}
              </button>
            )
          })}
        </div>
      </div>

      <div className="sticky card" style={{ marginTop: 12 }}>
        <div className="spread">
          <div className="row">
            <input
              type="text"
              placeholder="搜索 key / 备注…"
              style={{ width: 180 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button
              type="button"
              className="btn primary sm"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => shell.openDialog({ kind: 'add-key', providerId: p.id })}
            >
              ＋ 添加 Key
            </button>
            <button
              type="button"
              className="btn sm"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => {
                p.keyRows.filter((k) => k.enabled).forEach((k) => void testOne(k.id))
              }}
            >
              全部测试
            </button>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <label className="row small muted" style={{ gap: 4 }}>
              <input type="checkbox" className="checkbox" checked={excludeDis} onChange={(e) => setExcludeDis(e.target.checked)} />
              排除已禁用
            </label>
            <label className="row small muted" style={{ gap: 4 }}>
              <input type="checkbox" className="checkbox" checked={excludeCool} onChange={(e) => setExcludeCool(e.target.checked)} />
              排除冷却
            </label>
            <select className="sm" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">全部类型</option>
              {presetIds.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select className="sm" value={sort} onChange={(e) => setSort(e.target.value as 'created-desc')}>
              <option value="created-desc">默认排序</option>
              <option value="type">类型名称</option>
            </select>
          </div>
        </div>
      </div>

      {/* `keylist` clips the row hover fill to the card's rounded corners —
          without it the hovered row paints square corners over the radius. */}
      <div className="card keylist" style={{ marginTop: 12, padding: 0 }}>
        {rows.length ? rows.map(keyRow) : (
          <div className="keyitem">
            <span className="muted small">没有匹配的 key</span>
          </div>
        )}
      </div>

      <div className="notice accent" style={{ marginTop: 12 }}>
        💡 点击 key 值或备注直接编辑（Enter 保存 / Esc 取消）；模型标签悬停出现移除按钮，点击可设置限时启用。
      </div>
    </>
  )
}
