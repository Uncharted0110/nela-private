import { useEffect, useMemo, useState } from "react";
import type { PipelineStageKind } from "../components/ProgressSlate";

/**
 * Friendly rotating status verbs while waiting for the model.
 * Kept deliberately plain-English so it’s always understandable.
 */
export const SPINNER_VERB_POOL: string[] = [
  "Consulting the oracle…",
  "Bribing the electrons…",
  "Teaching sand to think…",
  "Herding caffeinated neurons…",
  "Negotiating with entropy…",
  "Polishing photons…",
  "Summoning context windows…",
  "Untangling semicolons…",
  "Whispering to the GPU…",
  "Aligning the vibes…",
  "Calculating charisma…",
  "Defragmenting imagination…",
  "Brewing fresh tokens…",
  "Asking the spreadsheet nicely…",
  "Convincing PDFs to talk…",
  "Spinning up hamster wheels…",
  "Measuring twice, cutting once…",
  "Reticulating splines…",
  "Loading personality…",
  "Compressing brilliance…",
  "Inflating insights…",
  "Debugging the universe…",
  "Refactoring reality…",
  "Linting your destiny…",
  "Compiling good ideas…",
  "Linking happy thoughts…",
  "Paging Dr. Algorithm…",
  "Stirring the data soup…",
  "Marinating metrics…",
  "Seasoning summaries…",
  "Kneading paragraphs…",
  "Fermenting facts…",
  "Distilling wisdom…",
  "Crystallizing clarity…",
  "Ionizing inspiration…",
  "Calibrating cleverness…",
  "Synchronizing synapses…",
  "Downloading more RAM…",
  "Uploading patience…",
  "Ping-ing localhost…",
  "Tracing stack traces…",
  "Chasing tail calls…",
  "Flattening nested loops…",
  "Escaping quote hell…",
  "Normalizing chaos…",
  "Sanitizing shenanigans…",
  "Hydrating hypotheses…",
  "Dehydrating doubt…",
  "Microwaving metadata…",
  "Toasting templates…",
  "Buttering bullet points…",
  "Juggling JSON…",
  "Taming wild CSVs…",
  "Domesticating documents…",
  "House-training histograms…",
  "Walking the dependency graph…",
  "Petting the parser…",
  "Scratching behind the cache…",
  "Tickling the tokenizer…",
  "Warming up the thesaurus…",
  "Cooling down hot takes…",
  "Ventilating verbose answers…",
  "Vacuuming verbosity…",
  "Squeegeeing the slide deck…",
  "Ironing creases in code…",
  "Folding proteins (mentally)…",
  "Unfolding plot twists…",
  "Mapping the unmapable…",
  "Greasing slide transitions…",
  "Waxing poetic (literally)…",
  "Buffing bullet aesthetics…",
  "Sandblasting jargon…",
  "Power-washing prose…",
  "Rebooting creativity…",
  "Sleeping on it (0.4s)…",
  "Channeling main character energy…",
  "Invoking ancient CSS…",
  "Sacrificing a semicolon…",
  "Reading tea leaves…",
  "Shuffling tarot tokens…",
  "Rolling for insight…",
  "Crit succeeded on Logic…",
  "Saving throw vs. confusion…",
  "Casting Comprehend Languages…",
  "Looting the knowledge base…",
  "Crafting epic explanations…",
  "Enchanting +2 clarity…",
  "Identifying mysterious files…",
  "Detecting hidden columns…",
  "Scrying the filesystem…",
  "Dowsing for data…",
  "Panning for paragraphs…",
  "Excavating Excel…",
  "Unearthing embeddings…",
  "Dusting off archives…",
  "Cataloging curiosities…",
  "Indexing intrigue…",
  "Curating chaos…",
  "Orchestrating outputs…",
  "Conducting the choir of chips…",
  "Tuning inference strings…",
  "Plucking insight harp…",
  "Jamming with Gauss…",
  "Freestyling formulas…",
  "Beat-matching bytes…",
  "Dropping the base(model)…",
  "Mixing metaphors…",
  "Rendering humility optional…",
  "Anti-aliasing attitudes…",
  "Supersampling substance…",
  "Ray-tracing relevance…",
  "Rasterizing revelations…",
  "Vectorizing verbiage…",
  "Bezier-curving conclusions…",
  "Gradient-descending into answers…",
  "Backpropagating brilliance…",
  "Forward-passing finesse…",
  "Quantizing qualms…",
  "Pruning panic…",
  "Distilling the good bits…",
  "Almost there (probably)…",
  "Making it look effortless…",
  "Pretending this was instant…",
  "Adding strategic pauses…",
  "Sprinkling enterprise fairy dust…",
  "Synergizing syllables…",
  "Leveraging lexical assets…",
  "Operationalizing opaqueness…",
  "Pivoting to awesome…",
  "Disrupting downtime…",
  "Thinking outside the chatbox…",
];

const STAGE_VERBS: Partial<Record<PipelineStageKind, string[]>> = {
  IntentLocked: [
    "Decoding your wish…",
    "Locking target coordinates…",
    "Parsing the plot…",
    "Choosing a cunning plan…",
  ],
  SearchingDisk: [
    "Raiding Documents folder…",
    "Interrogating filenames…",
    "Following breadcrumb trails…",
    "Shaking the file tree…",
  ],
  CrunchingMetrics: [
    "Crunching numbers aggressively…",
    "Teaching math to behave…",
    "Aggregating aggregates…",
    "Pivot-table meditation…",
  ],
  WritingCode: [
    "Forging HTML majesty…",
    "Typing with dramatic flair…",
    "Laying out the landing…",
    "Stuffing slides with style…",
  ],
};

export type GenerationProgressMode =
  | "chat"
  | "vision"
  | "mindmap"
  | "rag"
  | "artifact";

const ETA_SECONDS: Record<GenerationProgressMode, number> = {
  chat: 35,
  vision: 22,
  mindmap: 28,
  rag: 18,
  artifact: 55,
};

const STAGE_ETA_FRACTION: Record<PipelineStageKind, number> = {
  IntentLocked: 0.08,
  SearchingDisk: 0.18,
  CrunchingMetrics: 0.28,
  WritingCode: 0.55,
  LivePreview: 1,
  Error: 1,
};

export function pickSpinnerVerb(
  seed: number,
  _mode: GenerationProgressMode,
  stage?: PipelineStageKind | null
): string {
  const stageList = stage ? STAGE_VERBS[stage] : undefined;
  const pool = stageList && stageList.length > 0 ? stageList : SPINNER_VERB_POOL;
  return pool[Math.abs(seed) % pool.length];
}

export function estimateEtaSeconds(
  mode: GenerationProgressMode,
  elapsedSec: number,
  stage?: PipelineStageKind | null
): number {
  const total =
    mode === "artifact" && stage
      ? ETA_SECONDS.artifact * (STAGE_ETA_FRACTION[stage] || 1)
      : ETA_SECONDS[mode];
  return Math.max(0, Math.ceil(total - elapsedSec));
}

export function useGenerationProgressLabel(
  active: boolean,
  mode: GenerationProgressMode,
  elapsedSec: number,
  stage?: PipelineStageKind | null,
  intervalMs = 2200
): { verb: string; etaSec: number } {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) {
      setTick(0);
      return;
    }
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [active, mode, stage, intervalMs]);

  return useMemo(
    () => ({
      verb: pickSpinnerVerb(tick, mode, stage),
      etaSec: estimateEtaSeconds(mode, elapsedSec, stage),
    }),
    [tick, mode, elapsedSec, stage]
  );
}
