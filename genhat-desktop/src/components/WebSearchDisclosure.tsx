import React, { useState } from "react";
import { ChevronDown, FileText, Globe } from "lucide-react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Api } from "../api";
import type { WebSearchResult } from "../types";
import {
  fileUrlToPath,
  isLocalFileHitUrl,
} from "../app/send/fileSearchCitations";
import "./WebSearchDisclosure.css";

interface WebSearchDisclosureProps {
  result: WebSearchResult;
  /** Start expanded (default collapsed, Cursor-style). */
  defaultOpen?: boolean;
}

function hostOf(url: string): string {
  if (isLocalFileHitUrl(url)) return "Local file";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function openHit(url: string): Promise<void> {
  if (isLocalFileHitUrl(url)) {
    const path = fileUrlToPath(url);
    try {
      await openPath(path);
    } catch (openErr) {
      console.error("Failed to open local file:", openErr);
      await Api.revealInExplorer(path).catch((err) =>
        console.error("Failed to reveal local path:", err)
      );
    }
    return;
  }
  await openUrl(url);
}

/**
 * Collapsible sources line with shaded panel — web and/or local file hits
 * from tool rounds (web_search + search_knowledge_base).
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
  const localCount = result.results.filter((h) => isLocalFileHitUrl(h.url)).length;
  const webCount = count - localCount;
  const onlyLocal = localCount > 0 && webCount === 0;
  const onlyWeb = webCount > 0 && localCount === 0;

  const summary =
    result.citationKind === "attached" || (onlyLocal && !queries.length)
      ? `Used ${count} attached file${count === 1 ? "" : "s"}`
      : onlyLocal
        ? queries.length === 1
          ? `Searched files for “${queries[0]}”`
          : `Searched your files · ${count} source${count === 1 ? "" : "s"}`
        : queries.length === 1
          ? `Searched “${queries[0]}”`
          : queries.length > 1
            ? `Searched · ${queries.length} queries`
            : onlyWeb
              ? `Searched the web · ${count} source${count === 1 ? "" : "s"}`
              : `Sources · ${count}`;

  const favicons = result.results
    .map((h) => h.favicon)
    .filter((f): f is string => Boolean(f))
    .slice(0, 5);

  const images = (result.images ?? []).slice(0, 8);
  const SummaryIcon = onlyLocal ? FileText : Globe;

  return (
    <div className={`web-search-disclosure ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="web-search-disclosure__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SummaryIcon size={13} strokeWidth={2} className="web-search-disclosure__icon" />
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
            {result.results.map((hit, i) => {
              const local = isLocalFileHitUrl(hit.url);
              const display = local ? fileUrlToPath(hit.url) : hit.url;
              return (
                <li key={`${hit.url}-${i}`}>
                  <button
                    type="button"
                    className="web-search-disclosure__hit"
                    title={display}
                    onClick={() => {
                      void openHit(hit.url);
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
                      ) : local ? (
                        <FileText
                          size={12}
                          strokeWidth={2}
                          className="web-search-disclosure__hit-favicon-fallback"
                        />
                      ) : (
                        <Globe
                          size={12}
                          strokeWidth={2}
                          className="web-search-disclosure__hit-favicon-fallback"
                        />
                      )}
                      <span className="web-search-disclosure__hit-title">
                        {hit.title || display}
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
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};

export default WebSearchDisclosure;
