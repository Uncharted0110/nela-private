import { create } from "zustand";
import type { SlideImageCandidate } from "../app/send/slideImageCandidates";

export type ImagePickerRequest = {
  requestId: string;
  slideLabel: string;
  query: string;
  candidates: SlideImageCandidate[];
  status: "picking" | "resolved";
};

interface ImagePickerState {
  pending: ImagePickerRequest | null;
}

let pickerResolve: ((value: SlideImageCandidate | null) => void) | null = null;
let requestCounter = 0;

export const resolveImagePicker = (value: SlideImageCandidate | null) => {
  const resolver = pickerResolve;
  pickerResolve = null;
  useImagePickerStore.setState({
    pending: useImagePickerStore.getState().pending
      ? { ...useImagePickerStore.getState().pending!, status: "resolved" }
      : null,
  });
  // Clear after a tick so the UI can briefly acknowledge.
  queueMicrotask(() => {
    useImagePickerStore.setState({ pending: null });
  });
  resolver?.(value);
};

/** Cancel any open picker (panel close, path change, abort). */
export const cancelImagePicker = () => {
  if (!pickerResolve && !useImagePickerStore.getState().pending) return;
  resolveImagePicker(null);
};

/**
 * Publish candidates and wait for the user to pick one (or cancel).
 * Only one picker may be open at a time — a new open cancels the previous.
 */
export const openImagePicker = (opts: {
  slideLabel: string;
  query: string;
  candidates: SlideImageCandidate[];
}): Promise<SlideImageCandidate | null> => {
  // Cancel any prior pending pick so its awaiter unblocks.
  if (pickerResolve) {
    const prev = pickerResolve;
    pickerResolve = null;
    prev(null);
  }

  requestCounter += 1;
  const requestId = `img-pick-${requestCounter}`;

  return new Promise<SlideImageCandidate | null>((resolve) => {
    pickerResolve = resolve;
    useImagePickerStore.setState({
      pending: {
        requestId,
        slideLabel: opts.slideLabel,
        query: opts.query,
        candidates: opts.candidates,
        status: "picking",
      },
    });
  });
};

export const useImagePickerStore = create<ImagePickerState>(() => ({
  pending: null,
}));
