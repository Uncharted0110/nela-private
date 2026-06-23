import { COPY } from "./copy";

export type ResponseStyle = "precise" | "balanced" | "creative";

export const RESPONSE_STYLE_PRESETS: Record<ResponseStyle, Record<string, string>> = {
  precise: { temp: "0.2", top_p: "0.85", top_k: "20", repeat_penalty: "1.1" },
  balanced: { temp: "0.7", top_p: "0.9", top_k: "40", repeat_penalty: "1.1" },
  creative: { temp: "1.0", top_p: "0.95", top_k: "80", repeat_penalty: "1.05" },
};

export function inferStyle(params: Record<string, string> | undefined): ResponseStyle {
  const t = Number.parseFloat(params?.temp ?? "0.7");
  if (!Number.isFinite(t)) return "balanced";
  if (t <= 0.4) return "precise";
  if (t >= 0.95) return "creative";
  return "balanced";
}

export const RESPONSE_STYLE_OPTIONS: Array<{ key: ResponseStyle; label: string; hint: string }> = [
  { key: "precise", label: COPY.responseStylePrecise, hint: COPY.responseStylePreciseHint },
  { key: "balanced", label: COPY.responseStyleBalanced, hint: COPY.responseStyleBalancedHint },
  { key: "creative", label: COPY.responseStyleCreative, hint: COPY.responseStyleCreativeHint },
];
