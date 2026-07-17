import { useGenerationProgressLabel, type GenerationProgressMode } from "../app/generationProgress";
import type { PipelineStageKind } from "./ProgressSlate";

interface GenerationProgressLabelProps {
  active: boolean;
  mode: GenerationProgressMode;
  elapsedSec: number;
  stage?: PipelineStageKind | null;
  className?: string;
}

export default function GenerationProgressLabel({
  active,
  mode,
  elapsedSec,
  stage,
  className = "",
}: GenerationProgressLabelProps) {
  const { verb } = useGenerationProgressLabel(active, mode, elapsedSec, stage);

  if (!active) return null;

  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <span className="nela-gradient-verb text-[0.8rem] font-medium leading-snug">{verb}</span>
      {/* Display only a friendly status verb (no remaining/elapsed timing). */}
    </div>
  );
}
