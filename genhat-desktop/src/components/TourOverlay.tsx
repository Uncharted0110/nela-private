import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTour, type TourPlacement, type TourTarget } from "../hooks/useTour";
import "./TourOverlay.css";

type Rect = { left: number; top: number; width: number; height: number; right: number; bottom: number };

type TooltipPos = { left: number; top: number; transform: string };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function resolveTarget(target: TourTarget): HTMLElement | null {
  if (typeof target === "string") return document.querySelector(target) as HTMLElement | null;
  try {
    return target();
  } catch {
    return null;
  }
}

function pickPlacement(rect: Rect, preferred: TourPlacement): Exclude<TourPlacement, "auto"> {
  if (preferred !== "auto") return preferred;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceBottom = vh - rect.bottom;
  const spaceTop = rect.top;
  const spaceRight = vw - rect.right;
  const spaceLeft = rect.left;

  if (spaceBottom > 200) return "bottom";
  if (spaceTop > 200) return "top";
  if (spaceRight > 280) return "right";
  if (spaceLeft > 280) return "left";
  return spaceBottom >= spaceTop ? "bottom" : "top";
}

function computeTooltipPosition(
  rect: Rect,
  placement: Exclude<TourPlacement, "auto">
): TooltipPos {
  const gap = 14;
  switch (placement) {
    case "top":
      return { left: rect.left + rect.width / 2, top: rect.top - gap, transform: "translate(-50%, -100%)" };
    case "bottom":
      return { left: rect.left + rect.width / 2, top: rect.bottom + gap, transform: "translate(-50%, 0)" };
    case "left":
      return { left: rect.left - gap, top: rect.top + rect.height / 2, transform: "translate(-100%, -50%)" };
    case "right":
      return { left: rect.right + gap, top: rect.top + rect.height / 2, transform: "translate(0, -50%)" };
  }
}

function clampTooltipToViewport(
  pos: TooltipPos,
  tooltipWidth: number,
  tooltipHeight: number,
  margin = 16
): TooltipPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Approximate anchor from transform — re-center if near edges.
  let left = pos.left;
  let top = pos.top;
  let transform = pos.transform;

  if (transform.includes("-50%")) {
    left = clamp(left, margin + tooltipWidth / 2, vw - margin - tooltipWidth / 2);
  } else if (transform.startsWith("translate(-100%")) {
    left = clamp(left, margin + tooltipWidth, vw - margin);
  } else if (transform.startsWith("translate(0")) {
    left = clamp(left, margin, vw - margin - tooltipWidth);
  }

  if (transform.includes("-100%")) {
    top = clamp(top, margin + tooltipHeight, vh - margin);
  } else if (transform.includes("-50%")) {
    top = clamp(top, margin + tooltipHeight / 2, vh - margin - tooltipHeight / 2);
  } else {
    top = clamp(top, margin, vh - margin - tooltipHeight);
  }

  return { left, top, transform };
}

export default function TourOverlay() {
  const { status, activeTour, activeStep, stepIndex, next, prev, exit, complete } = useTour();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<TooltipPos | null>(null);
  const targetEl = activeStep ? resolveTarget(activeStep.target) : null;
  const useSpotlight = activeStep?.spotlight !== false;

  useLayoutEffect(() => {
    if (status !== "running" || !activeStep) return;

    const update = () => {
      const el = resolveTarget(activeStep.target);
      if (!el) {
        setTargetRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setTargetRect({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      });
    };

    update();

    const onResize = () => update();
    const onScroll = () => update();

    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    const id = window.setInterval(update, 400);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      window.clearInterval(id);
    };
  }, [activeStep, status]);

  // Scroll highlighted element into view when the step changes.
  useEffect(() => {
    if (status !== "running" || !activeStep || !useSpotlight) return;
    const el = resolveTarget(activeStep.target);
    if (!el) return;
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    } catch {
      // ignore
    }
  }, [activeStep, status, stepIndex, useSpotlight]);

  // Measure tooltip and clamp within viewport.
  useLayoutEffect(() => {
    if (status !== "running" || !activeStep || !activeTour) {
      setTooltipPos(null);
      return;
    }

    const shouldCenter = activeStep.centerTooltip === true;
    const placement = pickPlacement(
      targetRect ?? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 },
      activeStep.placement ?? "auto"
    );

    const base: TooltipPos = shouldCenter
      ? { left: window.innerWidth / 2, top: window.innerHeight / 2, transform: "translate(-50%, -50%)" }
      : targetRect
        ? computeTooltipPosition(targetRect, placement)
        : { left: window.innerWidth / 2, top: window.innerHeight / 2, transform: "translate(-50%, -50%)" };

    const measure = () => {
      const node = tooltipRef.current;
      const w = node?.offsetWidth ?? 360;
      const h = node?.offsetHeight ?? 200;
      setTooltipPos(clampTooltipToViewport(base, w, h));
    };

    measure();
    const id = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(id);
  }, [activeStep, activeTour, status, stepIndex, targetRect]);

  useEffect(() => {
    if (status !== "running") return;
    const t = window.setTimeout(() => tooltipRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [status, stepIndex]);

  useEffect(() => {
    if (status !== "running") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        if (activeTour && stepIndex >= activeTour.steps.length - 1) complete();
        else next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [status, activeTour, stepIndex, next, prev, complete]);

  if (status !== "running" || !activeTour || !activeStep) return null;

  const progressLabel = `${clamp(stepIndex + 1, 1, activeTour.steps.length)}/${activeTour.steps.length}`;
  const isLast = stepIndex >= activeTour.steps.length - 1;

  const pad = 8;
  const spot =
    useSpotlight && targetRect
      ? {
          left: Math.max(0, targetRect.left - pad),
          top: Math.max(0, targetRect.top - pad),
          width: Math.max(0, targetRect.width + pad * 2),
          height: Math.max(0, targetRect.height + pad * 2),
        }
      : null;
  const spotRight = spot ? spot.left + spot.width : 0;
  const spotBottom = spot ? spot.top + spot.height : 0;

  const pos =
    tooltipPos ??
    (activeStep.centerTooltip
      ? { left: window.innerWidth / 2, top: window.innerHeight / 2, transform: "translate(-50%, -50%)" }
      : { left: window.innerWidth / 2, top: window.innerHeight / 2, transform: "translate(-50%, -50%)" });

  return createPortal(
    <div className="tour-root" role="dialog" aria-modal="true" aria-labelledby="tour-step-title">
      {spot ? (
        <>
          <div className="tour-dim-pane" onClick={exit} style={{ left: 0, top: 0, right: 0, height: `${spot.top}px` }} />
          <div
            className="tour-dim-pane"
            onClick={exit}
            style={{ left: 0, top: `${spot.top}px`, width: `${spot.left}px`, height: `${spot.height}px` }}
          />
          <div
            className="tour-dim-pane"
            onClick={exit}
            style={{ left: `${spotRight}px`, top: `${spot.top}px`, right: 0, height: `${spot.height}px` }}
          />
          <div className="tour-dim-pane" onClick={exit} style={{ left: 0, top: `${spotBottom}px`, right: 0, bottom: 0 }} />
        </>
      ) : (
        <div className="tour-dim" onClick={exit} />
      )}

      {spot && (
        <>
          <div
            className="tour-highlight-glow"
            style={{
              left: `${spot.left}px`,
              top: `${spot.top}px`,
              width: `${spot.width}px`,
              height: `${spot.height}px`,
            }}
          />
          <div
            className="tour-highlight"
            style={{
              left: `${spot.left}px`,
              top: `${spot.top}px`,
              width: `${spot.width}px`,
              height: `${spot.height}px`,
            }}
          />
        </>
      )}

      <div
        className={`tour-tooltip ${activeStep.centerTooltip ? "tour-tooltip--center" : ""}`}
        style={{ left: `${pos.left}px`, top: `${pos.top}px`, transform: pos.transform }}
        tabIndex={-1}
        ref={tooltipRef}
      >
        <div className="tour-tooltip-accent" aria-hidden />

        <div className="tour-tooltip-header">
          <div className="tour-tooltip-title" id="tour-step-title">
            {activeStep.title}
          </div>
          <div className="tour-tooltip-meta">
            <span className="tour-tooltip-progress">{progressLabel}</span>
            <button className="tour-icon-btn" onClick={exit} aria-label="Close tour" title="Close">
              ×
            </button>
          </div>
        </div>

        <div className="tour-progress-dots" aria-hidden>
          {activeTour.steps.map((step, i) => (
            <span key={step.id} className={`tour-progress-dot ${i === stepIndex ? "active" : ""} ${i < stepIndex ? "done" : ""}`} />
          ))}
        </div>

        <div className="tour-tooltip-body">{activeStep.body}</div>

        <div className="tour-tooltip-actions">
          <button type="button" className="tour-btn ghost" onClick={exit}>
            Skip
          </button>
          <div className="tour-spacer" />
          <button type="button" className="tour-btn ghost" onClick={prev} disabled={stepIndex <= 0}>
            Back
          </button>
          <button type="button" className="tour-btn primary" onClick={isLast ? complete : next}>
            {isLast ? "Done" : "Next"}
          </button>
        </div>

        {!targetEl && useSpotlight && (
          <div className="tour-tooltip-note">
            This step&apos;s UI isn&apos;t visible right now. Press Next to continue.
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
