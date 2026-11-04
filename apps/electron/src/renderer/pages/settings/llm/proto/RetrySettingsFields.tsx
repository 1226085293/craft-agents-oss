import * as React from 'react'

import { ProtoSelect } from './atoms'
import type { RetrySettingsDraft } from './retrySettings'

export function RetrySettingsFields(props: {
  draft: RetrySettingsDraft
  onChange: (update: (draft: RetrySettingsDraft) => RetrySettingsDraft) => void
  invalid?: boolean
}): React.JSX.Element {
  const { draft } = props
  return (
    <>
      <div className="field">
        <label>尝试次数</label>
        <ProtoSelect
          value={String(draft.maxAttempts)}
          options={[
            ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} 次` })),
            { value: 'unlimited', label: '无限（时限）' },
          ]}
          onChange={(value) => props.onChange((current) => ({
            ...current,
            maxAttempts: value === 'unlimited' ? 'unlimited' : Number(value) as 1 | 2 | 3 | 4 | 5,
          }))}
        />
        <div className="xs muted" style={{ marginTop: 4 }}>
          同一模型 + 提供商 + Key 目标的总尝试次数，包含首次请求；1 次表示不重试
        </div>
        {draft.maxAttempts === 'unlimited' ? (
          <div style={{ marginTop: 8 }}>
            <label>单目标时限 · 秒</label>
            <input
              aria-label="单目标时限 · 秒"
              type="number"
              min={1}
              max={86400}
              step={1}
              value={draft.maxDurationSeconds}
              onChange={(event) => props.onChange((current) => ({
                ...current,
                maxDurationSeconds: Number(event.target.value),
              }))}
            />
            <div className="notice amber" style={{ marginTop: 6 }}>
              可重试错误会在同一目标持续重试，直到达到此时限；之后切换到下一个目标。
            </div>
            {props.invalid ? <div className="xs" style={{ color: 'var(--state-bad)', marginTop: 4 }}>时限必须为 1 到 86400 秒的整数。</div> : null}
          </div>
        ) : null}
      </div>
      {/* 尝试次数为 1 = 不重试，间隔没有语义，整块隐藏。 */}
      {draft.maxAttempts !== 1 ? (
      <div className="field">
        <label>尝试间隔</label>
        <ProtoSelect
          value={draft.intervalMode}
          options={[
            { value: 'fixed', label: '固定间隔' },
            { value: 'exponential', label: '指数退避' },
          ]}
          onChange={(value) => props.onChange((current) => ({
            ...current,
            intervalMode: value as 'fixed' | 'exponential',
          }))}
        />
        {draft.intervalMode === 'fixed' ? (
          <div style={{ marginTop: 8 }}>
            <label>重试间隔 · 秒</label>
            <input
              aria-label="重试间隔 · 秒"
              type="number"
              min={0}
              step={0.1}
              value={draft.backoffSeconds}
              onChange={(event) => props.onChange((current) => ({
                ...current,
                backoffSeconds: Number(event.target.value),
              }))}
            />
          </div>
        ) : (
          <div className="xs muted" style={{ marginTop: 4 }}>
            默认 1、2、4、8、16、30… 秒（退避基数最高 30 秒），再加 0–10% 随机抖动。
          </div>
        )}
      </div>
      ) : null}
    </>
  )
}
