import { create } from "zustand";

export type RagSourceSelection = {
  filePaths: string[];
  folderPaths: string[];
};

interface RagSourcePickerState {
  open: boolean;
  allowedExtensions: string[];
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
}) =>
  new Promise<RagSourceSelection | null>((resolve) => {
    ragPickerResolve = resolve;
    useRagSourcePickerStore.setState({
      open: true,
      allowedExtensions: opts.allowedExtensions,
    });
  });

export const useRagSourcePickerStore = create<RagSourcePickerState>(() => ({
  open: false,
  allowedExtensions: [],
}));

