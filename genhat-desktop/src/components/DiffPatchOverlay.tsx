import { useEffect, useState } from "react";

export interface DiffPatchOverlayProps {
  /** Patch text to analyze for stats. */
  patch: string | null;
  /** Trigger state to show the overlay. */
  active: boolean;
  /** Callback when the overlay animation completes. */
  onComplete?: () => void;
}

export default function DiffPatchOverlay({
  patch,
  active,
  onComplete,
}: DiffPatchOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [stats, setStats] = useState({ additions: 0, deletions: 0 });

  useEffect(() => {
    if (active && patch) {
      // Calculate diff stats
      let additions = 0;
      let deletions = 0;
      
      const lines = patch.split("\n");
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          additions += 1;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          deletions += 1;
        }
      }

      setStats({ additions, deletions });
      setVisible(true);

      // Auto fade out after 3 seconds
      const timer = setTimeout(() => {
        setVisible(false);
        if (onComplete) {
          onComplete();
        }
      }, 3000);

      return () => clearTimeout(timer);
    }
  }, [active, patch, onComplete]);

  if (!visible || !patch) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        right: 16,
        background: "rgba(13, 13, 17, 0.85)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(74, 222, 128, 0.3)",
        boxShadow: "0 8px 32px 0 rgba(0, 0, 0, 0.37), 0 0 15px rgba(74, 222, 128, 0.1)",
        borderRadius: "12px",
        padding: "12px 18px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        zIndex: 999,
        animation: "nela-slide-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards",
      }}
    >
      {/* Visual pulse indicator */}
      <span style={{ display: "flex", position: "relative", height: 8, width: 8 }}>
        <span
          style={{
            position: "absolute",
            display: "inline-flex",
            height: "100%",
            width: "100%",
            borderRadius: "9999px",
            backgroundColor: "#4ade80",
            opacity: 0.75,
            animation: "ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite",
          }}
        />
        <span
          style={{
            position: "relative",
            display: "inline-flex",
            borderRadius: "9999px",
            height: 8,
            width: 8,
            backgroundColor: "#22c55e",
          }}
        />
      </span>

      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <span
          style={{
            color: "#ffffff",
            fontSize: "13px",
            fontWeight: 600,
            fontFamily: "'Outfit', sans-serif",
          }}
        >
          Hot Reload Patch Applied
        </span>
        <span
          style={{
            color: "#94a3b8",
            fontSize: "11px",
            display: "flex",
            gap: "8px",
          }}
        >
          <span style={{ color: "#4ade80", fontWeight: 500 }}>
            +{stats.additions} lines
          </span>
          <span style={{ color: "#f87171", fontWeight: 500 }}>
            -{stats.deletions} lines
          </span>
        </span>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes nela-slide-in {
          0% { transform: translateY(-10px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        @keyframes ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
      `}} />
    </div>
  );
}
