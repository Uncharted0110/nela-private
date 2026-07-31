import { create } from "zustand";

export type RagSourceSelection = {
  filePaths: string[];
  folderPaths: string[];
};

interface RagSourcePickerState {
  open: boolean;
  allowedExtensions: string[];
  foldersOnly: boolean;
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
}) =>
  new Promise<RagSourceSelection | null>((resolve) => {
    ragPickerResolve = resolve;
    useRagSourcePickerStore.setState({
      open: true,
      allowedExtensions: opts.allowedExtensions,
      foldersOnly: !!opts.foldersOnly,
    });
  });

export const useRagSourcePickerStore = create<RagSourcePickerState>(() => ({
  open: false,
  allowedExtensions: [],
  foldersOnly: false,
}));

