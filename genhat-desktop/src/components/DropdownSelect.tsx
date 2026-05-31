import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";
import "./ModelSelector.css";

export function DropdownSelect({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (val: string) => void;
  options: { label: string; value: string }[];
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const currentLabel = options.find((o) => o.value === value)?.label || value;

  return (
    <div className="relative model-selector-container w-full" ref={containerRef}>
      <button
        type="button"
        className={`model-selector-btn ${isOpen ? "active" : ""} w-full h-[30px] rounded-lg bg-white/5 border-white/15 px-2.5 hover:bg-white/10 ${className || ""}`}
        onClick={() => setIsOpen(!isOpen)}
        style={{
          justifyContent: "space-between",
          minWidth: 0,
          padding: "5px 10px",
          borderColor: "rgba(255,255,255,0.15)",
          borderWidth: 1,
        }}
      >
        <span className="text-xs truncate font-normal">{currentLabel}</span>
        <ChevronDown size={12} className="chevron text-txt-muted shrink-0 ml-2" />
      </button>

      {isOpen && (
        <div className="model-dropdown absolute w-full mt-1 z-[200] left-0">
          <div className="model-list max-h-[200px] overflow-y-auto">
            {options.map((o) => (
              <div
                key={o.value}
                className={`model-item ${value === o.value ? "selected" : ""}`}
                onClick={() => {
                  onChange(o.value);
                  setIsOpen(false);
                }}
              >
                <span className="truncate flex-1">{o.label}</span>
                {value === o.value && (
                  <Check size={14} className="check-icon shrink-0 ml-2" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
