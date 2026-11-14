/**
 * OnboardingFlowDemo — Interactive walkthrough of the onboarding flow.
 *
 * Manages its own state so you can click through the sequence in the playground without needing
 * real IPC.
 *
 * Flow: WelcomeStep → ProviderSelectStep → CompletionStep
 *
 * The credential and local-model screens used to sit between provider-select and completion.
 * They are gone: connection setup is Settings → LLM gateway now, and the welcome flow opens that
 * page instead of collecting a key itself.
 */
import { useState, useCallback, useEffect } from 'react'
import { ensureMockElectronAPI } from '../mock-utils'
import { WelcomeStep } from '@/components/onboarding/WelcomeStep'
import { ProviderSelectStep } from '@/components/onboarding/ProviderSelectStep'
import { CompletionStep } from '@/components/onboarding/CompletionStep'

type DemoStep = 'welcome' | 'provider-select' | 'complete'

export function OnboardingFlowDemo() {
  useEffect(() => { ensureMockElectronAPI() }, [])

  const [step, setStep] = useState<DemoStep>('welcome')

  // In the real app this opens Settings → LLM gateway. The demo advances so the rest of the
  // sequence stays previewable.
  const handleOpenLlmSettings = useCallback(() => {
    setStep('complete')
  }, [])

  const handleRestart = useCallback(() => {
    setStep('welcome')
  }, [])

  const STEP_ORDER: { key: DemoStep; label: string }[] = [
    { key: 'welcome', label: 'Welcome' },
    { key: 'provider-select', label: 'Provider' },
    { key: 'complete', label: 'Done' },
  ]

  const currentIndex = STEP_ORDER.findIndex(s => s.key === step)

  return (
    <div className="flex flex-col h-full">
      {/* Step indicator bar */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-foreground/[0.03] border-b border-border">
        <div className="flex items-center gap-1 text-xs">
          {STEP_ORDER.map((s, i) => (
            <span key={s.key} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/40 mx-1">→</span>}
              <span
                className={
                  i === currentIndex
                    ? 'font-semibold text-foreground'
                    : i < currentIndex
                      ? 'text-muted-foreground'
                      : 'text-muted-foreground/40'
                }
              >
                {s.label}
              </span>
            </span>
          ))}
        </div>
        <button
          onClick={handleRestart}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-foreground/5"
        >
          Restart
        </button>
      </div>

      {/* Step content */}
      <div className="flex-1 flex items-center justify-center p-8 bg-foreground-2 overflow-auto">
        {step === 'welcome' && (
          <WelcomeStep
            isExistingUser={false}
            onContinue={() => setStep('provider-select')}
          />
        )}

        {step === 'provider-select' && (
          <ProviderSelectStep onOpenLlmSettings={handleOpenLlmSettings} />
        )}

        {step === 'complete' && (
          <CompletionStep
            status="complete"
            onFinish={handleRestart}
          />
        )}
      </div>
    </div>
  )
}
