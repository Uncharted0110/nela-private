import React, { useState } from "react";
import { ChevronDown, Globe } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { WebSearchResult } from "../types";
import "./WebSearchDisclosure.css";

interface WebSearchDisclosureProps {
  result: WebSearchResult;
  /** Start expanded (default collapsed, Cursor-style). */
  defaultOpen?: boolean;
}

/**
 * Collapsible “Searched the web” line with shaded sources panel —
 * similar to Cursor / Gemini / Claude search disclosures.
 */
const WebSearchDisclosure: React.FC<WebSearchDisclosureProps> = ({
  result,
  defaultOpen = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  if (!result.results.length) return null;

  const queries =
    result.queries?.filter((q) => q.trim()) ??
    (result.query ? [result.query] : []);
  const count = result.results.length;
  const summary =
    queries.length === 1
      ? `Searched “${queries[0]}”`
      : queries.length > 1
        ? `Searched the web · ${queries.length} queries`
        : `Searched the web · ${count} source${count === 1 ? "" : "s"}`;

  return (
    <div className={`web-search-disclosure ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="web-search-disclosure__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Globe size={13} strokeWidth={2} className="web-search-disclosure__icon" />
        <span className="web-search-disclosure__label">{summary}</span>
        <span className="web-search-disclosure__meta">
          {count} source{count === 1 ? "" : "s"}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2}
          className="web-search-disclosure__chevron"
        />
      </button>

      {open && (
        <div className="web-search-disclosure__panel">
          {queries.length > 1 && (
            <ul className="web-search-disclosure__queries">
              {queries.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}
          <ul className="web-search-disclosure__hits">
            {result.results.map((hit, i) => (
              <li key={`${hit.url}-${i}`}>
                <button
                  type="button"
                  className="web-search-disclosure__hit"
                  title={hit.url}
                  onClick={() => {
                    void openUrl(hit.url);
                  }}
                >
                  <span className="web-search-disclosure__hit-title">
                    {hit.title || hit.url}
                  </span>
                  {hit.snippet ? (
                    <span className="web-search-disclosure__hit-snippet">
                      {hit.snippet}
                    </span>
                  ) : null}
                  <span className="web-search-disclosure__hit-url">{hit.url}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default WebSearchDisclosure;
