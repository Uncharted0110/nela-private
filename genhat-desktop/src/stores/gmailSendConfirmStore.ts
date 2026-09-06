import { create } from "zustand";

export type GmailDraft = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
};

export type GmailSendConfirmResult =
  | { confirmed: true; draft: GmailDraft }
  | { confirmed: false; reason: "user_cancelled" };

type PendingConfirm = {
  requestId: string;
  draft: GmailDraft;
};

interface GmailSendConfirmState {
  pending: PendingConfirm | null;
}

let confirmResolve: ((value: GmailSendConfirmResult) => void) | null = null;
let requestCounter = 0;

export const resolveGmailSendConfirm = (value: GmailSendConfirmResult) => {
  const resolver = confirmResolve;
  confirmResolve = null;
  useGmailSendConfirmStore.setState({ pending: null });
  resolver?.(value);
};

export const cancelGmailSendConfirm = () => {
  if (!confirmResolve && !useGmailSendConfirmStore.getState().pending) return;
  resolveGmailSendConfirm({ confirmed: false, reason: "user_cancelled" });
};

/**
 * Open the in-chat send confirm card and wait for Send or Cancel.
 * A new open cancels the previous pending confirm.
 */
export const openGmailSendConfirm = (
  draft: GmailDraft
): Promise<GmailSendConfirmResult> => {
  if (confirmResolve) {
    const prev = confirmResolve;
    confirmResolve = null;
    prev({ confirmed: false, reason: "user_cancelled" });
  }

  requestCounter += 1;
  const requestId = `gmail-send-${requestCounter}`;

  return new Promise<GmailSendConfirmResult>((resolve) => {
    confirmResolve = resolve;
    useGmailSendConfirmStore.setState({
      pending: { requestId, draft },
    });
  });
};

export const useGmailSendConfirmStore = create<GmailSendConfirmState>(() => ({
  pending: null,
}));
