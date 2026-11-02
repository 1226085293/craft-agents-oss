/**
 * 策略组 — port of `vStrategies()` + `strategyCardsHtml()`.
 *
 * Health/cooling are derived from live key state (the gateway does not expose
 * per-strategy counters), and the "最近 1h" line is computed from the merged
 * request log rather than a strategy field the real schema doesn't have.
 */

import * as React from 'react'

import type { LlmConfigShape } from '../types'
import { Badge } from './atoms'
import type { ProtoLogRow, ProtoProvider, ProtoStrategy } from './viewmodel'
import { useProtoShell } from './state'
import { STRATEGY_TYPE_LABEL } from '../helpers'

interface Props {
  config: LlmConfigShape
  strategies: ProtoStrategy[]
  providers: ProtoProvider[]
  logs: ProtoLogRow[]
  onSave: (next: LlmConfigShape) => Promise<boolean>
  onOpenStrategyLogs: (id: string) => void
}

export function StrategiesView(props: Props): React.JSX.Element {
  const shell = useProtoShell()
  const [q, setQ] = React.useState('')
  const needle = q.trim().toLowerCase()
  const list = props.strategies.filter((s) => {
    if (!needle) return true
    if (s.name.toLowerCase().includes(needle)) return true
    return s.models.some((m) => m.toLowerCase().includes(needle))
  })

  const now = Date.now()

  return (
    <>
      <div className="page-title">策略组</div>
      <div className="page-desc">会话通过策略组选择模型；一个策略组 = 一组提供商 + 调度规则</div>
      <div className="sticky card">
        <div className="spread">
          <input
            type="text"
            placeholder="搜索名称 / 模型名…"
            style={{ width: 230 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="button" className="btn primary" onClick={() => shell.openDialog({ kind: 'strategy-edit', strategyId: null })}>
            ＋ 新建策略组
          </button>
        </div>
      </div>
      <div className="grid2" style={{ marginTop: 14 }}>
        {list.length ? (
          list.map((s) => {
            const unsupported = s.models.filter(
              // A unit with no model is the old "any model this provider
              // declares" member; it covers every model the provider lists.
              (m) =>
                !s.units.some(
                  (u) =>
                    u.model === m ||
                    (u.model === '' &&
                      props.providers.find((p) => p.id === u.provider)?.modelList.includes(m)),
                ),
            )
            const r1h = props.logs.filter((l) => l.tsMs >= now - 36e5 && l.strategy === s.id)
            const avg1h = r1h.length ? Math.round(r1h.reduce((a, l) => a + l.dur, 0) / r1h.length) : 0
            const members = s.members.map((id) => props.providers.find((p) => p.id === id)).filter(Boolean) as ProtoProvider[]
            const healthy = members.filter((p) => p.state === 'ok').length
            const health = members.length ? Math.round((healthy / members.length) * 100) : 0
            const cool = members.reduce((a, p) => a + p.keys.cool, 0)
            const unavailable = members.reduce((a, p) => a + p.keys.unavailable, 0)
            const shown = s.models.slice(0, 3)
            const extra = s.models.length - 3
            return (
              <div key={s.id} className="card" style={{ opacity: s.enabled ? 1 : 0.55 }}>
                <div className="spread">
                  <b>{s.name}</b>
                  <div className="row" style={{ gap: 6 }}>
                    {s.enabled ? null : <Badge kind="gray">已禁用</Badge>}
                    <Badge kind="accent">{STRATEGY_TYPE_LABEL[s.type] ?? s.type}</Badge>
                    {s.sticky ? <Badge kind="gray">粘性</Badge> : null}
                  </div>
                </div>
                <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                  {shown.map((m) => (
                    <span
                      key={m}
                      className="pill click"
                      onClick={() => {
                        void navigator.clipboard?.writeText(m)
                        shell.toast(`已复制模型 ID：${m}`)
                      }}
                    >
                      {m}
                    </span>
                  ))}
                  {extra > 0 ? <span className="pill plain">{`+${extra}`}</span> : null}
                  {s.models.length === 0 ? <span className="xs muted">未指定模型</span> : null}
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <span style={{ marginRight: 6 }}>
                    <Badge kind="green">{`健康 ${health}`}</Badge>
                  </span>
                  {cool ? (
                    <span style={{ marginRight: 6 }}>
                      <Badge kind="amber">{`冷却 ${cool}`}</Badge>
                    </span>
                  ) : null}
                  {unavailable ? (
                    <span style={{ marginRight: 6 }}>
                      <Badge kind="red">{`暂不可用 ${unavailable}`}</Badge>
                    </span>
                  ) : null}
                  <span style={{ marginRight: 6 }}>
                    <Badge kind="gray">{`${s.units.length} 个切换单元`}</Badge>
                  </span>
                  {s.type === 'weighted' && s.members.length ? (
                    <Badge kind="gray">{`权重 ${s.members.map((id) => s.weights[id] ?? 1).join(':')}`}</Badge>
                  ) : null}
                  {unsupported.length ? (
                    <Badge kind="amber" title={`${unsupported.join('、')} 没有成员支持`}>
                      {`⚠ ${unsupported.length} 个模型无成员支持`}
                    </Badge>
                  ) : null}
                </div>
                <div className="xs faint" style={{ marginTop: 8 }}>
                  {`最近 1h 请求 ${r1h.length}${r1h.length ? ` · 平均 ${(avg1h / 1000).toFixed(1)}s` : ''}`}
                </div>
                {s.units.length ? (
                  <div className="xs muted" style={{ marginTop: 6 }} title="按此顺序依次尝试">
                    {`切换顺序：${s.units
                      .slice(0, 4)
                      .map((u) => `${u.providerName}${u.model ? ` / ${u.model}` : ''}`)
                      .join(' → ')}${s.units.length > 4 ? ` → +${s.units.length - 4}` : ''}`}
                  </div>
                ) : null}
                <div className="hr" style={{ margin: '10px 0' }} />
                <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => props.onOpenStrategyLogs(s.id)}
                  >
                    日志
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => {
                      const next = {
                        ...props.config,
                        strategies: props.config.strategies.map((x) =>
                          x.id === s.id ? { ...x, enabled: !s.enabled } : x,
                        ),
                      }
                      void props.onSave(next).then((ok) => {
                        if (ok) shell.toast(s.enabled ? `已禁用 ${s.name}` : `已启用 ${s.name}`)
                      })
                    }}
                  >
                    {s.enabled ? '禁用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => shell.openDialog({ kind: 'strategy-edit', strategyId: s.id })}
                  >
                    编辑
                  </button>
                </div>
              </div>
            )
          })
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: 30 }}>
            <span className="muted small">没有匹配的策略组</span>
          </div>
        )}
      </div>
    </>
  )
}
