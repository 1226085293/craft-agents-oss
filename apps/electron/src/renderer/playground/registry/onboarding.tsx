import type { ComponentEntry } from './types'
import { OnboardingFlowDemo } from '../demos/OnboardingFlowDemo'
import { ProviderSelectStep } from '@/components/onboarding/ProviderSelectStep'
import { WelcomeStep } from '@/components/onboarding/WelcomeStep'
import { CompletionStep } from '@/components/onboarding/CompletionStep'
import { GitBashWarning, type GitBashStatus } from '@/components/onboarding/GitBashWarning'
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard'
import type { OnboardingState } from '@/components/onboarding/OnboardingWizard'

const createOnboardingState = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({
  step: 'welcome',
  loginStatus: 'idle',
  completionStatus: 'complete',
  isExistingUser: false,
  gitBashStatus: { found: false, path: null, platform: 'win32' },
  isRecheckingGitBash: false,
  isCheckingGitBash: false,
  ...overrides,
})

const noopHandler = () => console.log('[Playground] Action triggered')

export const onboardingComponents: ComponentEntry[] = [
  {
    id: 'onboarding-flow-demo',
    name: 'Onboarding Flow (Interactive)',
    category: 'Onboarding',
    description: 'Click through the full onboarding: Welcome → Provider → Credentials → Done',
    component: OnboardingFlowDemo,
    props: [],
    variants: [],
    layout: 'full',
  },
  {
    id: 'provider-select-step',
    name: 'ProviderSelectStep',
    category: 'Onboarding',
    description: 'First-launch screen — pick your subscription or API key',
    component: ProviderSelectStep,
    props: [],
    variants: [],
    mockData: () => ({
      onSelect: (choice: string) => console.log('[Playground] Provider selected:', choice),
      onSkip: () => console.log('[Playground] Setup deferred'),
    }),
  },
  {
    id: 'welcome-step',
    name: 'WelcomeStep',
    category: 'Onboarding',
    description: 'Initial welcome screen with feature overview',
    component: WelcomeStep,
    props: [
      {
        name: 'isExistingUser',
        description: 'Show update settings message instead of welcome',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'isLoading',
        description: 'Show loading state on continue button',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'New User', props: { isExistingUser: false } },
      { name: 'Existing User', props: { isExistingUser: true } },
      { name: 'Loading', props: { isLoading: true } },
    ],
    mockData: () => ({
      onContinue: noopHandler,
    }),
  },
  {
    id: 'completion-step',
    name: 'CompletionStep',
    category: 'Onboarding',
    description: 'Success screen after completing onboarding',
    component: CompletionStep,
    props: [
      {
        name: 'status',
        description: 'Completion status',
        control: {
          type: 'select',
          options: [
            { label: 'Saving', value: 'saving' },
            { label: 'Complete', value: 'complete' },
          ],
        },
        defaultValue: 'complete',
      },
    ],
    variants: [
      { name: 'Saving', props: { status: 'saving' } },
      { name: 'Complete', props: { status: 'complete' } },
    ],
    mockData: () => ({
      onFinish: noopHandler,
    }),
  },
  {
    id: 'git-bash-warning',
    name: 'GitBashWarning',
    category: 'Onboarding',
    description: 'Warning screen when Git Bash is not found on Windows',
    component: GitBashWarning,
    props: [
      {
        name: 'isRechecking',
        description: 'Show loading state on re-check button',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Not Found',
        props: {
          status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
        },
      },
      {
        name: 'Rechecking',
        props: {
          status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
          isRechecking: true,
        },
      },
      {
        name: 'With Suggested Path',
        props: {
          status: { found: false, path: 'C:\\Program Files\\Git\\bin\\bash.exe', platform: 'win32' } as GitBashStatus,
        },
      },
      {
        name: 'With Error',
        props: {
          status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
          errorMessage: 'File does not exist at the specified path',
        },
      },
    ],
    mockData: () => ({
      status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
      onBrowse: async () => {
        console.log('[Playground] Browse clicked')
        return 'C:\\Program Files\\Git\\bin\\bash.exe'
      },
      onUsePath: (path: string) => console.log('[Playground] Use path:', path),
      onRecheck: noopHandler,
      onBack: noopHandler,
      onClearError: noopHandler,
    }),
  },
  {
    id: 'onboarding-wizard',
    name: 'OnboardingWizard',
    category: 'Onboarding',
    description: 'Full-screen onboarding flow container with all steps',
    component: OnboardingWizard,
    props: [],
    variants: [
      {
        name: 'Welcome (New User)',
        props: {
          state: createOnboardingState({ step: 'welcome', isExistingUser: false }),
        },
      },
      {
        name: 'Welcome (Existing User)',
        props: {
          state: createOnboardingState({ step: 'welcome', isExistingUser: true }),
        },
      },
      {
        name: 'Git Bash Warning',
        props: {
          state: createOnboardingState({ step: 'git-bash' }),
        },
      },
      {
        name: 'Git Bash Warning (Rechecking)',
        props: {
          state: createOnboardingState({ step: 'git-bash', isRecheckingGitBash: true }),
        },
      },
      {
        name: 'Complete - Saving',
        props: {
          state: createOnboardingState({ step: 'complete', completionStatus: 'saving' }),
        },
      },
      {
        name: 'Complete - Done',
        props: {
          state: createOnboardingState({
            step: 'complete',
            completionStatus: 'complete',
          }),
        },
      },
    ],
    mockData: () => ({
      state: createOnboardingState(),
      className: 'min-h-0 h-full',
      onContinue: noopHandler,
      onBack: noopHandler,
      onSelectApiSetupMethod: (method: string) => console.log('[Playground] Selected method:', method),
      onSubmitCredential: (data: { apiKey: string; baseUrl?: string; connectionDefaultModel?: string; models?: string[] }) => console.log('[Playground] Submitted:', data),
      onFinish: noopHandler,
      onBrowseGitBash: async () => {
        console.log('[Playground] Browse Git Bash clicked')
        return 'C:\\Program Files\\Git\\bin\\bash.exe'
      },
      onUseGitBashPath: (path: string) => console.log('[Playground] Use Git Bash path:', path),
      onRecheckGitBash: noopHandler,
      onClearError: noopHandler,
      onSkipSetup: () => console.log('[Playground] Setup deferred'),
    }),
  },
]
