/**
 * Agent (role profile) picker.
 *
 * Sits next to the strategy picker. It only changes what *new* sessions inherit
 * and what the next turn runs as; a supervisor session hides it entirely
 * (the supervisor's role is fixed at creation).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, UserRound } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface AgentOption {
  id: string
  name: string
  icon?: string
  /** One-line description shown under the name. */
  description?: string
  builtin?: boolean
}

export interface AgentSelectorProps {
  agents: AgentOption[]
  value: string
  onChange: (agentId: string) => void
  /** Hidden for supervisor sessions, which cannot change their role. */
  hidden?: boolean
  className?: string
}

export function AgentSelector({
  agents,
  value,
  onChange,
  hidden = false,
  className,
}: AgentSelectorProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  if (hidden) return null

  const current = agents.find((agent) => agent.id === value) ?? agents[0]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex max-w-[150px] items-center gap-1.5 rounded-md px-1.5 py-1 text-xs',
            'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            className,
          )}
          title={t('agent.selector.tooltip', { defaultValue: '这条会话使用的角色' })}
        >
          {current?.icon ? (
            <span className="text-sm leading-none">{current.icon}</span>
          ) : (
            <UserRound className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{current?.name ?? t('agent.selector.none', { defaultValue: '默认' })}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => {
              onChange(agent.id)
              setOpen(false)
            }}
            className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
          >
            <span className="mt-0.5 w-4 shrink-0">
              {agent.id === value ? <Check className="h-3.5 w-3.5" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                {agent.icon ? <span>{agent.icon}</span> : null}
                <span className="truncate text-sm">{agent.name}</span>
                {agent.builtin ? (
                  <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    {t('agent.selector.builtin', { defaultValue: '内置' })}
                  </span>
                ) : null}
              </span>
              {agent.description ? (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{agent.description}</span>
              ) : null}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
