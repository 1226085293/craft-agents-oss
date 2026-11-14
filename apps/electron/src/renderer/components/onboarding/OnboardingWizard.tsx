import { cn } from "@/lib/utils"
import { WelcomeStep } from "./WelcomeStep"
import { ProviderSelectStep } from "./ProviderSelectStep"
import { CompletionStep } from "./CompletionStep"
import { GitBashWarning, type GitBashStatus } from "./GitBashWarning"

/**
 * Steps the welcome flow can be on.
 *
 * `credentials` and `local-model` used to be here: the wizard collected an API key or a local
 * endpoint itself. Both screens are gone — connection setup lives in Settings → LLM gateway, and
 * the welcome flow reaches it through `onOpenLlmSettings`. Leaving the two values in the union
 * would have kept a state the flow can no longer enter.
 */
export type OnboardingStep =
  | 'welcome'
  | 'git-bash'
  | 'provider-select'
  | 'complete'

export type LoginStatus = 'idle' | 'waiting' | 'success' | 'error'

export interface OnboardingState {
  step: OnboardingStep
  loginStatus: LoginStatus
  completionStatus: 'saving' | 'complete'
  isExistingUser: boolean
  errorMessage?: string
  gitBashStatus?: GitBashStatus
  isRecheckingGitBash?: boolean
  isCheckingGitBash?: boolean
}

interface OnboardingWizardProps {
  /** Current state of the wizard */
  state: OnboardingState

  // Event handlers
  onContinue: () => void
  onBack: () => void
  onFinish: () => void

  // Git Bash (Windows)
  onBrowseGitBash?: () => Promise<string | null>
  onUseGitBashPath?: (path: string) => void
  onRecheckGitBash?: () => void
  onClearError?: () => void

  /** Open Settings → LLM gateway (the only connection-setup path the flow has) */
  onOpenLlmSettings?: () => void

  className?: string
}

/**
 * OnboardingWizard - Full-screen onboarding flow container
 *
 * 1. Welcome
 * 2. Git Bash (Windows only)
 * 3. Provider select — a single card that opens LLM settings
 * 4. Completion
 */
export function OnboardingWizard({
  state,
  onContinue,
  onBack,
  onFinish,
  // Git Bash (Windows)
  onBrowseGitBash,
  onUseGitBashPath,
  onRecheckGitBash,
  onClearError,
  // Provider select
  onOpenLlmSettings,
  className
}: OnboardingWizardProps) {
  const renderStep = () => {
    switch (state.step) {
      case 'welcome':
        return (
          <WelcomeStep
            isExistingUser={state.isExistingUser}
            onContinue={onContinue}
            isLoading={state.isCheckingGitBash}
          />
        )

      case 'git-bash':
        return (
          <GitBashWarning
            status={state.gitBashStatus!}
            onBrowse={onBrowseGitBash!}
            onUsePath={onUseGitBashPath!}
            onRecheck={onRecheckGitBash!}
            onBack={onBack}
            isRechecking={state.isRecheckingGitBash}
            errorMessage={state.errorMessage}
            onClearError={onClearError}
          />
        )

      case 'provider-select':
        return <ProviderSelectStep onOpenLlmSettings={onOpenLlmSettings!} />

      case 'complete':
        return (
          <CompletionStep
            status={state.completionStatus}
            onFinish={onFinish}
          />
        )

      default:
        return null
    }
  }

  return (
    <div
      className={cn(
        "bg-foreground-2 overflow-y-auto",
        !className?.includes('h-full') && "h-dvh",
        className
      )}
    >
      {/* Draggable title bar region for transparent window (macOS) */}
      <div className="titlebar-drag-region fixed top-0 left-0 right-0 h-[50px] z-titlebar" />

      {/* Main content — min-h-full + flex center means: center when content fits,
          natural flow + scroll when content is taller than the viewport (mobile). */}
      <main className="flex min-h-full items-center justify-center p-4 sm:p-8">
        {renderStep()}
      </main>
    </div>
  )
}
