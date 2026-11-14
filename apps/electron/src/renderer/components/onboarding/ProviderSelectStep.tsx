import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Settings2 } from "lucide-react"
import { CraftAgentsSymbol } from "@/components/icons/CraftAgentsSymbol"
import { StepFormLayout } from "./primitives"

interface ProviderSelectStepProps {
  /**
   * Open the LLM settings page.
   *
   * The wizard no longer offers a choice of provider here. Every provider it used to list
   * (Claude / ChatGPT / Copilot / API key / local) is now configured in one place — Settings →
   * LLM gateway — and duplicating that list in the welcome flow meant two code paths writing the
   * same connection records, one of which was already out of date. So this screen has exactly one
   * action: take the person to the real settings page.
   */
  onOpenLlmSettings: () => void
}

/**
 * ProviderSelectStep — first screen after install.
 *
 * One card, one button. It used to be five cards (Claude, ChatGPT, GitHub Copilot, other
 * provider, local model), each of which opened its own credential sub-flow; the LLM gateway
 * settings page supersedes all of them.
 */
export function ProviderSelectStep({ onOpenLlmSettings }: ProviderSelectStepProps) {
  const { t } = useTranslation()

  return (
    <StepFormLayout
      iconElement={
        <div className="flex size-16 items-center justify-center">
          <CraftAgentsSymbol className="size-10 text-accent" />
        </div>
      }
      title={t("onboarding.providerSelect.title")}
      description={t("onboarding.providerSelect.description")}
    >
      {/* Same card shape the provider options used, so the screen reads the same — one row now
          instead of five. */}
      <button
        onClick={onOpenLlmSettings}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl bg-foreground-2 p-3 text-left transition-all",
          "sm:items-start sm:gap-4 sm:p-4",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "hover:bg-foreground/[0.02] shadow-minimal",
        )}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Settings2 className="size-5" />
        </div>

        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm">{t("onboarding.providerSelect.openLlmSettings")}</span>
          <p className="mt-0 hidden sm:block text-xs text-muted-foreground">
            {t("onboarding.providerSelect.openLlmSettingsDesc")}
          </p>
        </div>
      </button>
    </StepFormLayout>
  )
}
