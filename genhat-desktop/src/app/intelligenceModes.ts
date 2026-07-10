import { COPY } from "./copy";

export type IntelligenceMode = "fast" | "smart" | "deep";

export const INTELLIGENCE_MODE_ORDER: IntelligenceMode[] = ["fast", "smart", "deep"];

export const DEFAULT_INTELLIGENCE_MAPPING: Record<IntelligenceMode, string> = {
  fast: "qwen3.5-0_8b",
  smart: "lfm2.5-1.2b-thinking",
  deep: "gemma-4-e2b-it",
};

/** Built-in models that download from Hugging Face only (no Google Drive mirror). */
export const HF_ONLY_DOWNLOADABLE_MODEL_IDS = new Set<string>([
  "lfm2.5-1.2b-thinking",
  "gemma-4-e2b-it",
]);

const MODE_STORAGE_KEY = "nela:ux:intelligence-mode:v1";
const MAPPING_STORAGE_KEY = "nela:ux:intelligence-mapping:v1";
const SPECIFIC_PICKER_STORAGE_KEY = "nela:ux:intelligence-specific-picker:v1";

export interface IntelligenceModeOption {
  key: IntelligenceMode;
  label: string;
  hint: string;
}

export const INTELLIGENCE_MODE_OPTIONS: IntelligenceModeOption[] = [
  { key: "fast", label: COPY.intelligenceFast, hint: COPY.intelligenceFastHint },
  { key: "smart", label: COPY.intelligenceSmart, hint: COPY.intelligenceSmartHint },
  { key: "deep", label: COPY.intelligenceDeep, hint: COPY.intelligenceDeepHint },
];

export function readIntelligenceMode(): IntelligenceMode {
  try {
    const raw = localStorage.getItem(MODE_STORAGE_KEY);
    if (raw === "fast" || raw === "smart" || raw === "deep") return raw;
  } catch {
    /* ignore */
  }
  return "fast";
}

export function writeIntelligenceMode(mode: IntelligenceMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function readIntelligenceMapping(): Record<IntelligenceMode, string> {
  try {
    const raw = localStorage.getItem(MAPPING_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_INTELLIGENCE_MAPPING };
    const parsed = JSON.parse(raw) as Partial<Record<IntelligenceMode, string>>;
    return {
      fast: parsed.fast || DEFAULT_INTELLIGENCE_MAPPING.fast,
      smart: parsed.smart || DEFAULT_INTELLIGENCE_MAPPING.smart,
      deep: parsed.deep || DEFAULT_INTELLIGENCE_MAPPING.deep,
    };
  } catch {
    return { ...DEFAULT_INTELLIGENCE_MAPPING };
  }
}

export function writeIntelligenceMapping(mapping: Record<IntelligenceMode, string>): void {
  try {
    localStorage.setItem(MAPPING_STORAGE_KEY, JSON.stringify(mapping));
  } catch {
    /* ignore */
  }
}

export function readSpecificModelPicker(): boolean {
  try {
    return localStorage.getItem(SPECIFIC_PICKER_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSpecificModelPicker(value: boolean): void {
  try {
    localStorage.setItem(SPECIFIC_PICKER_STORAGE_KEY, value ? "true" : "false");
  } catch {
    /* ignore */
  }
}

export function resolveModeForModelId(
  modelId: string,
  mapping: Record<IntelligenceMode, string>
): IntelligenceMode | null {
  for (const mode of INTELLIGENCE_MODE_ORDER) {
    if (mapping[mode] === modelId) return mode;
  }
  return null;
}

export function modelIsDownloadable(model: {
  id?: string;
  gdrive_id?: string | null;
  downloadable?: boolean;
}): boolean {
  if (model.downloadable) return true;
  if (model.gdrive_id) return true;
  if (model.id && HF_ONLY_DOWNLOADABLE_MODEL_IDS.has(model.id)) return true;
  return false;
}

export function modelFileIsDownloadable(model: {
  path: string;
  gdrive_id?: string | null;
  downloadable?: boolean;
}): boolean {
  if (model.downloadable) return true;
  if (model.gdrive_id) return true;
  if (HF_ONLY_DOWNLOADABLE_MODEL_IDS.has(model.path)) return true;
  return false;
}
