/**
 * Dialogs — the prototype's overlay set, ported one-for-one:
 * provider edit/create/delete, add key, model settings (capabilities +
 * time window), strategy
 * edit/delete/logs, session detail, error aggregation.
 *
 * Each dialog is a controlled form that ends in the shell's single write path
 * (`onSave` → save config → reload), so a rejected config shows the server's
 * message instead of leaving a half-applied edit on screen.
 */

import * as React from 'react'

import type { LlmConfigShape, LlmProviderShape, ModelWindow } from '../types'
import { Badge, ProtoSelect, Switch, fmt, fmtDur, hhmm2min } from './atoms'
import { DEFAULT_PRESET_ID } from '../types'
import type { ProtoLogRow, ProtoProvider, ProtoStrategy } from './viewmodel'
import { protoToIsoDay, isoToProtoDay } from './viewmodel'
import type { DialogState } from './state'
import { TypeCard, applyTypeDrafts, draftFromConfig, draftsKey, MANDATORY_DEFAULTS, type TypeDraft } from './TypeCard'
import {
  inWindow,
  windowSummary,
  providerIdFromName,
  providerNameTaken,
  pickedModels,
  strategyModels,
  strategyPicks,
  toStrategyModels,
  STRATEGY_TYPE_LABEL,
  modelOptionsDraft,
  applyModelOptionsDraft,
  presetOptionIds,
  presetUsage,
  resolvePresetId,
  type ModelOptionsDraft,
} from '../helpers'
import type { StrategyModelPick } from '../helpers'
import { parseKeyBlock } from './keyParser'

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']

interface Props {
  config: LlmConfigShape
  providers: ProtoProvider[]
  strategies: ProtoStrategy[]
  logs: ProtoLogRow[]
  dialog: DialogState
  onOpenDialog: (d: DialogState) => void
  onClose: () => void
  onSave: (next: LlmConfigShape) => Promise<boolean>
  onFilterLogs: (q: string, level?: string, tags?: Array<{ field: string; value: string }>) => void
  toast: (m: string) => void
}

/**
 * The overlay. Unlike the prototype, this used to close on a background
 * mousedown — and that fired while the user was selecting text inside an
 * input and the pointer happened to cross the scrim, discarding the whole
 * form. The prototype has no click-outside-to-close at all (only 取消 and ✕),
 * so closing is now explicit only.
 */
function Overlay(props: { children: React.ReactNode }): React.JSX.Element {
  return <div className="overlay">{props.children}</div>
}

function CloseX(props: { onClose: () => void }): React.JSX.Element {
  return (
    <button type="button" className="btn ghost sm" style={{ padding: '5px 10px' }} title="关闭" onClick={props.onClose}>
      ✕
    </button>
  )
}

/* ---------------------------------------------------------------- provider */

function ProviderEditDialog(props: {
  config: LlmConfigShape
  provider: ProtoProvider
  onSave: Props['onSave']
  onDelete: () => void
  onClose: () => void
  toast: Props['toast']
}): React.JSX.Element {
  const [name, setName] = React.useState(props.provider.name)
  const [note, setNote] = React.useState(props.provider.note)
  const [baseUrl, setBaseUrl] = React.useState(props.provider.url)
  const [protocol, setProtocol] = React.useState<'openai-completions' | 'anthropic-messages'>(
    props.provider.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
  )
  // No stored type — or one whose row was deleted — means the provider runs the
  // built-in default. Show that instead of an empty control, so the field
  // reflects what the gateway will actually use.
  const [defaultPreset, setDefaultPreset] = React.useState(
    resolvePresetId(props.config, props.provider.defaultType),
  )
  const [drafts, setDrafts] = React.useState<TypeDraft[]>(() => draftFromConfig(props.config))

  // Snapshot taken at open, after normalisation. `dirty` must mean "the user
  // changed something", not "opening the dialog filled in a default".
  const [initial] = React.useState(() => ({
    name,
    note,
    baseUrl,
    protocol,
    defaultPreset,
    drafts: draftsKey(drafts),
  }))
  const dirty =
    name !== initial.name ||
    note !== initial.note ||
    baseUrl !== initial.baseUrl ||
    protocol !== initial.protocol ||
    defaultPreset !== initial.defaultPreset ||
    draftsKey(drafts) !== initial.drafts

  // Same helper the 类型 page uses: counts a key under the type it resolves to.
  const usageOf = (n: string): { providers: number; keys: number } => presetUsage(n, props.config)

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      props.toast('名称不能为空')
      return
    }
    // The create dialog refuses duplicate names, so a rename must not sneak one
    // in — two identical names in the list are indistinguishable, and only one
    // of them keeps the id.
    if (providerNameTaken(props.config.providers, name, props.provider.id)) {
      props.toast(`名称「${name.trim()}」已存在`)
      return
    }
    if (!/^https?:\/\//.test(baseUrl.trim())) {
      props.toast('API 地址需以 http(s):// 开头')
      return
    }
    const withTypes = applyTypeDrafts(props.config, drafts)
    // A type renamed in this dialog remaps every reference inside
    // `applyTypeDrafts`, but `defaultPreset` here is a raw id captured when the
    // dialog opened. Follow the rename when the old id is gone, so saving does
    // not pin a type that no longer exists (which would silently run the
    // built-in default instead of the renamed one).
    const remappedDefault = withTypes.providers.find((p) => p.id === props.provider.id)?.defaultPreset
    const nextDefaultPreset =
      defaultPreset && withTypes.presets[defaultPreset] ? defaultPreset : remappedDefault || DEFAULT_PRESET_ID
    const next: LlmConfigShape = {
      ...withTypes,
      providers: withTypes.providers.map((p) =>
        p.id === props.provider.id
          ? { ...p, name: name.trim(), note: note.trim(), baseUrl: baseUrl.trim(), protocol, defaultPreset: nextDefaultPreset }
          : p,
      ),
    }
    const ok = await props.onSave(next)
    if (ok) {
      props.toast('已保存')
      props.onClose()
    }
  }
  return (
    <Overlay>
      <div className="dialog wide pe-dialog">
        <div className="spread" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>
            编辑提供商{' '}
            <span className="mono" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-muted)' }}>
              ({props.provider.name})
            </span>
          </h3>
          <button type="button" className="btn danger" onClick={props.onDelete}>
            删除
          </button>
        </div>
        <div className="body">
          <div className="field">
            <label>名称</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>备注</label>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="field">
            <label>API 地址</label>
            <input
              type="text"
              className="mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…/v1"
            />
          </div>
          <div className="field">
            <label>协议类型</label>
            <ProtoSelect
              value={protocol}
              options={[
                { value: 'openai-completions', label: 'OpenAI 兼容（/chat/completions）' },
                { value: 'anthropic-messages', label: 'Anthropic Messages（/messages）' },
              ]}
              onChange={(v) => setProtocol(v as 'openai-completions' | 'anthropic-messages')}
              placeholder="选择协议"
            />
            <div className="xs muted" style={{ marginTop: 3 }}>
              改协议会改变网关向上游发的请求格式，保存后建议点一次「测试」。
            </div>
          </div>
          <div className="field">
            <label>默认类型</label>
            <ProtoSelect
              value={defaultPreset}
              options={presetOptionIds(props.config).map((t) => ({ value: t, label: t }))}
              onChange={setDefaultPreset}
              placeholder="选择默认类型"
            />
          </div>
          <div className="xs muted">
            类型 = 全局预设（速率限制 / 并发 / 冷却）。此处的修改会影响所有使用该类型的 key；可在「提供商 → 类型（预设）」集中管理。
          </div>
          <div className="tc-list">
            {drafts.map((d, i) => (
              <TypeCard
                key={i}
                draft={d}
                locked={d.name === DEFAULT_PRESET_ID}
                usage={usageOf(d.name)}
                onChange={(nextDraft) => setDrafts((prev) => prev.map((x, j) => (j === i ? nextDraft : x)))}
                onRemove={() => setDrafts((prev) => prev.filter((_, j) => j !== i))}
              />
            ))}
            <button
              type="button"
              className="skel"
              style={{ padding: 10, marginTop: 10 }}
              onClick={() =>
                setDrafts((prev) => [
                  ...prev,
                  // A new card starts with only the fields the gateway cannot
                  // run without; the quota limits stay empty (= no limit).
                  { name: '', limits: { ...MANDATORY_DEFAULTS } },
                ])
              }
            >
              ＋ 添加类型
            </button>
          </div>
        </div>
        <div className="footer">
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!dirty}
            title={dirty ? undefined : '没有改动'}
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
      </div>
    </Overlay>
  )
}

function ProviderCreateDialog(props: {
  config: LlmConfigShape
  onSave: Props['onSave']
  onClose: () => void
  toast: Props['toast']
}): React.JSX.Element {
  const [name, setName] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('https://')
  const [protocol, setProtocol] = React.useState<'openai-completions' | 'anthropic-messages'>('openai-completions')
  const [note, setNote] = React.useState('')
  const [keysText, setKeysText] = React.useState('')
  // With no stored presets the built-in default is the only real choice, so
  // start there rather than on an empty value the picker cannot render.
  const [preset, setPreset] = React.useState(Object.keys(props.config.presets)[0] ?? DEFAULT_PRESET_ID)
  // `类型|apikey|备注`, one per line. Lines that do not split cleanly are
  // scanned for a key anyway, so a pasted "XXX-sk-r4xxxx" still lands.
  const parsedKeys = parseKeyBlock(keysText)

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      props.toast('请填写名称')
      return
    }
    // The name is the only identity the user manages, so it is what must be
    // unique. The id below is a derived slug they never see.
    if (providerNameTaken(props.config.providers, name)) {
      props.toast(`名称「${name.trim()}」已存在`)
      return
    }
    if (!/^https?:\/\//.test(baseUrl.trim())) {
      props.toast('API 地址需以 http(s):// 开头')
      return
    }
    const finalId = providerIdFromName(name, props.config.providers.map((p) => p.id))
    const stamp = Date.now().toString(36)
    const ok = await props.onSave({
      ...props.config,
      providers: [
        ...props.config.providers,
        {
          id: finalId,
          name: name.trim(),
          note: note.trim(),
          baseUrl: baseUrl.trim(),
          protocol,
          enabled: true,
          keys: parsedKeys.map((p, i) => ({
            id: `${stamp}${i}`,
            key: p.key,
            note: p.note,
            enabled: true,
            preset: p.preset,
          })),
          defaultPreset: preset,
          models: {},
        },
      ],
    })
    if (ok) {
      props.toast(parsedKeys.length ? `已创建，导入 ${parsedKeys.length} 个 key` : '已创建，接下来添加 key')
      props.onClose()
    }
  }

  return (
    <Overlay>
      <div className="dialog slim">
        <div className="spread" style={{ alignItems: 'flex-start', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>新建提供商</h3>
          <CloseX onClose={props.onClose} />
        </div>
        <div className="body">
          {/* One field: the name is the identity. The id used to be a second
              input whose only job was uniqueness, and the name-derived default
              already covered the common case. */}
          <div className="field">
            <label>名称（唯一）</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 某中转站" />
          </div>
          <div className="field">
            <label>API 地址</label>
            <input type="text" className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="field">
            <label>协议类型</label>
            <ProtoSelect
              value={protocol}
              options={[
                { value: 'openai-completions', label: 'OpenAI 兼容（/chat/completions）' },
                { value: 'anthropic-messages', label: 'Anthropic（/v1/messages）' },
              ]}
              onChange={(v) => setProtocol(v as 'openai-completions' | 'anthropic-messages')}
            />
          </div>
          <div className="field">
            <label>备注（可选）</label>
            {/* textarea 而非 input：备注可能写渠道说明、额度、到期时间，一行放不下。
                与 key 的备注编辑器同一套宽度规则（.field 统一 100% + resize:none）。 */}
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="渠道说明 / 额度 / 到期…" />
          </div>
          <div className="field">
            <label>Key（可选，每行一个：类型|密钥|备注）</label>
            <textarea
              className="mono"
              rows={4}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              value={keysText}
              onChange={(e) => setKeysText(e.target.value)}
              placeholder={'密钥…\npremium|密钥…|备用'}
            />
            <div className="xs muted" style={{ marginTop: 4 }}>
              单行直接输入即可；上游若不校验密钥，任意值（如 local）也可以
            </div>
            {parsedKeys.length ? (
              <div className="xs muted" style={{ marginTop: 4 }}>{`将导入 ${parsedKeys.length} 个 key`}</div>
            ) : null}
          </div>
          <div className="field">
            <label>默认类型</label>
            <ProtoSelect
              value={preset}
              options={presetOptionIds(props.config).map((t) => ({ value: t, label: t }))}
              onChange={setPreset}
              placeholder="选择默认类型"
            />
          </div>
        </div>
        <div className="footer">
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={() => void save()}>
            创建
          </button>
        </div>
      </div>
    </Overlay>
  )
}

function ProviderDeleteDialog(props: {
  config: LlmConfigShape
  provider: ProtoProvider
  strategies: ProtoStrategy[]
  onSave: Props['onSave']
  onClose: () => void
  toast: Props['toast']
}): React.JSX.Element {
  const used = props.strategies.filter((s) => s.members.includes(props.provider.id))
  const doDelete = async (): Promise<void> => {
    const next: LlmConfigShape = {
      ...props.config,
      providers: props.config.providers.filter((p) => p.id !== props.provider.id),
      strategies: props.config.strategies
        .map((s) => ({ ...s, members: s.members.filter((m) => m.provider !== props.provider.id) }))
        .filter((s) => s.members.length > 0),
    }
    const ok = await props.onSave(next)
    if (ok) {
      props.toast(`已删除「${props.provider.name}」`)
      props.onClose()
    }
  }
  return (
    <Overlay>
      <div className="dialog slim">
        <h3>{`删除提供商「${props.provider.name}」？`}</h3>
        <div className="body">
          <p className="small muted">
            {`删除后无法撤销。该提供商下的 ${props.provider.keyRows.length} 个 key 会一并移除。`}
          </p>
          {used.length ? (
            <div className="notice amber">
              {`策略组「${used.map((s) => s.name).join('、')}」引用了它；删除后会从这些策略组的成员里移除，成员清空的策略组也会被删掉。`}
            </div>
          ) : null}
        </div>
        <div className="footer">
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="btn danger" onClick={() => void doDelete()}>
            删除
          </button>
        </div>
      </div>
    </Overlay>
  )
}

function AddKeyDialog(props: {
  config: LlmConfigShape
  providerId: string
  onSave: Props['onSave']
  onClose: () => void
  toast: Props['toast']
}): React.JSX.Element {
  const [text, setText] = React.useState('')
  const [note, setNote] = React.useState('')
  // `类型|apikey|备注` per line; unparseable lines are scanned for a key.
  const parsed = parseKeyBlock(text).map((p) => ({ ...p, note: p.note || note.trim() }))

  const add = async (): Promise<void> => {
    if (!parsed.length) {
      props.toast('请粘贴至少一个 key')
      return
    }
    const stamp = Date.now().toString(36)
    const next = {
      ...props.config,
      providers: props.config.providers.map((p) =>
        p.id !== props.providerId
          ? p
          : {
              ...p,
              keys: [
                ...p.keys,
                ...parsed.map((pl, i) => ({
                  id: `${stamp}${i}`,
                  key: pl.key,
                  note: pl.note,
                  enabled: true,
                  preset: pl.preset,
                })),
              ],
            },
      ),
    }
    const ok = await props.onSave(next)
    if (ok) {
      props.toast(`已添加 ${parsed.length} 个 key`)
      props.onClose()
    }
  }

  return (
    <Overlay>
      <div className="dialog slim">
        <h3>添加 Key</h3>
        <div className="body">
          <div className="field">
            <label>Key（每行一个：类型|密钥|备注）</label>
            <textarea
              className="mono"
              rows={6}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={'密钥…\npremium|密钥…|备用'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {/* Not every upstream speaks `sk-`: a local relay may ignore the key
                entirely, and some vendors issue opaque tokens. Saying `sk-…`
                made users think a valid key had been rejected. */}
            <div className="xs muted" style={{ marginTop: 4 }}>
              单行直接输入即可；上游若不校验密钥，任意值（如 local）也可以
            </div>
          </div>
          <div className="field">
            <label>统一备注（可选，应用于无备注的行）</label>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="xs muted">{`将添加 ${parsed.length} 个 key`}</div>
        </div>
        <div className="footer">
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={() => void add()}>
            添加
          </button>
        </div>
      </div>
    </Overlay>
  )
}

/* ------------------------------------------------------------ key deletion */

/**
 * Deleting a key is irreversible and the row gives no undo, so it goes through
 * the same slim confirm the provider delete uses. The dialog shows *which* key
 * by value and note: a provider often has several rows whose values differ only
 * in their tail.
 */
function KeyDeleteDialog(props: {
  config: LlmConfigShape
  provider: ProtoProvider
  keyId: string
  onSave: Props['onSave']
  onClose: () => void
  toast: Props['toast']
}): React.JSX.Element | null {
  const row = props.provider.keyRows.find((k) => k.id === props.keyId)
  if (!row) return null
  const doDelete = async (): Promise<void> => {
    const next: LlmConfigShape = {
      ...props.config,
      providers: props.config.providers.map((p) =>
        p.id !== props.provider.id ? p : { ...p, keys: p.keys.filter((k) => k.id !== props.keyId) },
      ),
    }
    const ok = await props.onSave(next)
    if (ok) {
      props.toast('已删除 key')
      props.onClose()
    }
  }
  return (
    <Overlay>
      <div className="dialog slim">
        <h3>删除这个 key？</h3>
        <div className="body">
          <p className="small muted">删除后无法撤销，需要重新粘贴。</p>
          <div className="notice">
            <div className="mono small" style={{ wordBreak: 'break-all' }}>{row.key}</div>
            {row.note ? <div className="xs muted">{row.note}</div> : null}
          </div>
        </div>
        <div className="footer">
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="btn danger" onClick={() => void doDelete()}>
            删除
          </button>
        </div>
      </div>
    </Overlay>
  )
}

/* -------------------------------------------------------- model settings */

const TZ_OPTIONS = ['Asia/Shanghai', 'Asia/Tokyo', 'UTC', 'America/Los_Angeles', 'Europe/London']

function spanHint(sp: { start: string; end: string }): React.ReactNode {
  const s0 = hhmm2min(sp.start)
  const e0 = hhmm2min(sp.end)
  const mins = s0 <= e0 ? e0 - s0 : 1440 - s0 + e0
  const base = fmtDur(mins * 60000)
  return s0 > e0 ? <span className="night">{`跨午夜 · ${base}`}</span> : base
}

function ModelSettingsDialog(props: {
  config: LlmConfigShape
  provider: ProtoProvider
  model: string
  onSave: Props['onSave']
  onClose: () => void
  toast: Props['toast']
}): React.JSX.Element {
  const cur = props.provider.windows[props.model]
  const curOpts = props.provider.modelOptions[props.model]
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  const [tz, setTz] = React.useState(cur?.tz ?? localTz)
  const [from, setFrom] = React.useState((cur?.from ?? '').slice(0, 10))
  const [to, setTo] = React.useState((cur?.to ?? '').slice(0, 10))
  const [days, setDays] = React.useState<number[]>(cur?.days ?? [1, 2, 3, 4, 5, 6, 7])
  // Zero spans is the default: plenty of promotions are date-only ("free until
  // the 31st"), and seeding a 00:00–08:00 row meant every such window had to
  // delete a slot first. No spans reads as "all day" (see `inWindow`).
  const [spans, setSpans] = React.useState<Array<{ start: string; end: string }>>(
    cur?.spans?.length ? cur.spans.map((s) => ({ ...s })) : [],
  )
  // Capability block. Seeded from what is stored, so re-opening the dialog
  // after a save shows the saved numbers rather than the raw text typed.
  const [optDraft, setOptDraft] = React.useState<ModelOptionsDraft>(() => modelOptionsDraft(curOpts))
  const [optError, setOptError] = React.useState('')

  const draft: ModelWindow = {
    tz,
    ...(from ? { from: `${from} 00:00` } : {}),
    ...(to ? { to: `${to} 23:59` } : {}),
    ...(days.length && days.length < 7 ? { days } : {}),
    spans,
  }
  const activeNow = inWindow(new Date(), draft)
  const allDays = days.length === 7
  const protoDays = days.map(isoToProtoDay)

  const toggleDay = (protoIdx: number): void => {
    const iso = protoToIsoDay(protoIdx)
    setDays((prev) => (prev.includes(iso) ? prev.filter((d) => d !== iso) : [...prev, iso].sort((a, b) => a - b)))
  }

  /**
   * Write both halves of the dialog in one save.
   *
   * The two are independent records on the provider (`modelOptions` and
   * `timeWindows`), so a save that only carried one would silently revert the
   * other the next time the dialog opens. An empty capability block deletes
   * its key instead of storing `{}` — "nothing declared" and "declared
   * empty" must not diverge in the file.
   */
  const save = async (): Promise<void> => {
    const clean = spans.filter((s) => s.start && s.end)
    // A date-only window is a real configuration, so empty spans are allowed
    // as long as a bound exists. With no span and no date the window would
    // restrict nothing — refuse instead of writing a dead entry.
    if (!clean.length && !from && !to) {
      props.toast('请至少填写一个每日时段，或设置生效期')
      return
    }
    if (!days.length) {
      props.toast('未选任何周几，该窗口不会生效')
      return
    }
    const applied = applyModelOptionsDraft(optDraft)
    if (!applied.ok) {
      setOptError(applied.error)
      return
    }
    setOptError('')
    const cfg: ModelWindow = {
      tz,
      ...(clean.length ? { spans: clean } : {}),
      ...(from ? { from: `${from} 00:00` } : {}),
      ...(to ? { to: `${to} 23:59` } : {}),
      ...(days.length < 7 ? { days } : {}),
    }
    const ok = await props.onSave({
      ...props.config,
      providers: props.config.providers.map((p) => {
        if (p.id !== props.provider.id) return p
        const timeWindows = { ...(p.timeWindows ?? {}), [props.model]: cfg }
        const nextOptions = { ...(p.modelOptions ?? {}) }
        if (Object.keys(applied.options).length) nextOptions[props.model] = applied.options
        else delete nextOptions[props.model]
        const next: LlmProviderShape = { ...p, timeWindows, modelOptions: nextOptions }
        if (!Object.keys(nextOptions).length) delete next.modelOptions
        return next
      }),
    })
    if (ok) {
      props.toast('已保存模型设置')
      props.onClose()
    }
  }

  /**
   * Drop only the time window, leaving the capability block alone.
   *
   * Hidden when no window exists: the button used to be an always-on 删除 that
   * wrote the same config back and claimed 已取消限时启用, which read as a
   * bug on a model that never had one.
   */
  const removeWindow = async (): Promise<void> => {
    const ok = await props.onSave({
      ...props.config,
      providers: props.config.providers.map((p) => {
        if (p.id !== props.provider.id) return p
        const tw = { ...(p.timeWindows ?? {}) }
        delete tw[props.model]
        return { ...p, timeWindows: tw }
      }),
    })
    if (ok) {
      props.toast('已取消限时启用')
      props.onClose()
    }
  }

  return (
    <Overlay>
      <div className="dialog win-dialog">
        <div className="win-head">
          <div className="spread" style={{ alignItems: 'center' }}>
            <div className="row" style={{ alignItems: 'center', minWidth: 0 }}>
              <span className="win-ico">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3.5 2" />
                </svg>
              </span>
              <div style={{ minWidth: 0 }}>
                <h3 style={{ margin: 0 }}>
                  模型设置{' '}
                  <span className="mono" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-muted)' }}>
                    ({props.model})
                  </span>
                </h3>
                <div className="win-sub faint" style={{ marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {`${props.provider.name} · 上下文 / 最大输出 / 能力 / 限时启用`}
                </div>
              </div>
            </div>
            <div className="row" style={{ gap: 6, flexShrink: 0 }}>
              <CloseX onClose={props.onClose} />
            </div>
          </div>
        </div>

        <div className="win-body">
          <div className="wsec">
            <div className="wsec-h">
              <span>模型能力</span>
              <span className="xs faint" style={{ fontWeight: 400, letterSpacing: 0 }}>
                留空 = 未声明
              </span>
            </div>
            <div className="wrow">
              <label className="wlab">上下文</label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="512K"
                value={optDraft.contextWindow}
                onChange={(e) => {
                  setOptDraft((d) => ({ ...d, contextWindow: e.target.value }))
                  setOptError('')
                }}
              />
              <span className="xs faint" style={{ whiteSpace: 'nowrap' }}>
                tokens · 可填 1.5M、32k 或 1000000
              </span>
            </div>
            <div className="wrow">
              <label className="wlab">最大输出</label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="未声明"
                value={optDraft.maxOutputTokens}
                onChange={(e) => {
                  setOptDraft((d) => ({ ...d, maxOutputTokens: e.target.value }))
                  setOptError('')
                }}
              />
              <span className="xs faint" style={{ whiteSpace: 'nowrap' }}>
                tokens · 可填 64k、65,536 或 65536
              </span>
            </div>
            <div className="wrow">
              <label className="wlab">能力</label>
              <div className="row" style={{ flex: 1, gap: 24 }}>
                <span className="row" style={{ gap: 8 }}>
                  <span className="small">图片</span>
                  <Switch on={optDraft.supportsImages} onClick={() => setOptDraft((d) => ({ ...d, supportsImages: !d.supportsImages }))} />
                </span>
                <span className="row" style={{ gap: 8 }}>
                  <span className="small">推理</span>
                  <Switch on={optDraft.supportsThinking} onClick={() => setOptDraft((d) => ({ ...d, supportsThinking: !d.supportsThinking }))} />
                </span>
              </div>
            </div>
            {optError ? (
              <div className="xs warn-text" style={{ marginTop: 2 }}>
                {optError}
              </div>
            ) : null}
          </div>

          <div className="wsec">
            <div className="wsec-h">限时启用</div>
            <div className="wrow">
              <label className="wlab">时区</label>
              <select value={tz} onChange={(e) => setTz(e.target.value)}>
                {Array.from(new Set([...TZ_OPTIONS, tz, localTz])).map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {t === localTz ? ' · 本机' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="wrow">
              <label className="wlab">生效期</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="xs faint">→</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              <span className="xs faint" style={{ whiteSpace: 'nowrap' }}>
                留空 = 不限
              </span>
            </div>
            <div className="wrow" style={{ alignItems: 'flex-start', padding: '6px 0' }}>
              <label className="wlab" style={{ height: 30, display: 'flex', alignItems: 'center' }}>
                周几
              </label>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 4 }}>
                  {WEEK_CN.map((c, k) => (
                    <button
                      key={c}
                      type="button"
                      className={`wday ${protoDays.includes(k) ? 'on' : ''}`}
                      onClick={() => toggleDay(k)}
                    >
                      {c}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="btn ghost sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => setDays(allDays ? [] : [1, 2, 3, 4, 5, 6, 7])}
                  >
                    {allDays ? '清空' : '全选'}
                  </button>
                </div>
                <div className={`xs ${days.length ? 'faint' : 'warn-text'}`} style={{ marginTop: 6 }}>
                  {allDays
                    ? '每天'
                    : days.length
                      ? `仅 周${days.map((d) => WEEK_CN[isoToProtoDay(d)]).join('、')}`
                      : '未选任何周几 → 不会生效'}
                </div>
              </div>
            </div>
          </div>

          <div className="wsec">
            <div className="wsec-h">
              <span>每日时段</span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setSpans((prev) => [...prev, { start: '09:00', end: '18:00' }])}
              >
                ＋ 添加时段
              </button>
            </div>
            <div>
              {spans.length === 0 ? (
                <div className="xs faint" style={{ padding: '2px 0 4px' }}>
                  不限时段 —— 生效期内全天可用
                </div>
              ) : null}
              {spans.map((sp, i) => (
                <div key={i} className="spanrow">
                  <span className="idx">{i + 1}</span>
                  <input
                    type="time"
                    value={sp.start}
                    onChange={(e) => setSpans((prev) => prev.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
                  />
                  <span className="xs faint">至</span>
                  <input
                    type="time"
                    value={sp.end}
                    onChange={(e) => setSpans((prev) => prev.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
                  />
                  <span className="dur">{spanHint(sp)}</span>
                  <button
                    type="button"
                    className="btn ghost sm del"
                    title="删除该时段"
                    onClick={() => setSpans((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="xs faint" style={{ marginTop: 8 }}>
              多个时段之间为「或」；结束早于开始表示跨午夜
            </div>
          </div>

          <div className="wpreview">
            <span className="xs faint" style={{ whiteSpace: 'nowrap' }}>
              生效预览
            </span>
            <span className="mono" style={{ fontSize: 'var(--text-sm)' }}>
              {windowSummary(draft)}
            </span>
            <span className={`badge ${activeNow ? 'green' : 'gray'}`} style={{ marginLeft: 'auto' }}>
              {activeNow ? '此刻可用' : '此刻不可用'}
            </span>
          </div>
        </div>

        <div className="win-foot">
          {cur ? (
            <button type="button" className="btn danger" style={{ marginLeft: 'auto' }} onClick={() => void removeWindow()}>
              取消限时
            </button>
          ) : null}
          <button type="button" className="btn primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </Overlay>
  )
}

/* --------------------------------------------------------------- strategy */

function StrategyEditDialog(props: {
  config: LlmConfigShape
  providers: ProtoProvider[]
  strategies: ProtoStrategy[]
  strategyId: string | null
  onSave: Props['onSave']
  onDelete: () => void
  onClose: () => void
  toast: Props['toast']
}): React.JSX.Element {
  const existing = props.config.strategies.find((s) => s.id === props.strategyId)
  const view = props.strategyId ? props.strategies.find((s) => s.id === props.strategyId) : null
  const [name, setName] = React.useState(view?.name ?? '')
  const [type, setType] = React.useState<string>(existing?.type ?? 'round_robin')
  const [members, setMembers] = React.useState<string[]>(existing?.members.map((m) => m.provider) ?? [])
  // One entry per (provider, model). Two providers serving the same name are two
  // units, not one: turning one off must not drop the other, and a pick has to
  // say which upstream it routes to.
  const [picked, setPicked] = React.useState<StrategyModelPick[]>(() =>
    strategyPicks(
      Object.keys(existing?.modelAliases ?? {}),
      existing?.modelProviders,
      existing?.members.map((m) => m.provider) ?? [],
      props.providers,
    ),
  )
  const [weights, setWeights] = React.useState<Record<string, number>>(view?.weights ?? {})
  const [sticky, setSticky] = React.useState(existing?.stickySession?.enabled !== false)
  const [compactAfterSwitch, setCompactAfterSwitch] = React.useState(existing?.compactAfterSwitch !== false)
  const [maxAttempts, setMaxAttempts] = React.useState(existing?.retry?.maxAttempts ?? 3)
  const [backoffMs, setBackoffMs] = React.useState(existing?.retry?.backoffMs ?? 500)
  const [fallbackId, setFallbackId] = React.useState(existing?.fallbackStrategyId ?? '')

  // Only the selected members' models — see `strategyModels`.
  const pool = strategyModels(props.providers, members)
  // Picks of a provider that is no longer a member cannot route; saving drops
  // them rather than writing an unreachable model.
  const effective = picked.filter((p) => members.includes(p.provider))
  const models = pickedModels(effective)
  const isPicked = (provider: string, model: string): boolean =>
    picked.some((p) => p.provider === provider && p.model === model)
  const now = new Date()
  const canSave = Boolean(name.trim()) && members.length > 0 && models.length > 0

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      props.toast('请填写策略组名称')
      return
    }
    if (!members.length) {
      props.toast('请至少选择 1 个成员提供商')
      return
    }
    if (!models.length) {
      props.toast('请至少选择 1 个模型')
      return
    }
    // The name is the user's; the id is a derived slug. A Chinese name
    // normalises to `provider`, so the slug is deduped instead of rejected —
    // 「策略组「provider」已存在」 names an id the user never typed.
    const id = existing?.id ?? providerIdFromName(name, props.config.strategies.map((s) => s.id))
    const { models: savedModels, modelProviders } = toStrategyModels(effective)
    const aliases: Record<string, string> = {}
    savedModels.forEach((m) => {
      aliases[m] = existing?.modelAliases?.[m] ?? m
    })
    const entry = {
      ...(existing ?? { id }),
      id,
      name: name.trim(),
      type: type as LlmConfigShape['strategies'][number]['type'],
      members: members.map((p) => ({ provider: p, ...(type === 'weighted' ? { weight: weights[p] || 1 } : {}) })),
      stickySession: { ...(existing?.stickySession ?? {}), enabled: sticky },
      compactAfterSwitch,
      retry: { ...(existing?.retry ?? {}), maxAttempts: Number(maxAttempts) || 3, backoffMs: Number(backoffMs) || 500 },
      ...(fallbackId ? { fallbackStrategyId: fallbackId } : {}),
      modelAliases: aliases,
      modelProviders,
    }
    const strategies = existing
      ? props.config.strategies.map((s) => (s.id === existing.id ? entry : s))
      : [...props.config.strategies, entry]
    const ok = await props.onSave({ ...props.config, strategies })
    if (ok) {
      props.toast('已保存')
      props.onClose()
    }
  }

  return (
    <Overlay>
      <div className="dialog">
        <div className="spread" style={{ alignItems: 'flex-start', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>
            {existing ? '编辑策略组' : '新建策略组'}
            {existing ? (
              <span className="mono" style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-muted)' }}>
                {' '}
                ({existing.id})
              </span>
            ) : null}
          </h3>
          <CloseX onClose={props.onClose} />
        </div>
        <div className="body">
          <div className="field">
            <label>名称</label>
            <input type="text" value={name} placeholder="例如 日常主用" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>调度方式</label>
            <div className="seg">
              {Object.keys(STRATEGY_TYPE_LABEL).map((t) => (
                <button key={t} type="button" className={type === t ? 'on' : ''} onClick={() => setType(t)}>
                  {STRATEGY_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>成员提供商（点击切换）</label>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {props.providers.map((p) => {
                const on = members.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`pill ${on ? 'click' : ''}`}
                    style={on ? { borderColor: 'var(--color-accent)', color: 'var(--color-accent)' } : undefined}
                    onClick={() =>
                      setMembers((prev) => (prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id]))
                    }
                  >
                    {p.name}
                  </button>
                )
              })}
            </div>
          </div>
          {type === 'weighted' ? (
            <div className="field">
              <label>成员权重（加权调度）</label>
              <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
                {members.length ? (
                  members.map((id) => {
                    const p = props.providers.find((x) => x.id === id)
                    return (
                      <label key={id} className="row small" style={{ gap: 6 }}>
                        {p?.name ?? id}
                        <input
                          type="number"
                          min={1}
                          step={1}
                          style={{ width: 64 }}
                          value={weights[id] ?? 1}
                          onChange={(e) => setWeights((w) => ({ ...w, [id]: Number(e.target.value) || 1 }))}
                        />
                      </label>
                    )
                  })
                ) : (
                  <span className="xs muted">请先选择成员提供商</span>
                )}
              </div>
              <div className="xs muted" style={{ marginTop: 4 }}>
                权重越高，被选中的概率越大（按成员顺序展示）
              </div>
            </div>
          ) : null}
          <div className="field">
            <label>模型</label>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {pool.length ? (
                pool.map((e) => {
                  const on = isPicked(e.providerId, e.model)
                  return (
                    <button
                      key={`${e.providerId}\u0000${e.model}`}
                      type="button"
                      className={`pill ${on ? 'click' : ''}`}
                      style={on ? { borderColor: 'var(--color-accent)', color: 'var(--color-accent)' } : undefined}
                      onClick={() =>
                        setPicked((prev) =>
                          prev.some((p) => p.provider === e.providerId && p.model === e.model)
                            ? prev.filter((p) => !(p.provider === e.providerId && p.model === e.model))
                            : [...prev, { provider: e.providerId, model: e.model }],
                        )
                      }
                    >
                      {e.model}
                      <span className="muted" style={{ marginLeft: 5 }}>{`· ${e.providerName}`}</span>
                    </button>
                  )
                })
              ) : (
                <span className="xs muted">
                  {members.length ? '选中的提供商还没有启用模型' : '请先选择成员提供商'}
                </span>
              )}
            </div>
          </div>
          <div className="field">
            <label>路由预览</label>
            <div className="card" style={{ padding: '8px 10px', background: 'var(--color-surface-muted)' }}>
              {models.length ? (
                models.map((m) => {
                  // Only the providers this model was picked for — a model pinned
                  // to one provider must not report the other as a route.
                  const allowed = effective.filter((p) => p.model === m).map((p) => p.provider)
                  const mems = members
                    .filter((id) => allowed.includes(id))
                    .map((id) => props.providers.find((p) => p.id === id))
                    .filter((p): p is ProtoProvider => Boolean(p && p.modelList.includes(m)))
                  const avail = mems.filter((p) => inWindow(now, p.windows[m]))
                  const blocked = mems.filter((p) => !inWindow(now, p.windows[m]))
                  let tail: React.ReactNode
                  if (avail.length) tail = `→ ${avail.map((p) => p.name).join('、')}`
                  else if (blocked.length) {
                    const wc = blocked[0].windows[m]
                    tail = `⚠ 该模型仅 ${windowSummary(wc)} 可用`
                  } else tail = '⚠ 无成员支持该模型'
                  return (
                    <div key={m} className="spread xs" style={{ padding: '2px 0' }}>
                      <span className="mono">{m}</span>
                      <span className="row" style={{ alignItems: 'center', gap: 6 }}>
                        <span style={{ color: avail.length ? 'var(--color-text-muted)' : 'var(--state-bad)' }}>{tail}</span>
                        {/* A model kept from an earlier save (its provider stopped
                            advertising it, or was un-picked) no longer appears in
                            the pool, so this is the only place left to drop it. */}
                        {mems.length ? null : (
                          <button
                            type="button"
                            className="btn ghost sm"
                            style={{ padding: '0 5px', fontSize: 11, lineHeight: '16px' }}
                            title="从策略组移除该模型"
                            onClick={() => setPicked((prev) => prev.filter((x) => x.model !== m))}
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })
              ) : (
                <span className="xs muted">选择模型后显示它会路由到哪些成员提供商</span>
              )}
            </div>
          </div>
          <div className="field">
            <label>单 Key 尝试次数</label>
            <ProtoSelect
              value={String(maxAttempts)}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} 次` }))}
              onChange={(v) => setMaxAttempts(Number(v))}
            />
            <div className="xs muted" style={{ marginTop: 4 }}>
              同一个 key 最多尝试几次（1 = 不重试）。key 失败后自动换同提供商的其它 key，再换其它提供商
            </div>
          </div>
          <div className="field">
            <label>瞬时重试退避 · 毫秒</label>
            <input type="number" min={0} step={50} value={backoffMs} onChange={(e) => setBackoffMs(Number(e.target.value))} />
            <div className="xs muted" style={{ marginTop: 4 }}>同一 key 遇到瞬时错误（5xx / 网络）重试的间隔</div>
          </div>
          <div className="field">
            <label>粘性会话</label>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">同一会话固定使用同一 key</span>
              <Switch on={sticky} onClick={() => setSticky((s) => !s)} />
            </div>
            {sticky ? (
              <div className="xs muted" style={{ marginTop: 4 }}>
                钉住的 key 所在提供商离开启用窗口时，粘性失效并回退正常调度（否则该会话在窗口外会全挂）
              </div>
            ) : null}
          </div>
          <div className="field">
            <label>切换 key/模型后压缩会话</label>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">切换后复用自动压缩，避免新 key/模型无缓存时全量计费</span>
              <Switch on={compactAfterSwitch} onClick={() => setCompactAfterSwitch((v) => !v)} />
            </div>
            <div className="xs muted" style={{ marginTop: 4 }}>
              默认开启：先做零 LLM 快速压缩，超过阈值才调用 LLM 总结；仅在会话空闲后执行，不打断当前回合
            </div>
          </div>
          <div className="field">
            <label>全部失败后转移至</label>
            <ProtoSelect
              value={fallbackId}
              options={[
                { value: '', label: '不转移（失败即终止）' },
                ...props.strategies
                  .filter((s) => s.id !== existing?.id)
                  .map((s) => ({ value: s.id, label: s.name ?? s.id })),
              ]}
              onChange={(v) => setFallbackId(v)}
            />
            <div className="xs muted" style={{ marginTop: 4 }}>
              本策略组所有提供商都不可用时转移到该策略组；循环引用会在运行时判定为失败
            </div>
          </div>
        </div>
        <div className="footer">
          {existing ? (
            <button type="button" className="btn danger" style={{ marginLeft: 'auto' }} onClick={props.onDelete}>
              删除
            </button>
          ) : null}
          <button type="button" className="btn primary" disabled={!canSave} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </Overlay>
  )
}

function StrategyDeleteDialog(props: {
  config: LlmConfigShape
  strategy: ProtoStrategy
  onSave: Props['onSave']
  onClose: () => void
  toast: Props['toast']
}): React.JSX.Element {
  const granted = props.config.clientKeys.filter((k) => k.strategies.includes(props.strategy.id))
  const doDelete = async (): Promise<void> => {
    // clientKeys / miniStrategy references are repaired by the save path
    // (`reconcileStrategyRefs`), which also re-attaches a key that would
    // otherwise be left with nothing to route through.
    const ok = await props.onSave({
      ...props.config,
      strategies: props.config.strategies.filter((s) => s.id !== props.strategy.id),
      // A stale default would seed new sessions with a group that no longer
      // exists; reconcileStrategyRefs clears it too, but dropping it here keeps
      // the saved config honest about what the user chose.
      defaultStrategy:
        props.config.defaultStrategy === props.strategy.id ? undefined : props.config.defaultStrategy,
    })
    if (ok) {
      // A stale default would seed new sessions with a strategy that no longer
      // exists, so clear it along with the strategy.
      try {
        if (localStorage.getItem('llm-proto.default-strategy') === props.strategy.id) {
          localStorage.removeItem('llm-proto.default-strategy')
        }
      } catch {
        // Preference cleanup is best-effort.
      }
      props.toast(`已删除「${props.strategy.name}」`)
      props.onClose()
    }
  }
  return (
    <Overlay>
      <div className="dialog slim">
        <h3>{`删除策略组「${props.strategy.name}」？`}</h3>
        <div className="body">
          <p className="small muted">
            {`删除后无法撤销。${props.strategy.name} 包含 ${props.strategy.members.length} 个成员提供商。`}
          </p>
          {granted.length ? (
            <div className="notice amber">
              {`有 ${granted.length} 个客户端 key 授权了该策略组，删除后它们将改用其余策略组中排在最前的一个；没有其他策略组时无法路由。`}
            </div>
          ) : null}
        </div>
        <div className="footer">
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="btn danger" onClick={() => void doDelete()}>
            删除
          </button>
        </div>
      </div>
    </Overlay>
  )
}

function SessionDialog(props: {
  sessionId: string
  providers: ProtoProvider[]
  logs: ProtoLogRow[]
  onClose: () => void
  onFilterLogs: (q: string, level?: string, tags?: Array<{ field: string; value: string }>) => void
}): React.JSX.Element {
  const rows = props.logs.filter((l) => l.session === props.sessionId).sort((a, b) => b.tsMs - a.tsMs)
  const okN = rows.filter((l) => l.status === 'success').length
  const retryN = rows.filter((l) => l.status === 'retried').length
  const failN = rows.filter((l) => l.status === 'failed').length
  const sumP = rows.reduce((a, l) => a + l.p, 0)
  const sumC = rows.reduce((a, l) => a + l.c, 0)
  const avg = rows.length ? Math.round(rows.reduce((a, l) => a + l.dur, 0) / rows.length) : 0
  const models = Array.from(new Set(rows.map((l) => l.model)))
  const isMemory = rows.length > 0 && rows[0].scope === 'memory'

  return (
    <Overlay>
      <div className="dialog xwide">
        <div className="spread" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
          <div>
            <h3 style={{ margin: 0 }}>{`${isMemory ? '记忆整理任务' : '会话'} · ${props.sessionId}`}</h3>
            <div className="xs muted" style={{ marginTop: 4 }}>
              {rows.length ? `${rows.length} 次请求 · ${rows[rows.length - 1].ts} → ${rows[0].ts}` : '该会话没有日志'}
            </div>
          </div>
          <button type="button" className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Badge kind="green">{`成功 ${okN}`}</Badge>
          <Badge kind="amber">{`重试 ${retryN}`}</Badge>
          <Badge kind="red">{`失败 ${failN}`}</Badge>
          <Badge kind="gray">{`平均耗时 ${(avg / 1000).toFixed(1)}s`}</Badge>
          <Badge kind="accent">{`Token ${fmt(sumP)} / ${fmt(sumC)}`}</Badge>
        </div>
        <div className="xs muted" style={{ marginTop: 8 }}>{`模型：${models.join('、') || '—'}`}</div>
        <div style={{ overflowX: 'auto', marginTop: 10, borderTop: '1px solid var(--color-border)', flex: '1 1 auto', minHeight: 0 }}>
          <table className="tbl logtbl" style={{ minWidth: 760 }}>
            <tbody>
              <tr>
                <th>时间</th>
                <th>提供商</th>
                <th>Key</th>
                <th>模型</th>
                <th>状态码</th>
                <th>状态</th>
                <th>Token</th>
                <th>耗时</th>
              </tr>
              {rows.map((l) => {
                const st =
                  l.status === 'success' ? (
                    <Badge kind="green">成功</Badge>
                  ) : l.status === 'retried' ? (
                    <Badge kind="amber">重试</Badge>
                  ) : (
                    <Badge kind="red">失败</Badge>
                  )
                return (
                  <tr key={l.id}>
                    <td className="mono xs">{l.ts}</td>
                    <td>{props.providers.find((p) => p.id === l.provider)?.name ?? l.provider}</td>
                    <td className="mono xs">{l.key}</td>
                    <td>{l.model}</td>
                    <td className="mono xs">{String(l.code)}</td>
                    <td>{st}</td>
                    <td className="num xs">
                      {fmt(l.p)}
                      <span className="faint"> / </span>
                      {fmt(l.c)}
                    </td>
                    <td className="num xs">{(l.dur / 1000).toFixed(1)}s</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="footer">
          <button
            type="button"
            className="btn"
            onClick={() => {
              props.onFilterLogs(props.sessionId)
              props.onClose()
            }}
          >
            在日志页筛选该会话
          </button>
          <button type="button" className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </Overlay>
  )
}

function ErrorAggDialog(props: {
  logs: ProtoLogRow[]
  onClose: () => void
  onFilterLogs: (q: string, level?: string, tags?: Array<{ field: string; value: string }>) => void
}): React.JSX.Element {
  const bad = props.logs.filter((l) => l.status !== 'success')
  const groups = new Map<string, { code: string | number; model: string; msg: string; count: number; last: number; local: boolean }>()
  bad.forEach((l) => {
    const raw = l.error || '（无错误详情）'
    const norm = raw
      .toLowerCase()
      .replace(/\d+/g, '#')
      .replace(/[a-f0-9]{8,}/g, '#')
      .slice(0, 180)
    const k = `${l.code}|${l.model}|${norm}`
    const g = groups.get(k) ?? { code: l.code, model: l.model, msg: raw, count: 0, last: 0, local: l.local === true }
    g.count++
    if (l.tsMs >= g.last) g.msg = raw
    g.last = Math.max(g.last, l.tsMs)
    groups.set(k, g)
  })
  const list = Array.from(groups.values()).sort((a, b) => b.count - a.count)

  return (
    <Overlay>
      <div className="dialog slim">
        <div className="spread" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>错误聚合</h3>
          <button type="button" className="btn" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div className="xs muted">{`按「状态码 + 模型 + 归一化错误」分组（共 ${bad.length} 条失败/重试）`}</div>
        <table className="tbl" style={{ marginTop: 10 }}>
          <tbody>
            <tr>
              <th style={{ whiteSpace: 'nowrap' }}>状态码</th>
              <th style={{ whiteSpace: 'nowrap' }}>模型</th>
              <th>错误信息</th>
              <th style={{ whiteSpace: 'nowrap' }}>次数</th>
              <th style={{ whiteSpace: 'nowrap' }}>最近发生</th>
              <th />
            </tr>
            {list.length ? (
              list.map((g) => {
                const d = new Date(g.last)
                const pad = (x: number): string => String(x).padStart(2, '0')
                return (
                  <tr key={`${g.code}-${g.model}-${g.msg.slice(0, 8)}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {g.local ? (
                        // No upstream status exists; showing the gateway's own
                        // 503 would send the user to debug the provider.
                        <Badge kind="gray" title="本地拒绝：未向上游发出请求">本地</Badge>
                      ) : (
                        <Badge kind={Number(g.code) === 429 ? 'amber' : 'red'}>{String(g.code)}</Badge>
                      )}
                    </td>
                    <td className="mono xs" style={{ whiteSpace: 'nowrap' }}>{g.model}</td>
                    <td className="xs" style={{ maxWidth: 170, color: 'var(--color-text-muted)' }} title={g.msg}>
                      {g.msg.length > 26 ? `${g.msg.slice(0, 26)}…` : g.msg}
                    </td>
                    <td className="num xs">{g.count}</td>
                    <td className="xs muted" style={{ whiteSpace: 'nowrap' }}>{`${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`}</td>
                    <td>
                      <button
                        type="button"
                        className="btn sm"
                        style={{ padding: '2px 8px', fontSize: 12, whiteSpace: 'nowrap' }}
                        onClick={() => {
                          // This group is made of failures, so the log must open
                          // on failures. It used to ask for "重试" when the code
                          // was 429 — "重试" means a *successful* request that
                          // needed another attempt, so clicking a failure group
                          // landed on successful rows. The code tag keeps the
                          // result narrowed to this group instead.
                          const code = Number(g.code)
                          props.onFilterLogs(
                            g.model,
                            'failed',
                            Number.isFinite(code) && code > 0 ? [{ field: 'code', value: String(code) }] : undefined,
                          )
                          props.onClose()
                        }}
                      >
                        只看此类
                      </button>
                    </td>
                  </tr>
                )
              })
            ) : (
              <tr>
                <td colSpan={5} className="muted" style={{ padding: 16, textAlign: 'center' }}>
                  没有失败或重试请求
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Overlay>
  )
}

/* ------------------------------------------------------------------ switch */

export function ProtoDialog(props: Props): React.JSX.Element | null {
  const d = props.dialog
  const providerOf = (id: string): ProtoProvider | undefined => props.providers.find((p) => p.id === id)

  if (d.kind === 'provider-edit') {
    const p = providerOf(d.providerId)
    if (!p) return null
    return (
      <ProviderEditDialog
        config={props.config}
        provider={p}
        onSave={props.onSave}
        onClose={props.onClose}
        toast={props.toast}
        onDelete={() => props.onOpenDialog({ kind: 'provider-delete', providerId: d.providerId })}
      />
    )
  }
  if (d.kind === 'provider-create') {
    return <ProviderCreateDialog config={props.config} onSave={props.onSave} onClose={props.onClose} toast={props.toast} />
  }
  if (d.kind === 'provider-delete') {
    const p = providerOf(d.providerId)
    if (!p) return null
    return (
      <ProviderDeleteDialog
        config={props.config}
        provider={p}
        strategies={props.strategies}
        onSave={props.onSave}
        onClose={props.onClose}
        toast={props.toast}
      />
    )
  }
  if (d.kind === 'add-key') {
    return (
      <AddKeyDialog
        config={props.config}
        providerId={d.providerId}
        onSave={props.onSave}
        onClose={props.onClose}
        toast={props.toast}
      />
    )
  }
  if (d.kind === 'key-delete') {
    const p = providerOf(d.providerId)
    if (!p) return null
    return (
      <KeyDeleteDialog
        config={props.config}
        provider={p}
        keyId={d.keyId}
        onSave={props.onSave}
        onClose={props.onClose}
        toast={props.toast}
      />
    )
  }
  if (d.kind === 'model-settings') {
    const p = providerOf(d.providerId)
    if (!p) return null
    return (
      <ModelSettingsDialog
        config={props.config}
        provider={p}
        model={d.model}
        onSave={props.onSave}
        onClose={props.onClose}
        toast={props.toast}
      />
    )
  }
  if (d.kind === 'strategy-edit') {
    return (
      <StrategyEditDialog
        config={props.config}
        providers={props.providers}
        strategies={props.strategies}
        strategyId={d.strategyId}
        onSave={props.onSave}
        onClose={props.onClose}
        toast={props.toast}
        onDelete={() => d.strategyId && props.onOpenDialog({ kind: 'strategy-delete', strategyId: d.strategyId })}
      />
    )
  }
  if (d.kind === 'strategy-delete') {
    const s = props.strategies.find((x) => x.id === d.strategyId)
    if (!s) return null
    return (
      <StrategyDeleteDialog
        config={props.config}
        strategy={s}
        onSave={props.onSave}
        onClose={props.onClose}
        toast={props.toast}
      />
    )
  }
  if (d.kind === 'session') {
    return (
      <SessionDialog
        sessionId={d.sessionId}
        providers={props.providers}
        logs={props.logs}
        onClose={props.onClose}
        onFilterLogs={props.onFilterLogs}
      />
    )
  }
  if (d.kind === 'error-agg') {
    return <ErrorAggDialog logs={props.logs} onClose={props.onClose} onFilterLogs={props.onFilterLogs} />
  }
  return null
}
