import React, { useState, useEffect } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pipeline stage identifiers emitted by the Rust backend via the
 * `pipeline-stage` Tauri event (mcp/types.rs `PipelineStage`).
 */
export type PipelineStageKind =
  | "IntentLocked"
  | "SearchingDisk"
  | "CrunchingMetrics"
  | "WritingCode"
  | "LivePreview"
  | "Error";

export interface ProgressSlateProps {
  stage: PipelineStageKind;
  /** Human-readable error message (present when stage === "Error"). */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage metadata
// ─────────────────────────────────────────────────────────────────────────────

interface StageInfo {
  label: string;
  description: string;
  icon: string;
}

const STAGE_ORDER: PipelineStageKind[] = [
  "IntentLocked",
  "SearchingDisk",
  "CrunchingMetrics",
  "WritingCode",
  "LivePreview",
];

const STAGE_INFO: Record<PipelineStageKind, StageInfo> = {
  IntentLocked: {
    label: "Intent Locked",
    description: "Understanding what you need…",
    icon: "🔒",
  },
  SearchingDisk: {
    label: "Searching SSD…",
    description: "Locating relevant files and data…",
    icon: "🔍",
  },
  CrunchingMetrics: {
    label: "Crunching Metrics…",
    description: "Processing and aggregating data…",
    icon: "⚙️",
  },
  WritingCode: {
    label: "Writing Code…",
    description: "Generating the artifact…",
    icon: "✍️",
  },
  LivePreview: {
    label: "Live Preview",
    description: "Your artifact is ready.",
    icon: "✅",
  },
  Error: {
    label: "Error",
    description: "Something went wrong.",
    icon: "⚠️",
  },
};

const SPINNER_VERBS: Record<PipelineStageKind, string[]> = {
  IntentLocked: [
    "Locking in intent...",
    "Analyzing request...",
    "Ruminating on prompt...",
    "Forging plan...",
  ],
  SearchingDisk: [
    "Locating dataset files...",
    "Scanning local indices...",
    "Querying file database...",
    "Retrieving system context...",
  ],
  CrunchingMetrics: [
    "Analyzing structure...",
    "Synthesizing data...",
    "Crunching metrics...",
    "Computing aggregates...",
  ],
  WritingCode: [
    "Writing code / layout...",
    "Forging layouts...",
    "Polishing cells...",
    "Formatting stylesheet...",
  ],
  LivePreview: ["Your artifact is ready."],
  Error: ["Something went wrong."],
};

// ─────────────────────────────────────────────────────────────────────────────
// ProgressSlate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * State-driven pipeline indicator component.
 *
 * Drives a visual state machine from backend `pipeline-stage` events so the
 * user always sees meaningful motion rather than a blank spinner. This is the
 * single biggest *perceived speed* win at zero additional latency cost
 * (revamp.md §10.1).
 *
 * The component is intentionally self-contained with no external CSS dependencies
 * so it renders correctly in all Tauri webview targets.
 */
export default function ProgressSlate({ stage, error }: ProgressSlateProps) {
  const currentIdx = STAGE_ORDER.indexOf(stage);
  const info = STAGE_INFO[stage];
  const [verbIndex, setVerbIndex] = useState(0);

  useEffect(() => {
    setVerbIndex(0);
  }, [stage]);

  useEffect(() => {
    if (stage === "LivePreview" || stage === "Error") return;
    const interval = setInterval(() => {
      setVerbIndex((prev) => (prev + 1) % (SPINNER_VERBS[stage]?.length || 1));
    }, 1500);
    return () => clearInterval(interval);
  }, [stage]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        flex: 1,
        padding: "32px 24px",
        gap: 32,
        background: "var(--color-surface, #1a1a2e)",
        color: "var(--color-text, #e0e0f0)",
        minHeight: 200,
      }}
    >
      {/* Current stage icon + label */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontSize: 40,
            lineHeight: 1,
            animation:
              stage !== "LivePreview" && stage !== "Error"
                ? "nela-pulse 1.4s ease-in-out infinite"
                : undefined,
          }}
        >
          {info.icon}
        </span>
        <span
          style={{
            fontSize: 16,
            fontWeight: 600,
            color:
              stage === "Error"
                ? "var(--color-danger, #ff5555)"
                : "var(--color-text, #e0e0f0)",
          }}
        >
          {info.label}
        </span>
        <span
          style={{
            fontSize: 13,
            color: "var(--color-text-muted, #888)",
          }}
        >
          {stage === "Error" && error
            ? error
            : stage === "LivePreview"
            ? info.description
            : SPINNER_VERBS[stage]?.[verbIndex] || info.description}
        </span>
      </div>

      {/* Step trail */}
      {stage !== "Error" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 0,
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          {STAGE_ORDER.map((s, i) => {
            const isCompleted = i < currentIdx;
            const isCurrent = i === currentIdx;

            return (
              <React.Fragment key={s}>
                {/* Step dot */}
                <div
                  style={{
                    width: isCurrent ? 12 : 8,
                    height: isCurrent ? 12 : 8,
                    borderRadius: "50%",
                    background: isCompleted
                      ? "var(--color-accent, #6c63ff)"
                      : isCurrent
                      ? "var(--color-accent, #6c63ff)"
                      : "var(--color-border, #2d2d4a)",
                    transition: "all 0.3s ease",
                    boxShadow: isCurrent
                      ? "0 0 8px var(--color-accent, #6c63ff)"
                      : undefined,
                    flexShrink: 0,
                  }}
                  title={STAGE_INFO[s].label}
                />
                {/* Connector line between dots */}
                {i < STAGE_ORDER.length - 1 && (
                  <div
                    style={{
                      width: 20,
                      height: 2,
                      background:
                        isCompleted || isCurrent
                          ? "var(--color-accent, #6c63ff)"
                          : "var(--color-border, #2d2d4a)",
                      transition: "background 0.3s ease",
                      flexShrink: 0,
                    }}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* Keyframe for pulsing icon animation */}
      <style>{`
        @keyframes nela-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(0.9); }
        }
      `}</style>
    </div>
  );
}
