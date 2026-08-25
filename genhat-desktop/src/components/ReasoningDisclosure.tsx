import { useEffect, useRef, useState, useMemo } from "react";
import { windowThinkingForUi } from "../app/thinkingUiWindow";
import "./ReasoningDisclosure.css";

interface ReasoningDisclosureProps {
  thinking: string;
  /** When true, expand by default and auto-scroll as tokens arrive. */
  streaming?: boolean;
}

/**
 * Cursor-style faded reasoning dropdown: live while streaming, collapsed when done.
 * Only the last THINKING_UI_MAX_CHARS are mounted in the DOM to avoid freezes.
 */
export default function ReasoningDisclosure({
  thinking,
  streaming = false,
}: ReasoningDisclosureProps) {
  const trimmed = thinking.trim();
  const display = useMemo(() => windowThinkingForUi(trimmed), [trimmed]);
  const truncated = display !== trimmed && trimmed.length > 0;
  const [expanded, setExpanded] = useState(streaming);
  const [prevStreaming, setPrevStreaming] = useState(streaming);
  const bodyRef = useRef<HTMLPreElement>(null);
  if (prevStreaming !== streaming) {
    setPrevStreaming(streaming);
    setExpanded(streaming);
  }

  useEffect(() => {
    if (!streaming || !expanded) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [display, streaming, expanded]);

  if (!trimmed) return null;

  const label = streaming ? "Thinking" : "Thought";

  return (
    <div className="reasoning-disclosure">
      <button
        type="button"
        className="reasoning-disclosure__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <svg
          className={`reasoning-disclosure__chevron${expanded ? " reasoning-disclosure__chevron--open" : ""}`}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
        >
          <path
            d="M6 3.5L10.5 8L6 12.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="reasoning-disclosure__label">{label}</span>
        {streaming ? <span className="reasoning-disclosure__pulse" aria-hidden /> : null}
      </button>
      {expanded ? (
        <div
          className={`reasoning-disclosure__body${streaming ? "" : " reasoning-disclosure__body--complete"}`}
        >
          {truncated ? (
            <p className="reasoning-disclosure__truncated" aria-hidden>
              Showing latest thinking…
            </p>
          ) : null}
          <pre ref={bodyRef} className="reasoning-disclosure__text">
            {display}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
