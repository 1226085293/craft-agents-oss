import * as React from 'react'

import { Switch } from './atoms'
import type { WaitForCooldownDraft } from './waitForCooldownSettings'

export function WaitForCooldownFields(props: {
  draft: WaitForCooldownDraft
  onChange: (update: (draft: WaitForCooldownDraft) => WaitForCooldownDraft) => void
  invalid?: boolean
}): React.JSX.Element {
  const { draft } = props
  return (
    <div className="field">
      <label>等待冷却后重试</label>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">本组全部冷却时，等最快的解冻再重试本组，而不是立即转移</span>
        <Switch on={draft.enabled} onClick={() => props.onChange((current) => ({ ...current, enabled: !current.enabled }))} />
      </div>
      {draft.enabled ? (
        <div style={{ marginTop: 8 }}>
          <label>最长等待 · 秒</label>
          <input
            aria-label="最长等待 · 秒"
            type="number"
            min={1}
            max={540}
            step={1}
            value={draft.maxWaitSeconds}
            onChange={(event) => props.onChange((current) => ({
              ...current,
              maxWaitSeconds: Number(event.target.value),
            }))}
          />
          <div className="xs muted" style={{ marginTop: 4 }}>
            仅对流式对话请求生效；解冻时间超过此值（如配额级冷却）不等待，直接走「全部失败后转移至」。
          </div>
          {props.invalid ? <div className="xs" style={{ color: 'var(--state-bad)', marginTop: 4 }}>最长等待必须为 1 到 540 秒的整数。</div> : null}
        </div>
      ) : null}
    </div>
  )
}
