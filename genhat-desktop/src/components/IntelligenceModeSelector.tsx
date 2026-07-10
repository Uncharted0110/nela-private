import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, Sparkles, Zap, Brain } from "lucide-react";
import type { IntelligenceMode } from "../app/intelligenceModes";
import { INTELLIGENCE_MODE_OPTIONS } from "../app/intelligenceModes";
import { COPY } from "../app/copy";
import "./IntelligenceModeSelector.css";

const MODE_ICONS: Record<IntelligenceMode, React.ElementType> = {
  fast: Zap,
  smart: Sparkles,
  deep: Brain,
};

interface IntelligenceModeSelectorProps {
  mode: IntelligenceMode | "custom";
  switching?: boolean;
  switchingLabel?: string;
  onSelectMode: (mode: IntelligenceMode) => void;
  onChooseSpecificModel: () => void;
}

const IntelligenceModeSelector: React.FC<IntelligenceModeSelectorProps> = ({
  mode,
  switching = false,
  switchingLabel = "",
  onSelectMode,
  onChooseSpecificModel,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const activeOption =
    mode === "custom"
      ? { label: COPY.intelligenceCustom, hint: COPY.intelligenceCustomHint }
      : INTELLIGENCE_MODE_OPTIONS.find((o) => o.key === mode) ?? INTELLIGENCE_MODE_OPTIONS[0];

  const CurrentIcon = mode === "custom" ? Sparkles : MODE_ICONS[mode as IntelligenceMode] ?? Zap;
  const buttonLabel = switching
    ? `Switching: ${switchingLabel.length > 22 ? `${switchingLabel.slice(0, 22)}…` : switchingLabel}`
    : activeOption.label;

  return (
    <div className="intelligence-selector-container" ref={containerRef} data-tour="intelligence-mode">
      <button
        type="button"
        className={`intelligence-selector-btn ${isOpen ? "active" : ""} ${switching ? "switching" : ""}`}
        onClick={() => {
          if (switching) return;
          setIsOpen((open) => !open);
        }}
        disabled={switching}
        title={switching ? switchingLabel : activeOption.hint}
      >
        {switching ? (
          <Loader2 size={16} className="animate-spin text-amber-400" />
        ) : (
          <CurrentIcon size={16} />
        )}
        <span className="intelligence-selector-label">{buttonLabel}</span>
        {!switching && <ChevronDown size={14} className="chevron" />}
      </button>

      {isOpen && !switching && (
        <div className="intelligence-dropdown">
          <div className="intelligence-dropdown-header">Intelligence</div>
          {INTELLIGENCE_MODE_OPTIONS.map((option) => {
            const Icon = MODE_ICONS[option.key];
            const active = mode === option.key;
            return (
              <button
                key={option.key}
                type="button"
                className={`intelligence-option ${active ? "selected" : ""}`}
                onClick={() => {
                  onSelectMode(option.key);
                  setIsOpen(false);
                }}
              >
                <Icon size={15} />
                <span className="intelligence-option-copy">
                  <span className="intelligence-option-label">{option.label}</span>
                  <span className="intelligence-option-hint">{option.hint}</span>
                </span>
              </button>
            );
          })}
          <div className="intelligence-dropdown-divider" />
          <button
            type="button"
            className="intelligence-specific-link"
            onClick={() => {
              onChooseSpecificModel();
              setIsOpen(false);
            }}
          >
            {COPY.intelligenceChooseModel}
          </button>
        </div>
      )}
    </div>
  );
};

export default IntelligenceModeSelector;
