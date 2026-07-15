import { useGenerationProgressLabel, type GenerationProgressMode } from "../app/generationProgress";
import type { PipelineStageKind } from "./ProgressSlate";

interface GenerationProgressLabelProps {
  active: boolean;
  mode: GenerationProgressMode;
  elapsedSec: number;
  stage?: PipelineStageKind | null;
  className?: string;
  showEta?: boolean;
}

export default function GenerationProgressLabel({
  active,
  mode,
  elapsedSec,
  stage,
  className = "",
  showEta = true,
}: GenerationProgressLabelProps) {
  const { verb, etaSec } = useGenerationProgressLabel(active, mode, elapsedSec, stage);

  if (!active) return null;

  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <span className="nela-gradient-verb text-[0.8rem] font-medium leading-snug">{verb}</span>
      {showEta && (
        <span className="text-[0.7rem] text-txt-muted tabular-nums">
          ~{etaSec}s remaining · {elapsedSec.toFixed(1)}s elapsed
        </span>
      )}
    </div>
  );
}
