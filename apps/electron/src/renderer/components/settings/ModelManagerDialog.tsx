import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { MODEL_REGISTRY } from '@config/models'
import type { LlmConnection } from '@craft-agent/shared/config'

interface ModelManagerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection: LlmConnection
  onSuccess: () => void
}

interface ModelItem {
  id: string
  name: string
  enabled: boolean
}

export function ModelManagerDialog({ open, onOpenChange, connection, onSuccess }: ModelManagerDialogProps) {
  const { t } = useTranslation()
  const [models, setModels] = useState<ModelItem[]>([])
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [customId, setCustomId] = useState('')
  const [customName, setCustomName] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Load models for this connection
  useEffect(() => {
    if (!open || !connection) return

    let cancelled = false
    const loadModels = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const conn = await window.electronAPI.getLlmConnection(connection.slug)
        if (!conn || cancelled) return

        const allModels = MODEL_REGISTRY
        const connectionModels = (conn.models || []).map(m => typeof m === 'string' ? m : m.id)

        // Filter to models for this provider
        const relevantModels = allModels.filter(m =>
          m.provider === connection.providerType ||
          connection.providerType === 'pi'
        )

        // Empty allowlist means "everything is enabled" — mirror the server-side
        // semantics so the toggles reflect what the picker actually offers.
        const allowlist = conn.enabledModels?.length ? new Set(conn.enabledModels) : null
        const isEnabled = (id: string) => !allowlist || allowlist.has(id)

        const modelList: ModelItem[] = relevantModels.map(m => ({
          id: m.id,
          name: m.name,
          enabled: isEnabled(m.id),
        }))

        // Add custom models not in registry
        const existingIds = new Set(modelList.map(m => m.id))
        const customModels: ModelItem[] = connectionModels
          .filter(id => !existingIds.has(id))
          .map(id => ({ id, name: id, enabled: isEnabled(id) }))

        setModels([...modelList, ...customModels])
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    loadModels()
    return () => { cancelled = true }
  }, [open, connection])

  useEffect(() => {
    if (!open) {
      setShowAddForm(false)
      setCustomId('')
      setCustomName('')
      setError(null)
    }
  }, [open])

  const filteredModels = models.filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.id.toLowerCase().includes(search.toLowerCase())
  )

  const handleToggle = useCallback(async (modelId: string, enabled: boolean) => {
    setError(null)
    // Optimistic — revert if the server rejects.
    setModels(prev => prev.map(m => m.id === modelId ? { ...m, enabled } : m))
    try {
      const result = await window.electronAPI.toggleModel(connection.slug, modelId, enabled)
      if (!result.success) {
        setModels(prev => prev.map(m => m.id === modelId ? { ...m, enabled: !enabled } : m))
        setError(result.error || t('settings.ai.models.toggleFailed', { defaultValue: 'Failed to update model' }))
        return
      }
      onSuccess()
    } catch (err) {
      setModels(prev => prev.map(m => m.id === modelId ? { ...m, enabled: !enabled } : m))
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [connection.slug, onSuccess, t])

  const handleAddCustom = useCallback(async () => {
    const id = customId.trim()
    if (!id) return
    setError(null)
    setIsAdding(true)
    try {
      const result = await window.electronAPI.addCustomModel(connection.slug, {
        id,
        name: customName.trim() || id,
      })
      if (!result.success) {
        setError(result.error || t('settings.ai.models.addFailed', { defaultValue: 'Failed to add model' }))
        return
      }
      setModels(prev => prev.some(m => m.id === id)
        ? prev.map(m => m.id === id ? { ...m, name: customName.trim() || id, enabled: true } : m)
        : [...prev, { id, name: customName.trim() || id, enabled: true }])
      setCustomId('')
      setCustomName('')
      setShowAddForm(false)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsAdding(false)
    }
  }, [connection.slug, customId, customName, onSuccess, t])

  const enabledCount = models.filter(m => m.enabled).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.ai.models.manage', { connectionName: connection.name, defaultValue: `Manage Models: ${connection.name}` })}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <input
            type="text"
            placeholder={t('settings.ai.models.search', { defaultValue: 'Search models...' })}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
          />

          {/* Model list */}
          <div className="max-h-64 overflow-y-auto space-y-1">
            {isLoading ? (
              <div className="text-sm text-muted-foreground py-4 text-center">{t('common.loading')}</div>
            ) : filteredModels.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center">{t('settings.ai.models.noModels', { defaultValue: 'No models found' })}</div>
            ) : (
              filteredModels.map(model => (
                <div key={model.id} className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-muted/50">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{model.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{model.id}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle(model.id, !model.enabled)}
                    className={`ml-3 px-3 py-1 text-xs rounded-md transition-colors ${
                      model.enabled
                        ? 'bg-foreground text-background'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
                  >
                    {model.enabled ? t('common.on', { defaultValue: 'On' }) : t('common.off', { defaultValue: 'Off' })}
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Add custom model */}
          {showAddForm ? (
            <div className="space-y-2 rounded-md border border-border p-2">
              <Input
                value={customId}
                onChange={e => setCustomId(e.target.value)}
                placeholder={t('settings.ai.model.addCustomId', { defaultValue: 'Model ID (e.g. gpt-4o-mini)' })}
                className="h-8 text-xs"
                autoFocus
              />
              <Input
                value={customName}
                onChange={e => setCustomName(e.target.value)}
                placeholder={t('settings.ai.model.addCustomName', { defaultValue: 'Display name (optional)' })}
                className="h-8 text-xs"
                onKeyDown={(e) => e.key === 'Enter' && handleAddCustom()}
              />
              <div className="flex gap-1 justify-end">
                <button
                  type="button"
                  onClick={() => { setShowAddForm(false); setCustomId(''); setCustomName('') }}
                  className="px-3 py-1.5 text-xs rounded-md text-muted-foreground hover:bg-muted transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleAddCustom}
                  disabled={isAdding || !customId.trim()}
                  className="px-3 py-1.5 text-xs rounded-md bg-foreground text-background disabled:opacity-50 transition-colors"
                >
                  {t('common.add', { defaultValue: 'Add' })}
                </button>
              </div>
            </div>
          ) : null}

          {error && (
            <div className="text-xs text-destructive">{error}</div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-xs text-muted-foreground">
              {t('settings.ai.models.enabled', { enabled: enabledCount, total: models.length, defaultValue: '{{enabled}}/{{total}} enabled' })}
            </span>
            <button
              type="button"
              onClick={() => setShowAddForm(prev => !prev)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
            >
              <span>+</span>
              <span>{t('settings.ai.models.addCustom', { defaultValue: 'Add Custom' })}</span>
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
