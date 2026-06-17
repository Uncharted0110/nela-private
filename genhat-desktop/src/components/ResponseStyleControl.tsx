import React, { useMemo, useState } from "react";
import { Loader2, CheckCircle } from "lucide-react";
import { COPY } from "../app/copy";
import {
  inferStyle,
  RESPONSE_STYLE_OPTIONS,
  RESPONSE_STYLE_PRESETS,
  type ResponseStyle,
} from "../app/responseStylePresets";

interface ResponseStyleControlProps {
  /** Current params for the active model (to highlight the matching style). */
  currentParams?: Record<string, string>;
  /** Same apply path the advanced dock uses. Merges with existing params upstream. */
  onApply: (params: Record<string, string>) => Promise<void>;
  /** Only applies to text-generation (LlamaServer) models. */
  disabled?: boolean;
}

const ResponseStyleControl: React.FC<ResponseStyleControlProps> = ({
  currentParams,
  onApply,
  disabled = false,
}) => {
  const initial = useMemo(() => inferStyle(currentParams), [currentParams]);
  const [selected, setSelected] = useState<ResponseStyle>(initial);
  const [saving, setSaving] = useState<ResponseStyle | null>(null);
  const [savedStyle, setSavedStyle] = useState<ResponseStyle | null>(null);

  const choose = async (style: ResponseStyle) => {
    if (disabled || saving) return;
    setSelected(style);
    setSaving(style);
    try {
      await onApply(RESPONSE_STYLE_PRESETS[style]);
      setSavedStyle(style);
      window.setTimeout(() => setSavedStyle(null), 1600);
    } catch {
      /* keep UI calm; selection simply won't show the check */
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="p-3">
      <div className="text-[0.8rem] font-semibold text-txt mb-2">{COPY.responseStyleLabel}</div>
      <div role="radiogroup" aria-label={COPY.responseStyleLabel} className="flex flex-col gap-2">
        {RESPONSE_STYLE_OPTIONS.map((s) => {
          const active = selected === s.key;
          return (
            <button
              key={s.key}
              role="radio"
              aria-checked={active}
              aria-label={`${s.label}. ${s.hint}`}
              disabled={disabled || saving !== null}
              onClick={() => void choose(s.key)}
              className={[
                "w-full text-left rounded-xl border px-3 py-2.5 transition-all duration-150",
                "outline-none focus-visible:ring-2 focus-visible:ring-sky-300/50",
                active
                  ? "border-sky-400/50 bg-sky-400/10"
                  : "border-glass-border bg-void-700/50 hover:border-glass-border hover:bg-glass-hover",
                disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
              ].join(" ")}
            >
              <div className="flex items-center justify-between">
                <span className="text-[0.82rem] font-semibold text-txt">{s.label}</span>
                {saving === s.key ? (
                  <Loader2 size={14} className="animate-spin text-sky-300" />
                ) : savedStyle === s.key ? (
                  <CheckCircle size={14} className="text-emerald-300" />
                ) : null}
              </div>
              <div className="text-[0.78rem] text-txt-muted mt-0.5">{s.hint}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ResponseStyleControl;
