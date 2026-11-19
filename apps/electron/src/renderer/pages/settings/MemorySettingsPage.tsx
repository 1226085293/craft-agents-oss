/**
 * MemorySettingsPage — 记忆全局设置。
 *
 * 11-19 拍板后的形状：域视图（个人域/项目域 的 图/实体/原文 三面）已迁出，
 * 跟它们描述的东西放在一起——助手详情展示自己的个人域，项目详情展示项目域。
 * 本页只留全局设置，四节：
 *   1. 记忆开关   —— 全局记忆系统总闸（关：主界面/助手/项目的记忆入口不显示，
 *                    抽取/做梦/策展/注入逻辑不执行；数据保留）
 *   2. 记忆整理策略组 —— 记忆抽取/整合/仲裁 + 渠道判定器的专用策略组
 *                    （从 LLM 网关设置迁来，配置仍存 llm config 的 miniStrategy）
 *   3. 做梦 · 记忆整合 —— cron 排班 + 立即整理 + 实时进度（含策展摘要行）
 *   4. 嵌入模型设置 —— 本地 ONNX 语义检索模型路径（从 LLM 网关设置迁来）
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { X, Zap } from 'lucide-react'

import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { SettingsCard, SettingsSection, SettingsSelectRow } from '@/components/settings'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

import { useLlmConfig } from './llm/hooks'
import type { LlmConfigShape } from './llm/types'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'memory',
}

const DEFAULT_TZ = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'

interface DreamState {
  enabled: boolean
  cron: string
  timezone: string
}

interface DreamRun {
  active: boolean
  done: number
  total: number
  phase: 'running' | 'done' | 'cancelled' | 'error'
  promoted: number
  trashed: number
  message?: string
}

export default function MemorySettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const rootPath = workspace?.rootPath

  // --------------------------------------------------------------------------
  // 1. 记忆开关（全局）
  // --------------------------------------------------------------------------
  const [memoryEnabled, setMemoryEnabled] = React.useState<boolean | null>(null)
  const [memorySwitchBusy, setMemorySwitchBusy] = React.useState(false)

  React.useEffect(() => {
    if (!rootPath) return
    let cancelled = false
    void window.electronAPI
      .memoryEnabledGet?.(rootPath)
      .then((res) => {
        if (!cancelled) setMemoryEnabled(res?.enabled ?? true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [rootPath])

  const toggleMemoryEnabled = async (next: boolean): Promise<void> => {
    if (!rootPath || memorySwitchBusy) return
    setMemorySwitchBusy(true)
    try {
      await window.electronAPI.memoryEnabledSet?.(rootPath, next)
      setMemoryEnabled(next)
    } finally {
      setMemorySwitchBusy(false)
    }
  }

  // --------------------------------------------------------------------------
  // 2. 记忆整理策略组（miniStrategy，配置在 llm config，UI 从网关设置迁来）
  // --------------------------------------------------------------------------
  const { config: llmConfig, reload: reloadLlmConfig } = useLlmConfig()
  const [miniStrategySaving, setMiniStrategySaving] = React.useState(false)
  const [miniStrategySaved, setMiniStrategySaved] = React.useState(false)

  const strategyOptions: Array<{ value: string; label: string }> = [
    { value: '', label: t('settings.memory.miniStrategyDefault', { defaultValue: '缺省（跟随会话策略组 → 第一个启用组）' }) },
    ...((llmConfig?.strategies ?? [])
      .filter((s) => s.enabled !== false)
      .map((s) => ({ value: s.id, label: s.name ?? s.id }))),
  ]

  const pickMiniStrategy = async (next: string): Promise<void> => {
    if (!llmConfig || miniStrategySaving) return
    setMiniStrategySaving(true)
    setMiniStrategySaved(false)
    const result = await window.electronAPI
      .llmGatewaySaveConfig({ ...llmConfig, miniStrategy: next || undefined })
      .catch(() => null)
    setMiniStrategySaving(false)
    if (result?.ok) {
      // Re-read from the server — the only way to see its accepted shape.
      reloadLlmConfig()
      setMiniStrategySaved(true)
      setTimeout(() => setMiniStrategySaved(false), 1600)
    }
  }

  // --------------------------------------------------------------------------
  // 3. 做梦 (dreaming) — schedule + live run state
  // --------------------------------------------------------------------------
  const [dream, setDream] = React.useState<DreamState | null>(null)
  const [dreamDirty, setDreamDirty] = React.useState(false)
  const [dreamSaving, setDreamSaving] = React.useState(false)
  const [run, setRun] = React.useState<DreamRun | null>(null)

  // Load the dreaming schedule (memory store is keyed by root path, not id).
  React.useEffect(() => {
    if (!rootPath) return
    let cancelled = false
    void window.electronAPI
      .getMemorySchedule(rootPath)
      .then((s) => {
        if (cancelled) return
        setDream({ enabled: s.enabled, cron: s.cron, timezone: s.timezone || DEFAULT_TZ() })
      })
      .catch(() => undefined)
    void window.electronAPI
      .getConsolidationState(rootPath)
      .then((s) => {
        if (cancelled) return
        // Only surface LIVE runs; a stale last-run state would just render as
        // idle noise (「已整理 0/0」) on a page nobody is consolidating on.
        if (s.active) {
          setRun({ active: true, done: s.done, total: s.total, phase: 'running', promoted: 0, trashed: 0 })
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [rootPath])

  // Live consolidation progress (workspace-wide broadcast).
  React.useEffect(() => {
    const off = window.electronAPI.onMemoryConsolidationProgress((p) => {
      setRun({
        active: p.phase === 'running',
        done: p.done,
        total: p.total,
        phase: p.phase,
        promoted: p.promoted,
        trashed: p.trashed,
        message: p.message,
      })
    })
    return off
  }, [])

  // Debounced schedule autosave (same discipline as the channel gate panel).
  React.useEffect(() => {
    if (!dreamDirty || !dream || !rootPath) return
    const timer = setTimeout(() => {
      setDreamSaving(true)
      void window.electronAPI
        .setMemorySchedule(rootPath, {
          enabled: dream.enabled,
          cron: dream.cron.trim() || '0 3 * * *',
          timezone: dream.timezone || undefined,
        })
        .catch(() => undefined)
        .finally(() => {
          setDreamSaving(false)
          setDreamDirty(false)
        })
    }, 600)
    return () => clearTimeout(timer)
  }, [dream, dreamDirty, rootPath])

  const runDreamNow = async (): Promise<void> => {
    if (!rootPath) return
    const result = await window.electronAPI.consolidateMemories(rootPath).catch(() => null)
    if (result) {
      setRun({ active: true, done: 0, total: result.total, phase: 'running', promoted: 0, trashed: 0 })
    }
  }

  const cancelDream = async (): Promise<void> => {
    if (!rootPath) return
    await window.electronAPI.cancelConsolidateMemories(rootPath).catch(() => undefined)
  }

  const patchDream = (patch: Partial<DreamState>): void => {
    setDream((prev) => (prev ? { ...prev, ...patch } : prev))
    setDreamDirty(true)
  }

  // --------------------------------------------------------------------------
  // 4. 嵌入模型设置（本地 ONNX 路径，IPC 直存）
  // --------------------------------------------------------------------------
  const [embeddingPath, setEmbeddingPath] = React.useState('')
  const [embeddingDraft, setEmbeddingDraft] = React.useState('')
  const [embeddingSaving, setEmbeddingSaving] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI
      .getEmbeddingModelPath?.()
      .then((p) => {
        if (cancelled) return
        setEmbeddingPath(p ?? '')
        setEmbeddingDraft(p ?? '')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const saveEmbeddingPath = async (): Promise<void> => {
    if (embeddingSaving) return
    setEmbeddingSaving(true)
    try {
      await window.electronAPI.setEmbeddingModelPath?.(embeddingDraft.trim())
      setEmbeddingPath(embeddingDraft.trim())
    } finally {
      setEmbeddingSaving(false)
    }
  }

  const clearEmbeddingPath = async (): Promise<void> => {
    if (embeddingSaving) return
    setEmbeddingSaving(true)
    try {
      await window.electronAPI.clearEmbeddingModelPath?.()
      setEmbeddingPath('')
      setEmbeddingDraft('')
    } finally {
      setEmbeddingSaving(false)
    }
  }

  if (!workspace) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title={t('settings.memory.title', { defaultValue: '记忆' })} actions={<HeaderMenu route={routes.view.settings('memory')} />} />
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          {t('settings.memory.noWorkspace', { defaultValue: '没有活动的工作区' })}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t('settings.memory.title', { defaultValue: '记忆' })} actions={<HeaderMenu route={routes.view.settings('memory')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* 1. 记忆开关（全局总闸） */}
              <SettingsSection
                title={t('settings.memory.enabled', { defaultValue: '记忆开关' })}
                description={t('settings.memory.enabledDesc', {
                  defaultValue:
                    '关闭后：主界面「数据源 → 记忆」、助手详情的记忆、项目详情的记忆都不再显示，记忆抽取 / 做梦 / 策展 / 注入逻辑不执行。数据保留在盘上，重新打开后自动恢复。',
                })}
              >
                <SettingsCard>
                  <label className="flex items-center gap-2 p-3 text-[13px]">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={memoryEnabled !== false}
                      disabled={memoryEnabled === null || memorySwitchBusy}
                      onChange={(e) => void toggleMemoryEnabled(e.target.checked)}
                    />
                    {memoryEnabled === null
                      ? t('settings.memory.enabledLoading', { defaultValue: '读取中…' })
                      : memoryEnabled !== false
                        ? t('settings.memory.enabledOn', { defaultValue: '记忆系统运行中' })
                        : t('settings.memory.enabledOff', { defaultValue: '记忆系统已关闭' })}
                  </label>
                </SettingsCard>
              </SettingsSection>

              {/* 2. 记忆整理策略组（从 LLM 网关设置迁来） */}
              <SettingsSection
                title={t('settings.memory.strategyGroup', { defaultValue: '记忆整理策略组' })}
                description={t('settings.memory.strategyGroupDesc', {
                  defaultValue:
                    '记忆抽取、整合与仲裁（以及渠道消息判定器）走这个策略组；缺省则跟随会话策略组 → 第一个启用的组。其余辅助调用（标题、忙碌/群聊决策、摘要）始终跟随会话自己的策略组。',
                })}
              >
                <SettingsCard>
                  <div className="p-3">
                    <SettingsSelectRow
                      label={t('settings.memory.strategyGroupLabel', { defaultValue: '策略组' })}
                      value={llmConfig?.miniStrategy ?? ''}
                      onValueChange={(v) => void pickMiniStrategy(v)}
                      options={strategyOptions}
                      disabled={llmConfig === null || miniStrategySaving}
                    />
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {llmConfig === null
                        ? t('settings.memory.strategyGroupLoading', { defaultValue: '读取 LLM 网关配置…' })
                        : miniStrategySaved
                          ? t('settings.memory.strategyGroupSaved', { defaultValue: '已保存' })
                          : miniStrategySaving
                            ? t('settings.memory.strategyGroupSaving', { defaultValue: '保存中…' })
                            : null}
                    </div>
                  </div>
                </SettingsCard>
              </SettingsSection>

              {/* 3. 做梦（记忆整合）：定时 + 立即 + 实时进度。 */}
              <SettingsSection
                title={t('settings.memory.dreaming', { defaultValue: '做梦 · 记忆整合' })}
                description={t('settings.memory.dreamingDesc', {
                  defaultValue: '定时把会话里的零散记忆整理进记忆域。后端调度器按 cron 执行，也可立即整理。',
                })}
              >
                <SettingsCard>
                  {dream ? (
                    <div className="space-y-3 p-3">
                      <label className="flex items-center gap-2 text-[13px]">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={dream.enabled}
                          onChange={(e) => patchDream({ enabled: e.target.checked })}
                        />
                        {t('settings.memory.dreamEnabled', { defaultValue: '启用定时做梦' })}
                      </label>
                      {/*
                        * 启用开关直接决定显隐（与 agent 面板分工说明同一原则）：
                        * 关 → 周期/时区行收起、留一行空态；开 → 展开。
                        * 已配好的 cron/时区存于 dream state 不丢，重新开启即恢复。
                        */}
                      {dream.enabled ? (
                        <>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <label className="flex items-center gap-1.5">
                              <span className="text-xs text-muted-foreground">
                                {t('settings.memory.dreamCron', { defaultValue: '周期' })}
                              </span>
                              <input
                                value={dream.cron}
                                onChange={(e) => patchDream({ cron: e.target.value })}
                                className="h-7 w-36 rounded-md border border-input bg-background px-2 font-mono text-[12px]"
                                aria-label={t('settings.memory.dreamCron', { defaultValue: '周期（cron）' })}
                              />
                            </label>
                            <label className="flex items-center gap-1.5">
                              <span className="text-xs text-muted-foreground">
                                {t('settings.memory.dreamTimezone', { defaultValue: '时区' })}
                              </span>
                              <input
                                value={dream.timezone}
                                onChange={(e) => patchDream({ timezone: e.target.value })}
                                className="h-7 w-36 rounded-md border border-input bg-background px-2 text-[12px]"
                                aria-label={t('settings.memory.dreamTimezone', { defaultValue: '时区' })}
                              />
                            </label>
                          </div>
                          <p className="text-[10px] text-muted-foreground/60">
                            {t('settings.memory.dreamCronHint', { defaultValue: '例：0 3 * * * = 每天 03:00（按所选时区）' })}
                          </p>
                        </>
                      ) : (
                        <div className="rounded-md border border-dashed border-input bg-muted/30 p-2.5 text-xs text-muted-foreground">
                          {t('settings.memory.dreamDisabledNote', {
                            defaultValue: '关闭时定时任务不会运行；「立即整理」不受影响，随时可手动整理',
                          })}
                          {/* 收起 ≠ 数据不存在：把排班值露出来，关着也看得见“排的是什么班”。 */}
                          <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                            {t('settings.memory.dreamDisabledSchedule', {
                              defaultValue: '当前周期 {{cron}} · 时区 {{timezone}}（开启后生效）',
                              cron: dream.cron.trim() || '0 3 * * *',
                              timezone: dream.timezone,
                            })}
                          </div>
                        </div>
                      )}
                      <div className="flex items-center gap-2 pt-1">
                        {run?.active ? (
                          <>
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-foreground/70 transition-all duration-500"
                                style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%` }}
                              />
                            </div>
                            <span className="text-[11px] tabular-nums text-muted-foreground">
                              {run.done}/{run.total}
                            </span>
                            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => void cancelDream()}>
                              <X className="h-3 w-3" aria-hidden />
                              {t('settings.memory.dreamCancel', { defaultValue: '取消' })}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void runDreamNow()}>
                            <Zap className="h-3.5 w-3.5" aria-hidden />
                            {t('settings.memory.dreamNow', { defaultValue: '立即整理' })}
                          </Button>
                        )}
                        {dreamSaving ? (
                          <span className="text-[11px] text-muted-foreground">
                            {t('settings.memory.dreamSaving', { defaultValue: '保存中…' })}
                          </span>
                        ) : null}
                        {run && !run.active && run.phase === 'done' && (run.promoted > 0 || run.trashed > 0) ? (
                          <span className="text-[11px] text-success">
                            {t('settings.memory.dreamDone', {
                              defaultValue: '已整理：晋升 {{promoted}} · 清理 {{trashed}}',
                              promoted: run.promoted,
                              trashed: run.trashed,
                            })}
                          </span>
                        ) : null}
                        {/* M7b：策展步摘要（策展 N 域 · 剪枝 M 条）走既有 message 管道。 */}
                        {run && !run.active && run.phase === 'done' && run.message ? (
                          <span className="text-[11px] text-muted-foreground">{run.message}</span>
                        ) : null}
                        {run && run.phase === 'error' ? (
                          <span className="text-[11px] text-destructive">
                            {run.message || t('settings.memory.dreamError', { defaultValue: '整理出错' })}
                          </span>
                        ) : null}
                        {run && !run.active && run.phase === 'cancelled' ? (
                          <span className="text-[11px] text-muted-foreground">
                            {t('settings.memory.dreamCancelled', { defaultValue: '已取消' })}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="px-3 py-2.5 text-[12px] text-muted-foreground">
                      {t('settings.memory.dreamLoading', { defaultValue: '读取做梦设置…' })}
                    </div>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* 4. 嵌入模型设置（从 LLM 网关设置迁来） */}
              <SettingsSection
                title={t('settings.memory.embedding', { defaultValue: '嵌入模型设置' })}
                description={t('settings.memory.embeddingDesc', {
                  defaultValue: '语义记忆检索用的本地 ONNX 模型；留空使用内置模型。',
                })}
              >
                <SettingsCard>
                  <div className="flex items-center gap-2 p-3">
                    <Input
                      value={embeddingDraft}
                      onChange={(e) => setEmbeddingDraft(e.target.value)}
                      placeholder={t('settings.memory.embeddingPlaceholder', { defaultValue: 'ONNX 模型目录路径（留空 = 内置）' })}
                      className="h-8 flex-1 text-[12px]"
                      disabled={embeddingSaving}
                    />
                    <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => void saveEmbeddingPath()} disabled={embeddingSaving}>
                      {t('settings.memory.embeddingSave', { defaultValue: '保存' })}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 gap-1 text-xs" onClick={() => void clearEmbeddingPath()} disabled={embeddingSaving || embeddingPath === ''}>
                      {t('settings.memory.embeddingReset', { defaultValue: '恢复默认' })}
                    </Button>
                  </div>
                  {embeddingPath ? (
                    <p className="px-3 pb-2.5 font-mono text-[10px] text-muted-foreground break-all">
                      {embeddingPath}
                    </p>
                  ) : null}
                  <p className="px-3 pb-2.5 text-[10px] text-muted-foreground/60">
                    {t('settings.memory.embeddingRestartHint', { defaultValue: '修改后重启应用生效' })}
                  </p>
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
