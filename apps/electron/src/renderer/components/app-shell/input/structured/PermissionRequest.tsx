import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, Check, X, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PermissionRequest as PermissionRequestType } from '../../../../../shared/types'
import type { PermissionResponse } from './types'

interface PermissionRequestProps {
  request: PermissionRequestType
  onResponse: (response: PermissionResponse) => void
  /** When true, removes container styling (shadow, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
}

/**
 * PermissionRequest - Self-contained structured input for permission approval
 *
 * Shows:
 * - Shield icon + "Permission Required" header
 * - Tool name badge
 * - Description of what the tool wants to do
 * - Command preview (scrollable)
 * - Action buttons: Allow, Always Allow, Deny
 */
const RISK_STYLES: Record<string, string> = {
  low: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  high: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  critical: 'bg-red-500/15 text-red-600 dark:text-red-400',
}

export function PermissionRequest({ request, onResponse, unstyled = false }: PermissionRequestProps) {
  const { t } = useTranslation()
  const [permanentDeny, setPermanentDeny] = React.useState(false)

  const handleAllow = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: false, sourcePermission: 'once' })
  }

  const handleSessionAllow = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: true, sourcePermission: 'session' })
  }

  const handleAlwaysAllow = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: true, sourcePermission: 'always' })
  }

  const handleDeny = () => {
    onResponse({
      type: 'permission',
      allowed: false,
      alwaysAllow: false,
      sourcePermission: permanentDeny ? 'deny-permanent' : 'deny',
    })
  }

  // 来源调用确认：显示源、工具、权限、数据范围、风险；文案区分“授权请求”与“单次确认”
  const isSourceCall = !!request.sourceSlug
  const isAuthorizationRequest = request.isAuthorizationRequest === true

  return (
    <div
      className={cn(
        'overflow-hidden h-full flex flex-col bg-info/5',
        unstyled
          ? 'border-0'
          : 'border border-info/30 rounded-[8px] shadow-middle'
      )}
      data-tutorial="permission-banner"
    >
      {/* Content - grows to fill available space and scrolls before actions disappear */}
      <div className="p-4 space-y-3 flex-1 min-h-0 flex flex-col overflow-y-auto">
        <div className="space-y-2 pb-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <ShieldAlert className="h-3.5 w-3.5 text-info" />
            <span>{t('chat.permissionRequired')}</span>
          </div>
          <div className="text-xs leading-[18px] text-muted-foreground">
            <span className="font-medium text-foreground">Tool:</span> {request.toolName}
            <br />
            {request.description}
          </div>

          {isSourceCall && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              {request.sourceName && (
                <span className="rounded bg-foreground/8 px-1.5 py-0.5 font-medium text-foreground/80">
                  {request.sourceName}
                </span>
              )}
              {request.requiredPermission && (
                <span className="rounded bg-foreground/8 px-1.5 py-0.5 text-foreground/60">
                  {request.requiredPermission}
                </span>
              )}
              {request.dataScope && (
                <span className="rounded bg-foreground/8 px-1.5 py-0.5 text-foreground/60">
                  {request.dataScope}
                </span>
              )}
              {request.sourceRisk && (
                <span className={cn('rounded px-1.5 py-0.5 font-medium', RISK_STYLES[request.sourceRisk] ?? 'bg-foreground/8')}>
                  {request.sourceRisk}
                </span>
              )}
              {isAuthorizationRequest && (
                <span className="rounded bg-info/10 px-1.5 py-0.5 font-medium text-info">
                  Authorization request
                </span>
              )}
            </div>
          )}
        </div>

        {/* Command preview */}
        {request.command && (
          <div className="bg-foreground/5 rounded-md p-3 font-mono text-xs text-foreground/90 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
            {request.command}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-t border-border/50">
        <Button
          size="sm"
          variant="default"
          className="h-7 gap-1.5"
          onClick={handleAllow}
          data-tutorial="permission-allow-button"
        >
          <Check className="h-3.5 w-3.5" />
          {isSourceCall ? (isAuthorizationRequest ? 'Authorize once' : 'Allow once') : 'Allow'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5 active:bg-foreground/10"
          onClick={handleSessionAllow}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {isSourceCall ? 'Allow this session' : 'Allow session'}
        </Button>
        {isSourceCall && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5 active:bg-foreground/10"
              onClick={handleAlwaysAllow}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Always Allow
            </Button>
            <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                checked={permanentDeny}
                onChange={(e) => setPermanentDeny(e.target.checked)}
                className="h-3 w-3"
              />
              Permanent
            </label>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-destructive hover:text-destructive border border-dashed border-destructive/50 hover:bg-destructive/10 hover:border-destructive/70 active:bg-destructive/20"
          onClick={handleDeny}
        >
          <X className="h-3.5 w-3.5" />
          Deny
        </Button>

        {/* Tip text */}
        <span className="min-w-0 flex-1 basis-full text-[10px] text-muted-foreground sm:basis-auto sm:text-right">
          {isSourceCall
            ? '“Always Allow” persists this tool permission; Permanent + Deny blocks it permanently'
            : '"Always Allow" remembers this command for the session'}
        </span>
      </div>
    </div>
  )
}
