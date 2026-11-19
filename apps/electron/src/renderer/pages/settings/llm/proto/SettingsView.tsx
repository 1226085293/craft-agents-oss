/**
 * 设置 — the prototype's `vSettings()` structure, wired to the app's real
 * settings where they exist.
 *
 * Binding policy (deliberate, so nothing on this page is decorative):
 *   - 默认策略组 / 整理策略组 → persisted preference read by the session layer
 *     (default strategy) and reserved for memory extraction;
 *     记忆整理策略组与嵌入模型 UI 已迁到 设置/记忆 页（11-19 拍板）；
 *   - Token 优化（RTK） → real app config via the existing IPC;
 *   - 日志落盘 → real gateway config (`usage.persist`): off keeps only the
 *     current session's log, on writes one file per local day.
 *
 * There is intentionally no "网关 / 客户端 Key" section here: this is the
 * in-process gateway used by the app itself, not an external relay that hands
 * out keys to third parties.
 */

import * as React from 'react'

import type { LlmConfigShape } from '../types'
import { ProtoSelect, Switch } from './atoms'
import type { ProtoStrategy } from './viewmodel'
import { KPI_DEFS } from './OverviewView'
import { useProtoShell } from './state'

interface Props {
  config: LlmConfigShape
  strategies: ProtoStrategy[]
  kpiConfig: string[]
  onKpiConfig: (i: number, id: string) => void
  onSave: (next: LlmConfigShape) => Promise<boolean>
}

export function SettingsView(props: Props): React.JSX.Element {
  const shell = useProtoShell()
  const { strategies } = props

  // Performance section — real app config.
  // 嵌入模型设置与记忆整理策略组已迁到 设置/记忆 页（11-19 拍板），
  // 本页只剩 Token 优化（RTK）。
  const [rtkEnabled, setRtkEnabled] = React.useState<boolean | null>(null)
  const [rtkVersion, setRtkVersion] = React.useState<string | null>(null)

  React.useEffect(() => {
    void window.electronAPI.getRtkEnabled?.().then((v) => setRtkEnabled(v !== false))
    void window.electronAPI.getRtkStatus?.({}).then((s) => {
      setRtkVersion(s?.installed ? (s.version ?? '已安装') : null)
    })
  }, [])

  const strategyOptions = strategies.map((s) => ({ value: s.id, label: s.name }))

  return (
    <>
      <div className="page-title">设置</div>
      <div className="page-desc">辅助模型与性能选项</div>

      <div className="sec-title" style={{ marginTop: 20 }}>
        会话压缩
      </div>
      <div className="card">
        <div className="row spread" style={{ padding: '8px 0' }}>
          <div style={{ minWidth: 0 }}>
            <span className="small">策略组</span>
            <div className="xs muted">
              会话上下文压缩时，负责生成摘要的那次调用走这个策略组；留空则使用会话自己的策略组（与以前一致）。摘要要读完整个对话却只产出几百字，单独放到一个便宜的组里，可以不占对话的配额与冷却。
            </div>
          </div>
          <div style={{ flex: '0 0 200px', width: 200 }}>
            <ProtoSelect
              value={props.config.compactionStrategy ?? ''}
              options={[{ value: '', label: '使用会话策略组' }, ...strategyOptions]}
              onChange={(v) => {
                void props.onSave({
                  ...props.config,
                  compactionStrategy: v || undefined,
                }).then((ok) => {
                  if (ok) shell.toast(v ? `会话压缩将使用「${strategyOptions.find((s) => s.value === v)?.label ?? v}」` : '会话压缩已改为使用会话策略组')
                })
              }}
            />
          </div>
        </div>
        <div className="xs muted" style={{ paddingBottom: 8 }}>
          切换后对之后新建的会话生效；正在进行的会话仍用启动时选定的策略组。
        </div>
      </div>

      <div className="sec-title" style={{ marginTop: 20 }}>
        督导
      </div>
      <div className="card">
        <div className="row spread" style={{ padding: '8px 0' }}>
          <div style={{ minWidth: 0 }}>
            <span className="small">策略组</span>
            <div className="xs muted">
              督导会话是工作区级别的协调者，全工作区只有一个——它读事件、分派任务，大多数时候的判断是“这条不用管”。让它单独走一个便宜快的组，可以不占真正干活的模型的额度。留空则跟随默认策略组。
            </div>
          </div>
          <div style={{ flex: '0 0 200px', width: 200 }}>
            <ProtoSelect
              value={props.config.supervisorStrategy ?? ''}
              options={[{ value: '', label: '跟随默认策略组' }, ...strategyOptions]}
              onChange={(v) => {
                void props.onSave({
                  ...props.config,
                  supervisorStrategy: v || undefined,
                }).then((ok) => {
                  if (ok) shell.toast(v ? `督导将使用「${strategyOptions.find((s) => s.value === v)?.label ?? v}」` : '督导已改为跟随默认策略组')
                })
              }}
            />
          </div>
        </div>
        <div className="xs muted" style={{ paddingBottom: 8 }}>
          切换后对之后新建的督导会话生效；已存在的督导会话仍用创建时选定的策略组。
        </div>
      </div>

      <div className="sec-title" style={{ marginTop: 20 }}>
        总览 KPI
      </div>
      <div className="card">
        <div className="xs muted" style={{ marginBottom: 8 }}>
          选择总览页展示的 5 张卡片（不重复：选到已占用的指标会自动与另一张卡交换）。
        </div>
        <div className="grid2" style={{ gap: '8px 16px' }}>
          {props.kpiConfig.map((id, i) => (
            <div key={`${id}-${i}`} className="row spread">
              <span className="small muted">{`卡片 ${i + 1}`}</span>
              <div style={{ width: 170 }}>
                <ProtoSelect
                  value={id}
                  options={Object.keys(KPI_DEFS).map((k) => ({ value: k, label: KPI_DEFS[k].label }))}
                  onChange={(v) => props.onKpiConfig(i, v)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sec-title" style={{ marginTop: 20 }}>
        性能
      </div>
      <div className="stack">
        <div className="card">
          <div className="row spread" style={{ padding: '8px 0' }}>
            <div>
              <span className="small">Token 优化（RTK）</span>
              <div className="xs muted">压缩 Bash 输出，减少 token 消耗</div>
            </div>
            <Switch
              on={rtkEnabled !== false}
              onClick={() => {
                const next = rtkEnabled === false
                setRtkEnabled(next)
                void window.electronAPI.setRtkEnabled?.(next).then(() => {
                  shell.toast(next ? '已启用 RTK' : '已关闭 RTK')
                })
              }}
            />
          </div>
          <div className="xs muted" style={{ paddingBottom: 8 }}>
            {rtkEnabled === null ? '读取中…' : rtkVersion ? `rtk 已安装 · ${rtkVersion}` : 'rtk 未安装（启用后无效果）'}
          </div>
        </div>
      </div>

      <div className="sec-title" style={{ marginTop: 20 }}>
        日志
      </div>
      <div className="card">
        <div className="row spread" style={{ padding: '8px 0' }}>
          <div>
            <span className="small">日志落盘</span>
            <div className="xs muted">把网关请求日志写入本地文件，便于排查问题（默认关闭）</div>
          </div>
          <Switch
            on={props.config.usage?.persist === true}
            onClick={() => {
              const next = props.config.usage?.persist !== true
              void props.onSave({
                ...props.config,
                usage: { ...(props.config.usage ?? {}), persist: next },
              }).then((ok) => {
                if (ok) shell.toast(next ? '已开启日志落盘（按日分文件）' : '已关闭日志落盘（只保留本次运行）')
              })
            }}
          />
        </div>
        <div className="xs muted" style={{ paddingBottom: 4 }}>
          关闭时只保留本次运行的日志（启动清空）；开启后按本地日期分文件保存。总览统计由这些日志实时汇总，所以两边的数字永远一致。
        </div>
      </div>
    </>
  )
}
