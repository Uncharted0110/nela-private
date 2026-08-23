import { create } from "zustand";

export type RagSourceSelection = {
  filePaths: string[];
  folderPaths: string[];
};

interface RagSourcePickerState {
  open: boolean;
  allowedExtensions: string[];
  foldersOnly: boolean;
  /** When true, folders are navigable but not selectable (chat attach). */
  filesOnly: boolean;
  title: string;
  confirmLabel: string;
}

let ragPickerResolve: ((value: RagSourceSelection | null) => void) | null = null;

export const resolveRagSourcePicker = (value: RagSourceSelection | null) => {
  const resolver = ragPickerResolve;
  ragPickerResolve = null;
  resolver?.(value);
  useRagSourcePickerStore.setState({ open: false });
};

export const openRagSourcePicker = (opts: {
  allowedExtensions: string[];
  foldersOnly?: boolean;
  filesOnly?: boolean;
  title?: string;
  confirmLabel?: string;
}) =>
  new Promise<RagSourceSelection | null>((resolve) => {
    ragPickerResolve = resolve;
    const foldersOnly = !!opts.foldersOnly;
    const filesOnly = !foldersOnly && !!opts.filesOnly;
    useRagSourcePickerStore.setState({
      open: true,
      allowedExtensions: opts.allowedExtensions,
      foldersOnly,
      filesOnly,
      title:
        opts.title ??
        (foldersOnly ? "Select folders to index" : "Select sources"),
      confirmLabel:
        opts.confirmLabel ??
        (foldersOnly ? "Use selected folders" : "Index selected"),
    });
  });

export const useRagSourcePickerStore = create<RagSourcePickerState>(() => ({
  open: false,
  allowedExtensions: [],
  foldersOnly: false,
  filesOnly: false,
  title: "Select sources",
  confirmLabel: "Index selected",
}));
