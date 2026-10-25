/**
 * 设置 — the prototype's `vSettings()` structure, wired to the app's real
 * settings where they exist.
 *
 * Binding policy (deliberate, so nothing on this page is decorative):
 *   - 默认策略组 / 整理策略组 → persisted preference read by the session layer
 *     (default strategy) and reserved for memory extraction;
 *   - Token 优化（RTK） / 嵌入模型 → real app config via the existing IPC;
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
import { DEFAULT_STRATEGY_STORAGE_KEY } from '@/hooks/useSessionOptions'

interface Props {
  config: LlmConfigShape
  strategies: ProtoStrategy[]
  kpiConfig: string[]
  onKpiConfig: (i: number, id: string) => void
  onSave: (next: LlmConfigShape) => Promise<boolean>
}

function readPref(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function writePref(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // Preference persistence is best-effort.
  }
}

export function SettingsView(props: Props): React.JSX.Element {
  const shell = useProtoShell()
  const { strategies } = props

  /**
   * The gateway config is the source of truth for the default group.
   *
   * Sessions are created server-side by automations, messaging and the API, none
   * of which see a renderer preference, so a localStorage default (or one tied
   * to whatever workspace the settings window happens to be in) left every one
   * of those on 未选择策略组. The gateway config is readable by every creation
   * path and is the file this page already saves. localStorage stays as the seed
   * for a config written by an older build.
   */
  const savedStrategy = props.config?.defaultStrategy ?? ''
  const [defaultStrategy, setDefaultStrategy] = React.useState(() => savedStrategy || readPref(DEFAULT_STRATEGY_STORAGE_KEY))

  // A config saved elsewhere (another window, the gateway reloading after an
  // edit) must not be clobbered by this window's stale draft.
  React.useEffect(() => {
    if (savedStrategy) setDefaultStrategy(savedStrategy)
  }, [savedStrategy])

  // Performance section — real app config.
  const [rtkEnabled, setRtkEnabled] = React.useState<boolean | null>(null)
  const [rtkVersion, setRtkVersion] = React.useState<string | null>(null)
  const [embeddingPath, setEmbeddingPath] = React.useState('')
  const [embeddingDraft, setEmbeddingDraft] = React.useState('')

  React.useEffect(() => {
    void window.electronAPI.getRtkEnabled?.().then((v) => setRtkEnabled(v !== false))
    void window.electronAPI.getRtkStatus?.({}).then((s) => {
      setRtkVersion(s?.installed ? (s.version ?? '已安装') : null)
    })
    void window.electronAPI.getEmbeddingModelPath?.().then((p) => {
      setEmbeddingPath(p ?? '')
      setEmbeddingDraft(p ?? '')
    })
  }, [])

  const strategyOptions = strategies.map((s) => ({ value: s.id, label: s.name }))

  return (
    <>
      <div className="page-title">设置</div>
      <div className="page-desc">会话默认值与性能选项</div>

      <div className="sec-title" style={{ marginTop: 6 }}>
        默认模型
      </div>
      <div className="card">
        <div className="row spread" style={{ padding: '8px 0' }}>
          <div>
            <span className="small">默认策略组</span>
            <div className="xs muted">新会话默认通过的策略组；会话内仍可临时切换</div>
          </div>
          <div style={{ width: 200 }}>
            <ProtoSelect
              value={defaultStrategy}
              options={[{ value: '', label: '不指定（每次手动选择）' }, ...strategyOptions]}
              onChange={(v) => {
                setDefaultStrategy(v)
                writePref(DEFAULT_STRATEGY_STORAGE_KEY, v)
                // Persist through the gateway config — the same path this page
                // already saves — so server-side creation (automations,
                // messaging, API) picks it up too.
                void props
                  .onSave({ ...props.config, defaultStrategy: v || undefined })
                  .then((ok) => {
                    shell.toast(
                      ok === false
                        ? '保存失败：请检查策略组设置'
                        : v
                          ? `新会话默认使用「${strategyOptions.find((s) => s.value === v)?.label ?? v}」`
                          : '已取消默认策略组',
                    )
                  })
                  .catch((err: unknown) => {
                    shell.toast(`保存失败：${err instanceof Error ? err.message : String(err)}`)
                  })
              }}
            />
          </div>
        </div>
      </div>

      <div className="sec-title" style={{ marginTop: 20 }}>
        记忆整理
      </div>
      <div className="card">
        <div className="row spread" style={{ padding: '8px 0' }}>
          <div>
            <span className="small">策略组</span>
            <div className="xs muted">
              记忆抽取、整合与仲裁走这个策略组；留空则使用会话的策略组。其余辅助调用（标题、忙碌/群聊决策、摘要）始终跟随会话自己的策略组。
            </div>
          </div>
          <div style={{ width: 200 }}>
            <ProtoSelect
              value={props.config.miniStrategy ?? ''}
              options={[{ value: '', label: '使用会话策略组' }, ...strategyOptions]}
              onChange={(v) => {
                void props.onSave({
                  ...props.config,
                  miniStrategy: v || undefined,
                }).then((ok) => {
                  if (ok) shell.toast(v ? `记忆整理将使用「${strategyOptions.find((s) => s.value === v)?.label ?? v}」` : '记忆整理已改为使用会话策略组')
                })
              }}
            />
          </div>
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

        <div className="card">
          <div className="row spread" style={{ padding: '8px 0' }}>
            <div>
              <span className="small">嵌入模型</span>
              <div className="xs muted">语义记忆检索的本地 ONNX 模型，留空使用内置</div>
            </div>
            <div className="row">
              <input
                type="text"
                className="sm"
                style={{ width: 220 }}
                placeholder="ONNX 模型目录路径"
                value={embeddingDraft}
                onChange={(e) => setEmbeddingDraft(e.target.value)}
              />
              <button
                type="button"
                className="btn sm"
                style={{ padding: '4px 10px' }}
                onClick={() => {
                  void window.electronAPI.setEmbeddingModelPath?.(embeddingDraft.trim()).then(() => {
                    setEmbeddingPath(embeddingDraft.trim())
                    shell.toast('已保存嵌入模型路径（重启后生效）')
                  })
                }}
              >
                保存
              </button>
              <button
                type="button"
                className="btn sm"
                style={{ padding: '4px 10px' }}
                disabled={!embeddingPath}
                onClick={() => {
                  void window.electronAPI.clearEmbeddingModelPath?.().then(() => {
                    setEmbeddingPath('')
                    setEmbeddingDraft('')
                    shell.toast('已恢复内置模型')
                  })
                }}
              >
                恢复默认
              </button>
            </div>
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
