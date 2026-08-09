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

interface MarkdownRendererProps {
  content: string;
  /**
   * When true, skip expensive rehype plugins (highlight / katex / raw HTML) so
   * each streamed token paints quickly. Final messages use the full pipeline.
   */
  streaming?: boolean;
  /** Web search hits — turns [n] markers into hoverable citation icons. */
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
    // file:///C:/path on Windows → C:/path
    if (/^\/[a-zA-Z]:/.test(path)) {
      path = path.substring(1);
    }
  }
  // Windows paths use backslashes; Unix paths must keep forward slashes.
  const isWindowsPath = /^[a-zA-Z]:[/\\]/.test(path) || path.includes("\\");
  return isWindowsPath ? path.replace(/\//g, "\\") : path.replace(/\\/g, "/");
}

/**
 * Copy-to-clipboard button for code blocks.
 */
const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older webview versions
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
export function stripTrailingSourcesSection(md: string): string {
  return md
    .replace(
      /\n{1,3}(?:#{1,6}\s*|\*\*|__)?Sources(?:\*\*|__)?\s*(?:\n|:)?[\s\S]*$/i,
      ""
    )
    .trimEnd();
}

/**
 * Turn [n] / [[n]] citation markers into markdown links that the renderer
 * maps to SourceCitation chips. Skips fenced code blocks.
 *
 * Models often write `…claim [1].` — move the sentence punctuation before the
 * icon so it reads `…claim. [icon]` instead of `…claim [icon].`
 */
function injectCitationLinks(md: string, sourceCount: number): string {
  if (sourceCount <= 0) return md;
  const parts = md.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```")) return part;
      // Avoid rewriting real markdown links like [1](https://...).
      // Capture trailing . ! ? (and optional closing quotes) so the cite sits after the sentence.
      return part.replace(
        /\s*\[\[?(\d{1,3})\]\]?(?!\()\s*([.!?]+["']?)/g,
        (full, numStr: string, punct: string) => {
          const n = Number(numStr);
          if (!Number.isFinite(n) || n < 1 || n > sourceCount) return full;
          return `${punct} [↗](cite://${n})`;
        }
      ).replace(/\[\[?(\d{1,3})\]\]?(?!\()/g, (full, numStr: string) => {
        const n = Number(numStr);
        if (!Number.isFinite(n) || n < 1 || n > sourceCount) return full;
        return `[↗](cite://${n})`;
      });
    })
    .join("");
}

function buildMarkdownComponents(sources?: SearchHit[] | null): Components {
  return {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || "");
      const codeString = extractText(children).replace(/\n$/, "");
      const isBlock = match || codeString.includes("\n");

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
      const citeMatch = href?.match(/^cite:\/\/(\d+)$/);
      if (citeMatch && sources?.length) {
        const index = Number(citeMatch[1]);
        const hit = sources[index - 1];
        if (hit) {
          return <SourceCitation hit={hit} index={index} variant="inline" />;
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

/**
 * Pre-process markdown so that table cells render correctly:
 *  - Convert literal "<br>" text to actual <br/> tags
 *  - Turn "- item" bullet patterns inside table cells into bullet characters
 *    separated by <br/> since markdown lists can't nest inside GFM table cells.
 */
function preprocessMarkdown(md: string): string {
  return md.replace(
    // Match a full GFM table row: | cell | cell | ...
    /^(\|.+\|)$/gm,
    (_match, row: string) => {
      return row
        .replace(/<br\s*\/?>/gi, "<br/>")
        .replace(/(?<=\|\s*)-\s+/g, "• ")
        .replace(/<br\/>\s*-\s+/g, "<br/>• ");
    }
  );
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
  prepared = injectCitationLinks(prepared, sources?.length ?? 0);
  const processed = preprocessMarkdown(prepared);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
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
