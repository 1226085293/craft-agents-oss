// Shared primitives for building step components
export {
  StepIcon,
  StepHeader,
  StepFormLayout,
  StepActions,
  BackButton,
  ContinueButton,
  type StepIconVariant,
} from './primitives'

// Individual steps
export { ProviderSelectStep } from './ProviderSelectStep'
export { WelcomeStep } from './WelcomeStep'
export { CompletionStep } from './CompletionStep'
export { ReauthScreen } from './ReauthScreen'
export { GitBashWarning, type GitBashStatus } from './GitBashWarning'

// Connection-setup vocabulary. The screens that collected it are gone (Settings → LLM gateway
// owns that now) but `useOnboarding` still describes a connection this way when saving one.
export type {
  ApiSetupMethod,
  ApiKeySubmitData,
  LocalModelSubmitData,
} from './apisetup-types'
export { apiSetupMethodToConnectionTypes } from './apisetup-types'

// Main wizard container
export { OnboardingWizard, type OnboardingState, type OnboardingStep, type LoginStatus } from './OnboardingWizard'

// Re-export all types for convenient import
export type {
  OnboardingStep as OnboardingStepType,
  OnboardingState as OnboardingStateType,
} from './OnboardingWizard'

export type {
  ApiSetupMethod as ApiSetupMethodType,
} from './apisetup-types'
