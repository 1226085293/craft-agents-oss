import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

  // Load models for this connection
  useEffect(() => {
    if (!open || !connection) return
    
    const loadModels = async () => {
      setIsLoading(true)
      try {
        const conn = await window.electronAPI?.getLlmConnection(connection.slug)
        if (!conn) return
        
        const allModels = MODEL_REGISTRY
        const connectionModels = (conn.models || []).map(m => typeof m === 'string' ? m : m.id)
        
        // Filter to models for this provider
        const relevantModels = allModels.filter(m => 
          m.provider === connection.providerType || 
          connection.providerType === 'pi'
        )
        
        const modelList: ModelItem[] = relevantModels.map(m => ({
          id: m.id,
          name: m.name,
          enabled: !conn.enabledModels?.length || conn.enabledModels.includes(m.id),
        }))
        
        // Add custom models not in registry
        const existingIds = new Set(modelList.map(m => m.id))
        const customModels: ModelItem[] = connectionModels
          .filter(id => !existingIds.has(id))
          .map(id => ({ id, name: id, enabled: !conn.enabledModels?.length || conn.enabledModels.includes(id) }))
        
        setModels([...modelList, ...customModels])
      } catch (error) {
        console.error('Failed to load models:', error)
      } finally {
        setIsLoading(false)
      }
    }
    
    loadModels()
  }, [open, connection])

  const filteredModels = models.filter(m => 
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.id.toLowerCase().includes(search.toLowerCase())
  )

  const handleToggle = useCallback(async (modelId: string, enabled: boolean) => {
    if (!window.electronAPI) return
    const result = await window.electronAPI.toggleModel(connection.slug, modelId, enabled)
    if (result.success) {
      setModels(prev => prev.map(m => m.id === modelId ? { ...m, enabled } : m))
      onSuccess()
    } else {
      console.error('Failed to toggle model:', result.error)
    }
  }, [connection.slug, onSuccess])

  const handleAddCustom = useCallback(async () => {
    const modelId = prompt(t('settings.ai.model.addCustomId', { defaultValue: 'Enter model ID' }))
    if (!modelId?.trim()) return
    const modelName = prompt(t('settings.ai.model.addCustomName', { defaultValue: 'Enter model name' }), modelId.trim()) || modelId.trim()
    
    if (!window.electronAPI) return
    const result = await window.electronAPI.addCustomModel(connection.slug, { 
      id: modelId.trim(), 
      name: modelName.trim(),
    })
    if (result.success) {
      setModels(prev => [...prev, { id: modelId.trim(), name: modelName.trim(), enabled: true }])
      onSuccess()
    } else {
      alert(result.error || 'Failed to add model')
    }
  }, [connection.slug, onSuccess, t])

  const enabledCount = models.filter(m => m.enabled).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.ai.models.manage', { defaultValue: `Manage Models: ${connection.name}` })}</DialogTitle>
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
                        ? 'bg-primary text-primary-foreground' 
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
                  >
                    {model.enabled ? t('common.on', { defaultValue: 'On' }) : t('common.off', { defaultValue: 'Off' })}
                  </button>
                </div>
              ))
            )}
          </div>
          
          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-xs text-muted-foreground">
              {t('settings.ai.models.enabled', { enabled: enabledCount, total: models.length, defaultValue: '{{enabled}}/{{total}} enabled' })}
            </span>
            <button
              type="button"
              onClick={handleAddCustom}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
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
