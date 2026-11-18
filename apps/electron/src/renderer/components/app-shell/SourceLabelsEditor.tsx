/**
 * Source labels editor (渠道闸门 v6/v7 切片 C, UI #1) — the 源详情页's
 * "权限标签" section: multi-select over the label vocabulary ("私有" built-in &
 * locked), create-new input, and the 只读源 switch (洞 2 三层判定第 2 层).
 *
 * 未打标签的源查询时按 ['private'] 处理（判断时自动套用，不回填配置）——
 * 编辑器把「当前无标签」显式呈现出来，保存空集合 = 回到默认语义。
 * i18n：defaultValue 惯例（中文直显），键注册是后续 i18n 任务。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { LoadedSource } from '../../../shared/types'

export interface SourceLabelsEditorProps {
  workspaceId: string
  source: LoadedSource
  /** Re-fetch the source row after a successful save. */
  onSourceUpdated: () => void
}

export function SourceLabelsEditor({
  workspaceId,
  source,
  onSourceUpdated,
}: SourceLabelsEditorProps): React.ReactElement {
  const { t } = useTranslation()
  const [vocabulary, setVocabulary] = React.useState<string[]>([])
  const [newLabel, setNewLabel] = React.useState('')
  const [readOnly, setReadOnly] = React.useState(source.config.readOnly === true)
  const [busy, setBusy] = React.useState(false)

  const current = React.useMemo(
    () => (source.config.labels && source.config.labels.length > 0 ? source.config.labels : []),
    [source.config.labels],
  )

  React.useEffect(() => {
    setReadOnly(source.config.readOnly === true)
  }, [source])

  React.useEffect(() => {
    let cancelled = false
    void window.electronAPI
      .sourceLabels(workspaceId, { action: 'list' })
      .then((file) => {
        if (!cancelled) setVocabulary(file.labels.map((entry) => entry.name))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const refreshVocabulary = (): Promise<void> =>
    window.electronAPI
      .sourceLabels(workspaceId, { action: 'list' })
      .then((file) => setVocabulary(file.labels.map((entry) => entry.name)))
      .catch(() => undefined)

  const toggle = async (label: string, on: boolean): Promise<void> => {
    const base = source.config.labels ?? []
    const next = on ? [...new Set([...base, label])] : base.filter((entry) => entry !== label)
    setBusy(true)
    try {
      // 空集合 = 保存 undefined（回到「无标签 → 查询时按 private」默认语义）
      await window.electronAPI.saveSourceConfig(workspaceId, source.config.slug, {
        labels: next.length > 0 ? next : undefined,
      })
      onSourceUpdated()
    } finally {
      setBusy(false)
    }
  }

  const addLabel = async (): Promise<void> => {
    const name = newLabel.trim()
    if (!name) return
    try {
      await window.electronAPI.sourceLabels(workspaceId, { action: 'add', name })
      setNewLabel('')
      await refreshVocabulary()
    } catch {
      // 重名 / 内置「私有」→ 输入保留，让用户看着改
    }
  }

  const setReadOnlyNext = async (next: boolean): Promise<void> => {
    setReadOnly(next)
    setBusy(true)
    try {
      await window.electronAPI.saveSourceConfig(workspaceId, source.config.slug, { readOnly: next })
      onSourceUpdated()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2.5 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          {t('sourceInfo.labelsCurrent', { defaultValue: '当前标签' })}
        </span>
        {current.length === 0 && (
          <span className="text-[11px] text-muted-foreground/70">
            {t('sourceInfo.labelsDefaultNote', { defaultValue: '（未打标，查询时按「私有」处理）' })}
          </span>
        )}
        {vocabulary.map((label) => {
          const checked = current.includes(label)
          const builtin = label === 'private'
          return (
            <label
              key={label}
              className={
                'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ' +
                (checked ? 'border-accent/60 bg-accent/10 text-accent' : 'border-border/60 text-muted-foreground hover:bg-muted/40')
              }
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={checked}
                disabled={busy}
                onChange={() => void toggle(label, !checked)}
              />
              {label}
              {builtin && (
                <span className="text-[10px] text-muted-foreground/60" title={t('sourceInfo.labelsBuiltin', { defaultValue: '内置标签，不可删除' })}>
                  内置
                </span>
              )}
            </label>
          )
        })}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={newLabel}
          onChange={(event) => setNewLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void addLabel()
          }}
          placeholder={t('sourceInfo.labelsNew', { defaultValue: '新建标签…' })}
          className="h-7 w-40 rounded-md border border-input bg-background px-2 text-xs"
        />
        <button
          type="button"
          onClick={() => void addLabel()}
          disabled={!newLabel.trim()}
          className="rounded-md border border-border/60 px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-40"
        >
          {t('sourceInfo.labelsAdd', { defaultValue: '添加' })}
        </button>

        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="h-3.5 w-3.5"
            checked={readOnly}
            disabled={busy}
            onChange={(event) => void setReadOnlyNext(event.target.checked)}
          />
          {t('sourceInfo.labelsReadOnly', { defaultValue: '只读源（搜索/文档库类；探索模式放行其写类工具）' })}
        </label>
      </div>
    </div>
  )
}
