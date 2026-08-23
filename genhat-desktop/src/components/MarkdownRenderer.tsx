import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { Components } from "react-markdown";
import { openPath } from "@tauri-apps/plugin-opener";
import { Api } from "../api";
import type { SearchHit } from "../types";
import { SourceCitation } from "./SourceCitation";
import { ChartViewer } from "./ChartViewer";
import { tryParseChartPayload } from "../prompts/chartPrompt";

interface MarkdownRendererProps {
  content: string;
  /**
   * When true, skip expensive rehype plugins (highlight / katex / raw HTML) so
   * each streamed token paints quickly. Final messages use the full pipeline.
   */
  streaming?: boolean;
  /** Web search hits — turns [n] / URL citations into hoverable citation icons. */
  sources?: SearchHit[] | null;
}

/** Recursively extract plain text from React nodes (handles rehype-highlight spans). */
function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in node) {
    const element = node as React.ReactElement<{ children?: React.ReactNode }>;
    return extractText(element.props.children);
  }
  return "";
}

/** Normalize a local filesystem path decoded from a file:// href or raw path. */
function normalizeLocalPath(href: string): string {
  let path = href;
  if (path.startsWith("file://")) {
    path = decodeURIComponent(path.replace(/^file:\/\//, ""));
    if (/^\/[a-zA-Z]:/.test(path)) {
      path = path.substring(1);
    }
  }
  const isWindowsPath = /^[a-zA-Z]:[/\\]/.test(path) || path.includes("\\");
  return isWindowsPath ? path.replace(/\//g, "\\") : path.replace(/\\/g, "/");
}

function normalizeUrlKey(url: string): string {
  if (
    url.startsWith("file://") ||
    /^[a-zA-Z]:[/\\]/.test(url) ||
    (url.startsWith("/") && !url.startsWith("//"))
  ) {
    let path = url;
    if (path.startsWith("file://")) {
      path = decodeURIComponent(path.replace(/^file:\/\//, ""));
      if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    }
    return path.replace(/\\/g, "/").toLowerCase();
  }
  try {
    const u = new URL(url.trim());
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.hostname.replace(/^www\./, "")}${path}${u.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function hitForUrl(url: string, sources?: SearchHit[] | null): SearchHit {
  const key = normalizeUrlKey(url);
  const found = sources?.find((s) => normalizeUrlKey(s.url) === key);
  if (found) return found;
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    /* keep raw */
  }
  return { title: host, snippet: "", url };
}

function indexForUrl(url: string, sources?: SearchHit[] | null): number {
  const key = normalizeUrlKey(url);
  const idx = sources?.findIndex((s) => normalizeUrlKey(s.url) === key) ?? -1;
  return idx >= 0 ? idx + 1 : 1;
}

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button className="code-copy-btn" onClick={handleCopy} title="Copy code">
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
};

/** Drop trailing "Sources" dump — citations render as inline icons instead. */
function stripTrailingSourcesSection(md: string): string {
  return md
    .replace(
      /\n{1,3}(?:#{1,6}\s*|\*\*|__)?Sources(?:\*\*|__)?\s*(?:\n|:)?[\s\S]*$/i,
      ""
    )
    .trimEnd();
}

const CITE_URL_PREFIX = "cite-url://";

function encodeCiteUrl(url: string): string {
  return `${CITE_URL_PREFIX}${encodeURIComponent(url.trim())}`;
}

function decodeCiteUrl(href: string): string | null {
  if (!href.startsWith(CITE_URL_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(CITE_URL_PREFIX.length));
  } catch {
    return href.slice(CITE_URL_PREFIX.length);
  }
}

/**
 * Turn [n] markers and pasted URL citations (【url】, [url], (url)) into
 * cite links that render as SourceCitation icons. Skips fenced code blocks.
 *
 * Always place sentence punctuation BEFORE citation icons:
 * `…claim【url】.` / `…claim [1].` → `…claim. [icon]`
 */
function injectCitationLinks(
  md: string,
  sources: SearchHit[] | null | undefined
): string {
  const sourceCount = sources?.length ?? 0;
  const parts = md.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```")) return part;

      let out = part;

      // Fullwidth bracket URL cites: 【https://...】
      out = out.replace(
        /【\s*(https?:\/\/[^\s】]+)\s*】/gi,
        (_full, url: string) => `[↗](${encodeCiteUrl(url)})`
      );

      // Square-bracket URL cites that aren't markdown links: [https://...]
      out = out.replace(
        /\[\s*(https?:\/\/[^\s\]]+)\s*\](?!\()/gi,
        (_full, url: string) => `[↗](${encodeCiteUrl(url)})`
      );

      // Parenthetical bare URLs: (https://...)
      out = out.replace(
        /\(\s*(https?:\/\/[^\s)]+)\s*\)/gi,
        (_full, url: string) => `[↗](${encodeCiteUrl(url)})`
      );

      // Numbered [n] / [[n]] (without trailing punct first).
      if (sourceCount > 0) {
        out = out.replace(/\[\[?(\d{1,3})\]\]?(?!\()/g, (full, numStr: string) => {
          const n = Number(numStr);
          if (!Number.isFinite(n) || n < 1 || n > sourceCount) return full;
          return `[↗](cite://${n})`;
        });
      }

      // Collapse duplicate adjacent icons for the same target.
      out = out.replace(/(\[↗\]\(cite(?:-url)?:\/\/[^)]+\))(?:\s*\1)+/g, "$1");

      // Move one or more citation icons that sit before . ! ? to after that punct.
      // e.g. "…1899[↗](cite-url://…)[↗](cite-url://…)." → "…1899. [↗]… [↗]…"
      out = out.replace(
        /\s*((?:\[↗\]\(cite(?:-url)?:\/\/[^)]+\)\s*)+)([.!?]+["']?)/g,
        (_full, cites: string, punct: string) => {
          const icons = cites
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .join(" ");
          return `${punct} ${icons}`;
        }
      );

      return out;
    })
    .join("");
}

function looksLikeUrlLabel(label: string, href: string): boolean {
  const t = label.trim();
  if (!t || t === "↗" || t === "🔗") return true;
  if (/^https?:\/\//i.test(t)) return true;
  try {
    const host = new URL(href).hostname.replace(/^www\./, "");
    return t === host || t.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function buildMarkdownComponents(sources?: SearchHit[] | null): Components {
  return {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || "");
      const codeString = extractText(children).replace(/\n$/, "");
      const isBlock = match || codeString.includes("\n");
      const lang = (match?.[1] || "").toLowerCase();

      // Interactive ECharts: ```json (or ```echarts) with "type":"chart"|"echarts"
      if (
        isBlock &&
        (lang === "json" || lang === "echarts" || lang === "") &&
        codeString.trim().startsWith("{")
      ) {
        const chart = tryParseChartPayload(codeString);
        if (chart) {
          return (
            <ChartViewer
              option={chart.option}
              title={chart.title}
              height="400px"
            />
          );
        }
      }

      if (isBlock) {
        return (
          <div className="code-block-wrapper">
            <div className="code-block-header">
              <span className="code-lang">{match?.[1] || "code"}</span>
              <CopyButton text={codeString} />
            </div>
            <pre className="code-block">
              <code className={className} {...props}>
                {children}
              </code>
            </pre>
          </div>
        );
      }

      return (
        <code className="inline-code" {...props}>
          {children}
        </code>
      );
    },

    a({ href, children, ...props }) {
      if (href) {
        const citeMatch = href.match(/^cite:\/\/(\d+)$/);
        if (citeMatch && sources?.length) {
          const index = Number(citeMatch[1]);
          const hit = sources[index - 1];
          if (hit) {
            return <SourceCitation hit={hit} index={index} variant="inline" />;
          }
        }

        const citeUrl = decodeCiteUrl(href);
        if (citeUrl) {
          return (
            <SourceCitation
              hit={hitForUrl(citeUrl, sources)}
              index={indexForUrl(citeUrl, sources)}
              variant="inline"
            />
          );
        }

        // Web answers: source / bare-URL markdown links → citation icons.
        if (/^https?:\/\//i.test(href)) {
          const label = extractText(children);
          const inSources = Boolean(
            sources?.some(
              (s) => normalizeUrlKey(s.url) === normalizeUrlKey(href)
            )
          );
          if (inSources || looksLikeUrlLabel(label, href)) {
            return (
              <SourceCitation
                hit={hitForUrl(href, sources)}
                index={indexForUrl(href, sources)}
                variant="inline"
              />
            );
          }
        }
      }

      const isLocalFile = !!(
        href?.startsWith("file://") ||
        (href && /^[a-zA-Z]:[/\\]/.test(href)) ||
        href?.startsWith("\\\\")
      );

      const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        if (isLocalFile && href) {
          e.preventDefault();
          const path = normalizeLocalPath(href);
          openPath(path).catch((openErr) => {
            console.error("Failed to open local file:", openErr);
            Api.revealInExplorer(path).catch((err) =>
              console.error("Failed to reveal local path:", err)
            );
          });
        }
      };

      return (
        <a
          {...props}
          href={href}
          target={isLocalFile ? undefined : "_blank"}
          rel={isLocalFile ? undefined : "noopener noreferrer"}
          onClick={handleClick}
          className="md-link"
        >
          {children}
        </a>
      );
    },

    img({ src, alt, ...props }) {
      if (typeof src !== "string" || !/^https?:\/\//.test(src)) return null;
      return (
        <img
          {...props}
          src={src}
          alt={alt ?? ""}
          loading="lazy"
          className="md-inline-image"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      );
    },

    table({ children, ...props }) {
      return (
        <div className="table-wrapper">
          <table className="md-table" {...props}>
            {children}
          </table>
        </div>
      );
    },

    blockquote({ children, ...props }) {
      return (
        <blockquote className="md-blockquote" {...props}>
          {children}
        </blockquote>
      );
    },
  };
}

function preprocessMarkdown(md: string): string {
  return md.replace(/^(\|.+\|)$/gm, (_match, row: string) => {
    return row
      .replace(/<br\s*\/?>/gi, "<br/>")
      .replace(/(?<=\|\s*)-\s+/g, "• ")
      .replace(/<br\/>\s*-\s+/g, "<br/>• ");
  });
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  streaming = false,
  sources = null,
}) => {
  const components = useMemo(
    () => buildMarkdownComponents(sources),
    [sources]
  );

  if (streaming) {
    return (
      <div className="markdown-body whitespace-pre-wrap break-words">
        {content}
        <span className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-neon/70 animate-pulse" />
      </div>
    );
  }

  let prepared = stripTrailingSourcesSection(content);
  prepared = injectCitationLinks(prepared, sources);
  const processed = preprocessMarkdown(prepared);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeRaw, rehypeKatex, rehypeHighlight]}
        components={components}
        urlTransform={(url) => url}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownRenderer;
