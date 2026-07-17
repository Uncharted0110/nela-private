import { create } from "zustand";
import type {
  ModelFile,
  RegisteredModel,
  KittenTtsVoice,
} from "../types";
import type { IntelligenceMode } from "../app/intelligenceModes";
import {
  readIntelligenceMode,
  readIntelligenceMapping,
  readSpecificModelPicker,
} from "../app/intelligenceModes";
import { findRegisteredModelByIdentifier } from "../app/modelUtils";

function parseModelParamNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface GenerationOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
}

interface ModelState {
  models: ModelFile[];
  selectedModel: string;
  intelligenceMode: IntelligenceMode;
  intelligenceMapping: Record<IntelligenceMode, string>;
  useSpecificModelPicker: boolean;
  registeredModels: RegisteredModel[];
  modelCatalog: RegisteredModel[];
  sessionModelParamOverrides: Record<string, Record<string, string>>;
  modelLoadingStatus: { loading: boolean; modelId: string; message: string };
  modelSwitching: { active: boolean; targetLabel: string };
  ttsEngines: RegisteredModel[];
  selectedTtsEngine: string;
  ttsVoice: KittenTtsVoice;
  ttsSpeed: number;
  visionModels: RegisteredModel[];
  selectedVisionModel: string;
}

interface ModelActions {
  setModels: (models: ModelFile[]) => void;
  setSelectedModel: (model: string | ((prev: string) => string)) => void;
  setIntelligenceMode: (mode: IntelligenceMode) => void;
  setIntelligenceMapping: (mapping: Record<IntelligenceMode, string>) => void;
  setUseSpecificModelPicker: (use: boolean) => void;
  setRegisteredModels: (models: RegisteredModel[]) => void;
  setModelCatalog: (catalog: RegisteredModel[]) => void;
  setSessionModelParamOverrides: (
    overrides:
      | Record<string, Record<string, string>>
      | ((prev: Record<string, Record<string, string>>) => Record<string, Record<string, string>>)
  ) => void;
  setModelLoadingStatus: (status: {
    loading: boolean;
    modelId: string;
    message: string;
  }) => void;
  setModelSwitching: (switching: { active: boolean; targetLabel: string }) => void;
  setTtsEngines: (engines: RegisteredModel[]) => void;
  setSelectedTtsEngine: (engine: string | ((prev: string) => string)) => void;
  setTtsVoice: (voice: KittenTtsVoice) => void;
  setTtsSpeed: (speed: number) => void;
  setVisionModels: (models: RegisteredModel[]) => void;
  setSelectedVisionModel: (model: string | ((prev: string) => string)) => void;
  getModelParams: (modelIdentifier: string | null | undefined) => Record<string, string>;
  getChatGenerationOptions: (
    modelIdentifier: string | null | undefined
  ) => GenerationOptions;
  getContextWindowTokens: (modelIdentifier: string | null | undefined) => number;
}

export const useModelStore = create<ModelState & ModelActions>((set, get) => ({
  models: [],
  selectedModel: "",
  intelligenceMode: readIntelligenceMode(),
  intelligenceMapping: readIntelligenceMapping(),
  useSpecificModelPicker: readSpecificModelPicker(),
  registeredModels: [],
  modelCatalog: [],
  sessionModelParamOverrides: {},
  modelLoadingStatus: { loading: false, modelId: "", message: "" },
  modelSwitching: { active: false, targetLabel: "" },
  ttsEngines: [],
  selectedTtsEngine: "",
  ttsVoice: "Leo",
  ttsSpeed: 1.0,
  visionModels: [],
  selectedVisionModel: "",

  setModels: (models) => set({ models }),

  setSelectedModel: (selectedModel) =>
    set((state) => ({
      selectedModel:
        typeof selectedModel === "function"
          ? selectedModel(state.selectedModel)
          : selectedModel,
    })),

  setIntelligenceMode: (intelligenceMode) => set({ intelligenceMode }),

  setIntelligenceMapping: (intelligenceMapping) => set({ intelligenceMapping }),

  setUseSpecificModelPicker: (useSpecificModelPicker) =>
    set({ useSpecificModelPicker }),

  setRegisteredModels: (registeredModels) => set({ registeredModels }),

  setModelCatalog: (modelCatalog) => set({ modelCatalog }),

  setSessionModelParamOverrides: (overrides) =>
    set((state) => ({
      sessionModelParamOverrides:
        typeof overrides === "function"
          ? overrides(state.sessionModelParamOverrides)
          : overrides,
    })),

  setModelLoadingStatus: (modelLoadingStatus) => set({ modelLoadingStatus }),

  setModelSwitching: (modelSwitching) => set({ modelSwitching }),

  setTtsEngines: (ttsEngines) => set({ ttsEngines }),

  setSelectedTtsEngine: (selectedTtsEngine) =>
    set((state) => ({
      selectedTtsEngine:
        typeof selectedTtsEngine === "function"
          ? selectedTtsEngine(state.selectedTtsEngine)
          : selectedTtsEngine,
    })),

  setTtsVoice: (ttsVoice) => set({ ttsVoice }),

  setTtsSpeed: (ttsSpeed) => set({ ttsSpeed }),

  setVisionModels: (visionModels) => set({ visionModels }),

  setSelectedVisionModel: (selectedVisionModel) =>
    set((state) => ({
      selectedVisionModel:
        typeof selectedVisionModel === "function"
          ? selectedVisionModel(state.selectedVisionModel)
          : selectedVisionModel,
    })),

  getModelParams: (modelIdentifier) => {
    if (!modelIdentifier) return {};
    const state = get();
    const registered = findRegisteredModelByIdentifier(
      state.registeredModels,
      modelIdentifier
    );
    const persisted = registered?.params ?? {};
    const override =
      state.sessionModelParamOverrides[registered?.id ?? modelIdentifier] ??
      state.sessionModelParamOverrides[modelIdentifier] ??
      {};
    return { ...persisted, ...override };
  },

  getChatGenerationOptions: (modelIdentifier) => {
    const params = get().getModelParams(modelIdentifier);
    return {
      maxTokens: parseModelParamNumber(params.max_tokens),
      temperature: parseModelParamNumber(params.temp),
      topP: parseModelParamNumber(params.top_p),
      topK: parseModelParamNumber(params.top_k),
      repeatPenalty: parseModelParamNumber(params.repeat_penalty),
    };
  },

  getContextWindowTokens: (modelIdentifier) => {
    const params = get().getModelParams(modelIdentifier);
    const ctxSize = parseModelParamNumber(params.ctx_size);
    if (ctxSize === undefined) return 4096;
    return Math.max(1024, Math.min(262_144, Math.round(ctxSize)));
  },
}));
