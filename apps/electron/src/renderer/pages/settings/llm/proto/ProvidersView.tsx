/**
 * 提供商 (providers) — port of `vProviders()`: the card grid with its sticky
 * filter bar, plus the 类型（预设） sub-page (`typesPageHtml`).
 *
 * The card grid reuses the prototype's `.pcard` DOM exactly; enable/disable
 * writes through the shell's single save path.
 */

import * as React from 'react'

import type { LlmConfigShape } from '../types'
import { Badge, Dot } from './atoms'
import type { ProtoProvider } from './viewmodel'
import type { ProvTab } from './state'
import { useProtoShell } from './state'
import { TypeCard, applyTypeDrafts, draftFromConfig, draftsKey, MANDATORY_DEFAULTS, type TypeDraft } from './TypeCard'
import { DEFAULT_PRESET_ID } from '../types'
import { presetUsage } from '../helpers'

interface Props {
  config: LlmConfigShape
  providers: ProtoProvider[]
  tab: ProvTab
  onTab: (t: ProvTab) => void
  onSave: (next: LlmConfigShape) => Promise<boolean>
}

export function ProvidersView(props: Props): React.JSX.Element {
  const shell = useProtoShell()
  const [q, setQ] = React.useState('')
  const [sort, setSort] = React.useState<'health' | 'keys' | 'tokens'>('health')
  const [includeDisabled, setIncludeDisabled] = React.useState(false)

  // Drafts live here (not inside TypesPage) so the save action can sit in the
  // tab row, which is where the prototype puts it.
  const [drafts, setDrafts] = React.useState<TypeDraft[]>(() => draftFromConfig(props.config))
  React.useEffect(() => {
    setDrafts(draftFromConfig(props.config))
  }, [props.config])

  // Shared with the provider dialog and unit tested: a key counts under the
  // type it actually resolves to, not a dangling id it still cites.
  const usageOf = (name: string): { providers: number; keys: number } => presetUsage(name, props.config)

  // Only a real edit enables 保存类型: a live button on an untouched list reads
  // as "unsaved changes" and invites clicks that write the config unchanged.
  const typesDirty = draftsKey(drafts) !== draftsKey(draftFromConfig(props.config))

  const saveTypes = async (): Promise<void> => {
    if (!drafts.filter((d) => d.name.trim()).length) {
      shell.toast('至少保留 1 个类型')
      return
    }
    const ok = await props.onSave(applyTypeDrafts(props.config, drafts))
    if (ok) shell.toast('类型已保存')
  }

  const list = props.providers
    .filter((p) => includeDisabled || p.state !== 'disabled')
    .filter((p) => (p.name + p.note + p.url).toLowerCase().includes(q.toLowerCase()))
  const order: Record<string, (a: ProtoProvider, b: ProtoProvider) => number> = {
    keys: (a, b) => b.keys.avail - a.keys.avail,
    tokens: (a, b) => b.keys.avail - a.keys.avail,
  }
  const healthRank = { ok: 0, cool: 1, disabled: 2 }
  const sorted =
    sort === 'health'
      ? [...list].sort((a, b) => healthRank[a.state] - healthRank[b.state])
      : [...list].sort(order[sort])

  const head = (
    <>
      <div className="page-title">提供商</div>
      <div className="page-desc">网关路由到的上游端点，以及使用的密钥</div>
      <div className="spread" style={{ alignItems: 'center', marginBottom: 18 }}>
        <div className="subtabs" style={{ margin: 0 }}>
          <button type="button" className={props.tab === 'list' ? 'on' : ''} onClick={() => props.onTab('list')}>
            提供商
          </button>
          <button type="button" className={props.tab === 'types' ? 'on' : ''} onClick={() => props.onTab('types')}>
            类型（预设）
          </button>
        </div>
        {props.tab === 'types' ? (
          <button
            type="button"
            className="btn primary"
            disabled={!typesDirty}
            title={typesDirty ? undefined : '没有改动'}
            onClick={() => void saveTypes()}
          >
            保存类型
          </button>
        ) : null}
      </div>
    </>
  )

  if (props.tab === 'types') {
    return (
      <>
        {head}
        <TypesPage
          drafts={drafts}
          usageOf={usageOf}
          onChange={(i, next) => setDrafts((prev) => prev.map((x, j) => (j === i ? next : x)))}
          onRemove={(i) => setDrafts((prev) => prev.filter((_, j) => j !== i))}
          onAdd={() =>
            setDrafts((prev) => [
              ...prev,
              // Same rule as the provider dialog's 添加类型: a new card starts
              // with only the fields the gateway cannot run without. The quota
              // limits stay empty, where empty means "no limit".
              { name: '', limits: { ...MANDATORY_DEFAULTS } },
            ])
          }
        />
      </>
    )
  }

  const winCount = (p: ProtoProvider): number =>
    Object.values(p.windows).filter((w) => (w.spans?.length ?? 0) > 0 || w.from || w.to).length

  return (
    <>
      {head}
      <div className="sticky card">
        <div className="spread" style={{ flexWrap: 'wrap', rowGap: 10 }}>
          <input
            type="text"
            placeholder="搜索名称 / 备注 / 地址…"
            style={{ width: 230 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="row">
            <select className="sm" value={sort} onChange={(e) => setSort(e.target.value as 'health')}>
              <option value="health">健康度排序</option>
              <option value="keys">key 数量</option>
              <option value="tokens">token 用量</option>
            </select>
            <label className="row small muted" style={{ gap: 5 }}>
              <input
                type="checkbox"
                className="checkbox"
                checked={includeDisabled}
                onChange={(e) => setIncludeDisabled(e.target.checked)}
              />
              包含禁用卡片
            </label>
            <button type="button" className="btn primary" onClick={() => shell.openDialog({ kind: 'provider-create' })}>
              ＋ 新建提供商
            </button>
          </div>
        </div>
      </div>
      <div className="grid2" style={{ marginTop: 14 }}>
        {sorted.length ? (
          sorted.map((p) => {
            const cls = p.state === 'cool' ? ' cool' : p.state === 'disabled' ? ' disabled' : ''
            const dotc = p.state === 'ok' ? 'green' : p.state === 'cool' ? 'amber' : 'gray'
            const enabled = p.state !== 'disabled'
            const toggle = (e: React.MouseEvent): void => {
              e.stopPropagation()
              void props.onSave({
                ...props.config,
                providers: props.config.providers.map((cp) =>
                  cp.id === p.id ? { ...cp, enabled: !enabled } : cp,
                ),
              })
              shell.toast(enabled ? `已禁用「${p.name}」` : `已启用「${p.name}」`)
            }
            return (
              <div key={p.id} className={`card pcard${cls}`} onClick={() => shell.gotoDetail(p.id)}>
                {!enabled ? (
                  <span className="corner">
                    <Badge kind="gray">已禁用</Badge>
                  </span>
                ) : null}
                <div className="name">
                  {p.name} <Dot color={dotc as 'green' | 'amber' | 'gray'} />
                </div>
                {/* No note means no line: an em dash here reads as a value that
                    failed to load rather than as an unused optional field. */}
                {p.note ? <div className="note">{p.note}</div> : null}
                <div className="url mono">{p.url}</div>
                <div className="meta">
                  {p.keys.avail ? <Badge kind="green">{p.keys.avail + ' 可用'}</Badge> : null}
                  {p.keys.cool ? <Badge kind="amber">{p.keys.cool + ' 冷却'}</Badge> : null}
                  {p.keys.dis ? <Badge kind="gray">{p.keys.dis + ' 禁用'}</Badge> : null}
                </div>
                <div className="sub">
                  {`${p.lastTest} · ${p.modelList.length} 个模型`}
                  {winCount(p) ? <> · <Badge kind="accent">{winCount(p) + ' 个限时模型'}</Badge></> : null}
                </div>
                {p.lastError ? (
                  <div className="sub" style={{ color: 'var(--state-bad)' }}>
                    ⚠ {p.lastError}
                  </div>
                ) : null}
                <div className="row pact" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="btn sm" style={{ padding: '4px 10px', fontSize: 12 }} onClick={toggle}>
                    {enabled ? '禁用' : '启用'}
                  </button>
                </div>
              </div>
            )
          })
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: 30 }}>
            <span className="muted small">没有匹配的提供商</span>
          </div>
        )}
      </div>
    </>
  )
}

/** 类型（预设）页 — draft cards; saving is owned by the tab row above. */
function TypesPage(props: {
  drafts: TypeDraft[]
  usageOf: (name: string) => { providers: number; keys: number }
  onChange: (i: number, next: TypeDraft) => void
  onRemove: (i: number) => void
  onAdd: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="xs muted">
          类型 = 全局预设（速率限制 / 并发 / 冷却）。修改会影响所有使用该类型的 key；key 未指定类型时，继承所属提供商的「默认类型」。
        </div>
      </div>
      <div className="tc-list">
        {props.drafts.map((d, i) => (
          <TypeCard
            key={i}
            draft={d}
            usage={props.usageOf(d.name)}
            locked={d.name === DEFAULT_PRESET_ID}
            onChange={(next) => props.onChange(i, next)}
            onRemove={d.name === DEFAULT_PRESET_ID ? undefined : () => props.onRemove(i)}
          />
        ))}
        <button type="button" className="skel" style={{ padding: 10, marginTop: 10 }} onClick={props.onAdd}>
          ＋ 添加类型
        </button>
      </div>
    </>
  )
}
