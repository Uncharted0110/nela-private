import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, FileText, Link2 } from "lucide-react";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { Api } from "../api";
import type { SearchHit } from "../types";
import {
  fileUrlToPath,
  isLocalFileHitUrl,
} from "../app/send/fileSearchCitations";
import "./SourceCitation.css";

const CARD_WIDTH = 288;
const CARD_GAP = 12;
const CLOSE_DELAY_MS = 160;

function hostOf(url: string): string {
  if (isLocalFileHitUrl(url)) return "Local file";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type CardPos = { top: number; left: number; side: "left" | "right" };

function computeCardPos(anchor: DOMRect, bubble: DOMRect | null): CardPos {
  const viewportPad = 8;
  const maxTop = Math.max(
    viewportPad,
    window.innerHeight - 280 - viewportPad
  );

  const rightEdge = bubble?.right ?? anchor.right;
  const leftEdge = bubble?.left ?? anchor.left;
  const midX = anchor.left + anchor.width / 2;
  const distLeft = midX - leftEdge;
  const distRight = rightEdge - midX;

  // Prefer the side the citation is closer to within the response.
  let side: "left" | "right" = distRight <= distLeft ? "right" : "left";

  const spaceRight = window.innerWidth - rightEdge - viewportPad;
  const spaceLeft = leftEdge - viewportPad;
  // Flip only if the preferred side can't fit the card.
  if (side === "right" && spaceRight < CARD_WIDTH + CARD_GAP && spaceLeft >= CARD_WIDTH + CARD_GAP) {
    side = "left";
  } else if (side === "left" && spaceLeft < CARD_WIDTH + CARD_GAP && spaceRight >= CARD_WIDTH + CARD_GAP) {
    side = "right";
  }

  const left =
    side === "right"
      ? Math.min(rightEdge + CARD_GAP, window.innerWidth - CARD_WIDTH - viewportPad)
      : Math.max(viewportPad, leftEdge - CARD_WIDTH - CARD_GAP);

  const top = Math.min(Math.max(anchor.top - 4, viewportPad), maxTop);
  return { top, left, side };
}

export interface SourceCitationProps {
  hit: SearchHit;
  index: number;
  /** Compact chip used inside prose, or standalone icon. */
  variant?: "inline" | "icon";
}

/**
 * Link-icon citation: hover shows a side preview (title / URL / snippet / image);
 * click opens the web source in the browser, or the local file in the OS.
 */
export const SourceCitation: React.FC<SourceCitationProps> = ({
  hit,
  variant = "inline",
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CardPos | null>(null);
  const tipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const local = isLocalFileHitUrl(hit.url);
  const displayPath = local ? fileUrlToPath(hit.url) : hit.url;
  const title = hit.title?.trim() || (local ? displayPath.split(/[/\\]/).pop() : null) || hostOf(hit.url) || hit.url;
  const snippet = (hit.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
  const previewImg = hit.image_url ?? undefined;

  const clearCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const show = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const hideSoon = () => {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => () => clearCloseTimer(), []);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      return;
    }

    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const bubbleEl =
        anchorRef.current?.closest(".glass") ??
        anchorRef.current?.closest(".markdown-body")?.parentElement;
      const bubble = bubbleEl?.getBoundingClientRect() ?? null;
      setPos(computeCardPos(anchor, bubble));
    };

    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  const openSource = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!hit.url) return;
    if (local) {
      const path = fileUrlToPath(hit.url);
      void openPath(path).catch((openErr) => {
        console.error("Failed to open local file:", openErr);
        void Api.revealInExplorer(path).catch((err) =>
          console.error("Failed to reveal local path:", err)
        );
      });
      return;
    }
    void openUrl(hit.url);
  };

  return (
    <span
      ref={anchorRef}
      className={`source-cite source-cite--${variant}${local ? " source-cite--local" : ""}`}
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={show}
      onBlur={hideSoon}
    >
      <button
        type="button"
        className="source-cite__btn"
        aria-label={local ? `Open local file: ${title}` : `Source: ${title}`}
        aria-describedby={open ? tipId : undefined}
        onClick={openSource}
      >
        {local ? (
          <FileText size={11} strokeWidth={2.25} aria-hidden />
        ) : (
          <Link2 size={11} strokeWidth={2.25} aria-hidden />
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            id={tipId}
            role="tooltip"
            className={`source-cite__card source-cite__card--${pos.side}`}
            style={{ top: pos.top, left: pos.left, width: CARD_WIDTH }}
            onMouseEnter={show}
            onMouseLeave={hideSoon}
            onClick={openSource}
          >
            {previewImg ? (
              <div className="source-cite__preview">
                <img
                  src={previewImg}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    const wrap = (e.target as HTMLImageElement).parentElement;
                    if (wrap) wrap.style.display = "none";
                  }}
                />
              </div>
            ) : null}
            <div className="source-cite__card-body">
              <div className="source-cite__card-title">{title}</div>
              <div className="source-cite__card-host">
                {hostOf(hit.url)}
                {local ? (
                  <FileText size={10} strokeWidth={2} aria-hidden />
                ) : (
                  <ExternalLink size={10} strokeWidth={2} aria-hidden />
                )}
              </div>
              {snippet ? (
                <div className="source-cite__card-snippet">{snippet}</div>
              ) : null}
              <div className="source-cite__card-url">{displayPath}</div>
            </div>
          </div>,
          document.body
        )}
    </span>
  );
};

/** Compact row of source icons. */
export const SourceIconRow: React.FC<{ hits: SearchHit[] }> = ({ hits }) => {
  if (!hits.length) return null;
  return (
    <div className="source-cite-row" aria-label="Sources">
      {hits.map((hit, i) => (
        <SourceCitation key={`${hit.url}-${i}`} hit={hit} index={i + 1} variant="icon" />
      ))}
    </div>
  );
};

export default SourceCitation;
