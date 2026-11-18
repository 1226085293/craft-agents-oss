/**
 * 通道闸门设置（v6/v7 切片 C）— one channel's gate config, rendered under its
 * pairing row on the plugin's detail page.
 *
 * 阶段 1 范围（钉死，别做全）：
 * - 助手下拉（带分工说明预览）/ 标签多选（词表 + 新建）/ 执行模式单选（群无「询问」）
 * - 「启用标签闸」开关 + 红警（启用且 0 标签 = 故意全禁，H1 语义）
 * - 接收模式：置灰「只收@（默认）」—— 全收/触发提示词随判定器在阶段 6 上
 * - 源可见性预览（标签交集）+「模式裁剪阶段 6 生效」占位 —— 不显示假全量
 * - 老记录无 pairedBy →「写保护未开启」角标 + 认领按钮（修 2：启用写保护，不是解锁）
 *
 * 自动保存：改动 600ms 静默后 channelGate RPC 落盘（pairings v2 记录字段）。
 * i18n：沿用本仓库面板惯例 —— 全部 t(key, { defaultValue })，新键注册进 7 语言
 * locale 文件是后续 i18n 任务（defaultValue 已是中文，中文用户直显）。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'

export interface ChannelGateRow {
  channelKey: string
  pairedAt: number
  pairedBy?: string
  channelKind?: 'private' | 'group' | 'channel'
  agentId?: string
  gateEnabled?: boolean
  allowedLabels?: string[]
  permissionMode?: 'safe' | 'ask' | 'allow-all'
  ingestMode?: 'at_only' | 'all'
  triggerPrompt?: string
  recordOnly?: boolean
  memoryFeed?: boolean
}

export interface ChannelGateAgent {
  id: string
  name: string
  icon?: string
  dispatchHint?: string
  assignable?: boolean
}

interface ChannelGatePreview {
  gateEnabled: boolean
  visibleSlugs: string[]
  allSlugs: string[]
  pairedBy: string | null
}

export interface ChannelGatePanelProps {
  workspaceId: string
  row: ChannelGateRow
  agents: ChannelGateAgent[]
  labelVocabulary: string[]
  onSaved: () => void
  onVocabularyChange: () => void
}

const AUTO_SAVE_MS = 600

export function ChannelGatePanel({
  workspaceId,
  row,
  agents,
  labelVocabulary,
  onSaved,
  onVocabularyChange,
}: ChannelGatePanelProps): React.ReactElement {
  const { t } = useTranslation()

  const [agentId, setAgentId] = React.useState<string>(row.agentId ?? '')
  const [gateEnabled, setGateEnabled] = React.useState(row.gateEnabled === true)
  const [allowedLabels, setAllowedLabels] = React.useState<string[]>(row.allowedLabels ?? [])
  const [mode, setMode] = React.useState<'__default' | 'safe' | 'ask' | 'allow-all'>(
    row.permissionMode ?? '__default',
  )
  const [newLabel, setNewLabel] = React.useState('')
  const [claimResult, setClaimResult] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<ChannelGatePreview | null>(null)
  const [savedFlash, setSavedFlash] = React.useState(false)
  // 保存成功后 +1：预览 RPC 读盘，本地 draft 领先 600ms 去抖，保存落地后重取才对得齐
  const [previewNonce, setPreviewNonce] = React.useState(0)

  const isGroup = row.channelKind === 'group'
  // 预览的「全禁」红警与标签区的全禁红警是同一状态的两处呈现，
  // 标签区已经给了 fullDeny 警告，这里不重复渲染。

  // 源可见性预览（阶段 1 半成品：只有标签交集）。依赖闸字段：保存后 row 换引用但
  // channelKey 不变，只依赖 key 的话预览会停在旧值（收口验收 #3 发现）。
  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI
      .channelGatePreview(workspaceId, row.channelKey)
      .then((result) => {
        if (cancelled) return
        setPreview({
          gateEnabled: result.gateEnabled,
          visibleSlugs: result.visibleSlugs,
          allSlugs: result.allSlugs,
          pairedBy: result.pairedBy,
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspaceId, row.channelKey, gateEnabled, allowedLabels, previewNonce])

  // 自动保存（首渲染不算；row 引用变化=外部已刷新，重置基线）
  const baseline = React.useRef({
    agentId: row.agentId ?? '',
    gateEnabled: row.gateEnabled === true,
    labels: [...(row.allowedLabels ?? [])],
    mode: (row.permissionMode ?? '__default') as typeof mode,
  })
  const [dirty, setDirty] = React.useState(false)
  React.useEffect(() => {
    if (!dirty) return
    const timer = setTimeout(() => {
      const patch: Record<string, unknown> = {}
      patch.agentId = agentId || null
      patch.gateEnabled = gateEnabled
      patch.allowedLabels = gateEnabled ? allowedLabels : []
      patch.permissionMode = mode === '__default' ? null : mode
      setDirty(false)
      void window.electronAPI
        .channelGate(workspaceId, row.channelKey, patch)
        .then(() => {
          setSavedFlash(true)
          setTimeout(() => setSavedFlash(false), 1500)
          setPreviewNonce((n) => n + 1)
          onSaved()
        })
        .catch(() => undefined)
    }, AUTO_SAVE_MS)
    return () => clearTimeout(timer)
  }, [agentId, gateEnabled, allowedLabels, mode, dirty])

  const markDirty = (): void => setDirty(true)

  const toggleLabel = (label: string): void => {
    setAllowedLabels((prev) => (prev.includes(label) ? prev.filter((entry) => entry !== label) : [...prev, label]))
    markDirty()
  }

  const addLabel = async (): Promise<void> => {
    const name = newLabel.trim()
    if (!name) return
    try {
      await window.electronAPI.sourceLabels(workspaceId, { action: 'add', name })
      setNewLabel('')
      onVocabularyChange()
    } catch {
      // 重名/内置 private → 输入框保留，用户自己看
    }
  }

  const claim = async (): Promise<void> => {
    setClaimResult(null)
    const result = await window.electronAPI.channelClaim(workspaceId, row.channelKey).catch(() => null)
    if (result?.ok) {
      setClaimResult('claimed')
      onSaved()
    } else if (result?.reason === 'no_private_pairing') {
      setClaimResult('no-private')
    } else {
      setClaimResult('failed')
    }
  }

  const selectedAgent = agents.find((agent) => agent.id === agentId)
  const fullDeny = gateEnabled && allowedLabels.length === 0

  const modeOptions: Array<{ value: 'safe' | 'ask' | 'allow-all'; label: string }> = [
    { value: 'safe', label: t('events.channelGate.modeExplore', { defaultValue: '探索（只看不动）' }) },
    ...(isGroup
      ? []
      : [{ value: 'ask' as const, label: t('events.channelGate.modeAsk', { defaultValue: '询问（动手前先问）' }) }]),
    { value: 'allow-all', label: t('events.channelGate.modeExecute', { defaultValue: '执行（放开干）' }) },
  ]

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border/50 bg-muted/20 p-3">
      {/* 写保护（修 2：缺 pairedBy = 保护未开启，不是被锁住） */}
      {row.pairedBy ? (
        <p className="text-[11px] text-muted-foreground">
          {t('events.channelGate.writeProtectionOn', { defaultValue: '写保护已开启（配对成员：{{who}}）', who: row.pairedBy })}
        </p>
      ) : (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-warning">{t('events.channelGate.writeProtectionOff', { defaultValue: '写保护未开启' })}</span>
            <span className="text-muted-foreground">
              {t('events.channelGate.writeProtectionHint', {
                defaultValue: '群内删/写暂按现有权限门禁放行；认领后只有你能触发写操作。',
              })}
            </span>
            <button
              type="button"
              onClick={() => void claim()}
              className="ml-auto shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[11px] hover:bg-muted/40"
            >
              {t('events.channelGate.claim', { defaultValue: '这是我配的' })}
            </button>
          </div>
          {claimResult === 'no-private' && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('events.channelGate.claimNoPrivate', {
                defaultValue: '同平台还没有私聊配对记录——先在私聊里配对一次（/pair），再回来认领。',
              })}
            </p>
          )}
          {claimResult === 'claimed' && (
            <p className="mt-1 text-[11px] text-success">
              {t('events.channelGate.claimDone', { defaultValue: '已认领：写保护对该渠道启用。' })}
            </p>
          )}
        </div>
      )}

      {/* 助手 */}
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">
          {t('events.channelGate.agent', { defaultValue: '用哪个助手' })}
        </span>
        <select
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value)
            markDirty()
          }}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-[13px]"
        >
          <option value="">{t('events.channelGate.agentDefault', { defaultValue: '默认助手' })}</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {(agent.icon ? `${agent.icon} ` : '') + agent.name}
            </option>
          ))}
        </select>
        {selectedAgent?.dispatchHint ? (
          <span className="mt-1 block truncate text-[11px] text-muted-foreground" title={selectedAgent.dispatchHint}>
            {selectedAgent.dispatchHint}
          </span>
        ) : null}
      </label>

      {/* 标签闸 */}
      <div>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={gateEnabled}
            onChange={(e) => {
              const next = e.target.checked
              setGateEnabled(next)
              // 关闸即清标签（与盘上 patch.allowedLabels=[] 保持同步）：重开闸必须显式重选，
              // 直接红警；否则本地残留的旧标签会被静默恢复，fail-safe 失效。
              if (!next) setAllowedLabels([])
              markDirty()
            }}
          />
          {t('events.channelGate.enable', { defaultValue: '启用标签闸' })}
          <span className="text-[11px] text-muted-foreground">
            {t('events.channelGate.enableHint', {
              defaultValue: '未启用 = 放行一切（现状零回归）；启用后只放行所选标签对应的源。',
            })}
          </span>
        </label>
        {gateEnabled && (
          <div className="mt-2 space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              {labelVocabulary.map((label) => (
                <label
                  key={label}
                  className={
                    'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ' +
                    (allowedLabels.includes(label)
                      ? 'border-accent/60 bg-accent/10 text-accent'
                      : 'border-border/60 text-muted-foreground hover:bg-muted/40')
                  }
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={allowedLabels.includes(label)}
                    onChange={() => toggleLabel(label)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addLabel()
                }}
                placeholder={t('events.channelGate.labelNew', { defaultValue: '新建标签…' })}
                className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs"
              />
              <button
                type="button"
                onClick={() => void addLabel()}
                className="rounded-md border border-border/60 px-2 py-1 text-xs hover:bg-muted/40"
              >
                {t('events.channelGate.labelAdd', { defaultValue: '添加' })}
              </button>
            </div>
            {fullDeny && (
              <p className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                {t('events.channelGate.fullDenyWarning', {
                  defaultValue: '标签闸已启用且放行 0 个标签 = 该通道看不到任何数据源（这是故意的全禁，不是配置丢了）。',
                })}
              </p>
            )}
          </div>
        )}
      </div>

      {/* 执行模式（群聊无「询问」） */}
      <div>
        <span className="mb-1 block text-xs text-muted-foreground">
          {t('events.channelGate.mode', { defaultValue: '执行模式（天花板，与助手默认取更严）' })}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="radio"
              name={`gate-mode-${row.channelKey}`}
              checked={mode === '__default'}
              onChange={() => {
                setMode('__default')
                markDirty()
              }}
            />
            {t('events.channelGate.modeDefault', { defaultValue: '跟随助手默认' })}
          </label>
          {modeOptions.map((option) => (
            <label key={option.value} className="flex items-center gap-1.5 text-xs">
              <input
                type="radio"
                name={`gate-mode-${row.channelKey}`}
                checked={mode === option.value}
                onChange={() => {
                  setMode(option.value)
                  markDirty()
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>

      {/* 接收模式（阶段 1 置灰；全收/触发提示词随阶段 6 判定器上） */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
        <span>
          {t('events.channelGate.receiveMode', { defaultValue: '接收模式' })}：
        </span>
        <span className="cursor-not-allowed rounded border border-border/40 px-1.5 py-0.5">
          {t('events.channelGate.receiveAtOnly', { defaultValue: '只收@（默认）' })}
        </span>
        <span className="text-muted-foreground/50">
          {t('events.channelGate.receiveComing', { defaultValue: '全收/触发提示词 随阶段 6 判定器上线' })}
        </span>
      </div>

      {/* 源可见性预览（阶段 1 半成品：只有标签交集） */}
      {preview !== null && (
        <div className="rounded-md border border-border/40 bg-background/60 px-2.5 py-1.5 text-[11px]">
          <div className="mb-1 text-muted-foreground">
            {t('events.channelGate.preview', { defaultValue: '实际可见数据源（标签交集后）' })}：
            {preview.visibleSlugs.length === 0
              ? t('events.channelGate.previewNone', { defaultValue: '无' })
              : preview.visibleSlugs.join('、')}
          </div>
          <div className="text-muted-foreground/60">
            {t('events.channelGate.previewNote', {
              defaultValue: '模式裁剪（探索=只读类）阶段 6 生效；此处预览不含模式闸。',
            })}
          </div>
        </div>
      )}

      {savedFlash && (
        <p className="text-[11px] text-success">
          {t('events.channelGate.saved', { defaultValue: '已保存' })}
        </p>
      )}
    </div>
  )
}
