const IFRAME_W = 1920;
const IFRAME_H = 1080;

async function waitForDeckReady(doc: Document): Promise<void> {
  try {
    await (doc as Document & { fonts?: FontFaceSet }).fonts?.ready;
  } catch {
    /* ignore */
  }
  const imgs = Array.from(doc.images ?? []);
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        })
    )
  );
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * Offscreen iframe with scripts so JS charts can paint.
 * Tear down after `fn` returns.
 */
export async function withDeckDocument<T>(
  html: string,
  fn: (doc: Document, win: Window) => Promise<T>
): Promise<T> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  Object.assign(iframe.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${IFRAME_W}px`,
    height: `${IFRAME_H}px`,
    border: "0",
    background: "#ffffff",
  } as CSSStyleDeclaration);
  document.body.appendChild(iframe);

  try {
    await new Promise<void>((resolve, reject) => {
      iframe.onload = () => resolve();
      iframe.onerror = () =>
        reject(new Error("Failed to load deck for export."));
      iframe.srcdoc = html;
    });

    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error("Cannot access deck document for export.");

    await waitForDeckReady(doc);
    return await fn(doc, win);
  } finally {
    iframe.remove();
  }
}
