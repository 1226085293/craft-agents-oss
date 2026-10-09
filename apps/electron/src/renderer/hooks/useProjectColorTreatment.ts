import { useEffect, useState } from 'react'
import {
  DEFAULT_PROJECT_COLOR_TREATMENT,
  type ProjectColorTreatment,
} from '@/utils/project-colors'
import { getAppearanceCache, initAppearance, updateAppearance } from '@/lib/appearance-bridge'

const STORAGE_EVENT = 'craft-project-color-treatment-changed'

function read(): ProjectColorTreatment {
  const value = getAppearanceCache()?.ui?.projectColorTreatment as ProjectColorTreatment | undefined
  return value === 'stripe-tint' ? 'stripe-tint' : value ?? DEFAULT_PROJECT_COLOR_TREATMENT
}

/**
 * Read the user's "project color treatment" appearance setting, and re-render
 * when it changes.
 *
 * Persisted in the unified appearance file (appearance.json). Updates propagate
 * within the same window via a custom event dispatched by
 * `setProjectColorTreatment`; across windows via the `appearance:changed`
 * bridge notification.
 */
export function useProjectColorTreatment(): ProjectColorTreatment {
  const [value, setValue] = useState<ProjectColorTreatment>(read)

  useEffect(() => {
    const refresh = () => setValue(read())
    void initAppearance().then(refresh)
    window.addEventListener(STORAGE_EVENT, refresh)
    return () => {
      window.removeEventListener(STORAGE_EVENT, refresh)
    }
  }, [])

  return value
}

/**
 * Persist the appearance setting and notify listeners in the current window.
 */
export function setProjectColorTreatment(value: ProjectColorTreatment): void {
  void updateAppearance((config) => ({
    ...config,
    ui: { ...config.ui, projectColorTreatment: value },
  }))
  window.dispatchEvent(new Event(STORAGE_EVENT))
}