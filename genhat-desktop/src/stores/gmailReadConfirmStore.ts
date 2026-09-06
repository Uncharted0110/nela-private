import { create } from "zustand";

export type GmailReadRequest = {
  /** Shown on the confirm card. */
  purpose: string;
  maxResults: number;
  query: string | null;
};

export type GmailReadConfirmResult =
  | { confirmed: true; request: GmailReadRequest }
  | { confirmed: false; reason: "user_cancelled" };

type PendingConfirm = {
  requestId: string;
  request: GmailReadRequest;
};

interface GmailReadConfirmState {
  pending: PendingConfirm | null;
}

let confirmResolve: ((value: GmailReadConfirmResult) => void) | null = null;
let requestCounter = 0;

export const resolveGmailReadConfirm = (value: GmailReadConfirmResult) => {
  const resolver = confirmResolve;
  confirmResolve = null;
  useGmailReadConfirmStore.setState({ pending: null });
  resolver?.(value);
};

export const cancelGmailReadConfirm = () => {
  if (!confirmResolve && !useGmailReadConfirmStore.getState().pending) return;
  resolveGmailReadConfirm({ confirmed: false, reason: "user_cancelled" });
};

export const openGmailReadConfirm = (
  request: GmailReadRequest
): Promise<GmailReadConfirmResult> => {
  if (confirmResolve) {
    const prev = confirmResolve;
    confirmResolve = null;
    prev({ confirmed: false, reason: "user_cancelled" });
  }

  requestCounter += 1;
  const requestId = `gmail-read-${requestCounter}`;

  return new Promise<GmailReadConfirmResult>((resolve) => {
    confirmResolve = resolve;
    useGmailReadConfirmStore.setState({
      pending: { requestId, request },
    });
  });
};

export const useGmailReadConfirmStore = create<GmailReadConfirmState>(() => ({
  pending: null,
}));
