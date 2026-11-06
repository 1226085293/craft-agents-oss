import * as React from 'react'

/**
 * New-task form.
 *
 * Deliberately a contract, not a chat box: name, the immutable request, where it
 * runs, what proves it, and what starts it. Anything left blank simply is not
 * part of the contract — an empty field must never be stored as an empty string.
 */

export interface TaskCreateInput {
  name: string
  instruction: string
  spec?: {
    cwd?: string
    sources?: string[]
    deliverables?: Array<{ kind: string; path?: string; note?: string }>
    acceptance?: Array<{ id: string; check: string; command?: string }>
  }
  trigger?: { kind: 'manual' } | { kind: 'cron'; expr: string; timezone?: string; enabled: boolean }
}

export interface TaskCreateDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (input: TaskCreateInput) => void
}

/** `id|检查说明|命令` per line; the command is optional. */
function parseAcceptance(raw: string): Array<{ id: string; check: string; command?: string }> {
  return raw
    .split('\n')
    .map((line, index) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split('|').map((p) => p.trim())
      const [id, check, command] = parts.length >= 3 ? parts : [`a${index + 1}`, parts[0], parts[1]]
      return {
        id: id || `a${index + 1}`,
        check: check || parts[0],
        ...(command ? { command } : {}),
      }
    })
    .filter((item) => item.check)
}

/** `kind:path` per line. */
function parseDeliverables(raw: string): Array<{ kind: string; path?: string }> {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':')
      if (at < 0) return { kind: 'file', path: line }
      const kind = line.slice(0, at).trim() || 'file'
      const path = line.slice(at + 1).trim()
      return { kind, ...(path ? { path } : {}) }
    })
}

export function TaskCreateDialog({ open, onClose, onSubmit }: TaskCreateDialogProps): React.JSX.Element | null {
  const [name, setName] = React.useState('')
  const [instruction, setInstruction] = React.useState('')
  const [cwd, setCwd] = React.useState('')
  const [sources, setSources] = React.useState('')
  const [deliverables, setDeliverables] = React.useState('')
  const [acceptance, setAcceptance] = React.useState('')
  const [cron, setCron] = React.useState('')

  if (!open) return null

  const submit = () => {
    if (!name.trim() || !instruction.trim()) return
    const acceptanceItems = parseAcceptance(acceptance)
    const deliverableItems = parseDeliverables(deliverables)
    const spec: TaskCreateInput['spec'] = {}
    if (cwd.trim()) spec.cwd = cwd.trim()
    if (sources.trim()) spec.sources = sources.split(',').map((s) => s.trim()).filter(Boolean)
    if (deliverableItems.length) spec.deliverables = deliverableItems
    if (acceptanceItems.length) spec.acceptance = acceptanceItems

    onSubmit({
      name: name.trim(),
      instruction: instruction.trim(),
      ...(Object.keys(spec).length ? { spec } : {}),
      trigger: cron.trim()
        ? { kind: 'cron', expr: cron.trim(), enabled: true }
        : { kind: 'manual' },
    })
    setName('')
    setInstruction('')
    setCwd('')
    setSources('')
    setDeliverables('')
    setAcceptance('')
    setCron('')
    onClose()
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="text-sm font-semibold">新建任务</div>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5"
          onClick={onClose}
        >
          取消
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <Field label="任务名">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：每周依赖审计" />
        </Field>
        <Field label="要求（不可变）">
          <textarea
            className={`${inputClass} min-h-[88px] resize-y`}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="要做什么、做到什么程度算完"
          />
        </Field>
        <Field label="工作目录（可空）">
          <input className={inputClass} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="apps/electron" />
        </Field>
        <Field label="数据源（逗号分隔，可空）">
          <input className={inputClass} value={sources} onChange={(e) => setSources(e.target.value)} placeholder="github, linear" />
        </Field>
        <Field label="交付物（每行 kind:path）">
          <textarea
            className={`${inputClass} min-h-[60px] resize-y`}
            value={deliverables}
            onChange={(e) => setDeliverables(e.target.value)}
            placeholder={'file:docs/report.md\npr:https://…'}
          />
        </Field>
        <Field label="验收（每行 id|检查说明|命令）">
          <textarea
            className={`${inputClass} min-h-[60px] resize-y`}
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            placeholder={'a1|构建通过|bun run build\na2|测试全绿|bun test'}
          />
        </Field>
        <Field label="定时（5 段 cron，留空 = 手动）">
          <input className={inputClass} value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1" />
        </Field>
      </div>

      <div className="border-t border-border/50 px-4 py-3">
        <button
          type="button"
          className="inline-flex min-h-9 w-full items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={!name.trim() || !instruction.trim()}
          onClick={submit}
        >
          创建
        </button>
      </div>
    </div>
  )
}

const inputClass =
  'w-full rounded-md border border-border/70 bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
