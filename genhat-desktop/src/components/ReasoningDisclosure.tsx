import { useEffect, useRef, useState } from "react";
import "./ReasoningDisclosure.css";

interface ReasoningDisclosureProps {
  thinking: string;
  /** When true, expand by default and auto-scroll as tokens arrive. */
  streaming?: boolean;
}

/**
 * Cursor-style faded reasoning dropdown: live while streaming, collapsed when done.
 */
export default function ReasoningDisclosure({
  thinking,
  streaming = false,
}: ReasoningDisclosureProps) {
  const trimmed = thinking.trim();
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
  }, [thinking, streaming, expanded]);

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
          <pre ref={bodyRef} className="reasoning-disclosure__text">
            {trimmed}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
