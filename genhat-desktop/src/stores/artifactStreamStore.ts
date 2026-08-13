/**
 * Live artifact body while a file is streaming.
 * Kept out of the chat session so CSV tokens do not re-render the whole app.
 */
import { create } from "zustand";

type ArtifactStreamType = "text/html" | "text/csv";

type ArtifactStreamState = {
  sessionId: string | null;
  type: ArtifactStreamType | null;
  csv: string;
  html: string;
  title: string;
  chars: number;
  sheetsSeen: number;
  active: boolean;
};

type ArtifactStreamActions = {
  begin: (input: {
    sessionId: string;
    type: ArtifactStreamType;
    title?: string;
  }) => void;
  setCsv: (csv: string, title?: string) => void;
  setHtml: (html: string, title?: string) => void;
  clear: () => void;
};

const empty: ArtifactStreamState = {
  sessionId: null,
  type: null,
  csv: "",
  html: "",
  title: "",
  chars: 0,
  sheetsSeen: 0,
  active: false,
};

function countCsvSheets(csv: string): number {
  const tagged = csv.match(/<nela-artifact\b[^>]*type\s*=\s*["']text\/csv["']/gi);
  if (tagged && tagged.length > 0) return tagged.length;
  return csv.trim() ? 1 : 0;
}

export const useArtifactStreamStore = create<
  ArtifactStreamState & ArtifactStreamActions
>((set) => ({
  ...empty,
  begin: (input) =>
    set({
      sessionId: input.sessionId,
      type: input.type,
      title: input.title || "",
      csv: "",
      html: "",
      chars: 0,
      sheetsSeen: 0,
      active: true,
    }),
  setCsv: (csv, title) =>
    set({
      type: "text/csv",
      csv,
      title: title || "",
      chars: csv.length,
      sheetsSeen: countCsvSheets(csv),
      active: true,
    }),
  setHtml: (html, title) =>
    set({
      type: "text/html",
      html,
      title: title || "",
      chars: html.length,
      active: true,
    }),
  clear: () => set(empty),
}));
