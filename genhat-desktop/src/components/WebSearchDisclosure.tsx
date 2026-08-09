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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Collapsible “Searched the web” line with shaded sources panel —
 * Gemini-style: favicon stack when collapsed, image strip + favicon
 * source cards when expanded.
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

  const favicons = result.results
    .map((h) => h.favicon)
    .filter((f): f is string => Boolean(f))
    .slice(0, 5);

  const images = (result.images ?? []).slice(0, 8);

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
        {favicons.length > 0 && (
          <span className="web-search-disclosure__favicons" aria-hidden>
            {favicons.map((f, i) => (
              <img
                key={`${f}-${i}`}
                src={f}
                alt=""
                loading="lazy"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ))}
          </span>
        )}
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
          {images.length > 0 && (
            <div className="web-search-disclosure__images">
              {images.map((img, i) => (
                <button
                  key={`${img}-${i}`}
                  type="button"
                  className="web-search-disclosure__image"
                  onClick={() => void openUrl(img)}
                  title={img}
                >
                  <img
                    src={img}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      const btn = (e.target as HTMLImageElement).closest(
                        "button"
                      );
                      if (btn) btn.style.display = "none";
                    }}
                  />
                </button>
              ))}
            </div>
          )}
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
                  <span className="web-search-disclosure__hit-head">
                    {hit.favicon ? (
                      <img
                        className="web-search-disclosure__hit-favicon"
                        src={hit.favicon}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.visibility =
                            "hidden";
                        }}
                      />
                    ) : (
                      <Globe
                        size={12}
                        strokeWidth={2}
                        className="web-search-disclosure__hit-favicon-fallback"
                      />
                    )}
                    <span className="web-search-disclosure__hit-title">
                      {hit.title || hit.url}
                    </span>
                    <span className="web-search-disclosure__hit-host">
                      {hostOf(hit.url)}
                    </span>
                  </span>
                  {hit.snippet ? (
                    <span className="web-search-disclosure__hit-snippet">
                      {hit.snippet}
                    </span>
                  ) : null}
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
