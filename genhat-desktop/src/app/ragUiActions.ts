import { open } from "@tauri-apps/plugin-dialog";
import { Api } from "../api";
import type { IngestionStatus } from "../types";
import { useChatModeStore } from "../stores/chatModeStore";
import { useUIStore } from "../stores/uiStore";
import { loadRagDocs } from "./workspaceBridge";

export const DOCUMENT_PICKER_EXTENSIONS = [
  "pdf", "docx", "pptx", "xlsx", "xls", "ods",
  "txt", "md", "csv", "tsv", "json", "xml", "html", "htm",
  "rs", "py", "js", "ts", "jsx", "tsx", "java", "c", "cpp",
  "h", "go", "rb", "sh", "toml", "yaml", "yml", "css",
  "scss", "sql", "log", "ini", "cfg",
  "mp3", "wav", "m4a", "ogg", "flac",
];

export async function selectImage(): Promise<void> {
  const chatModeStore = useChatModeStore.getState();
  
  try {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Images",
          extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"],
        },
      ],
    });
    if (selected && typeof selected === "string") {
      chatModeStore.setImagePath(selected);
      const dataUrl = await Api.readImageBase64(selected);
      chatModeStore.setImagePreview(dataUrl);
    }
  } catch (err) {
    console.error("Failed to select image:", err);
  }
}

export async function attachDirectDocuments(): Promise<void> {
  const chatModeStore = useChatModeStore.getState();
  const uiStore = useUIStore.getState();
  
  try {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Documents",
          extensions: DOCUMENT_PICKER_EXTENSIONS,
        },
      ],
    });
    if (!selected) return;

    const files = Array.isArray(selected) ? selected : [selected];
    if (files.length === 0) return;

    const currentPaths = useChatModeStore.getState().directDocumentPaths;
    const merged = new Set(currentPaths);
    for (const filePath of files) {
      merged.add(filePath);
    }
    chatModeStore.setDirectDocumentPaths(Array.from(merged));
  } catch (err) {
    console.error("Failed to select direct documents:", err);
    uiStore.showError("Couldn't add those documents. Please try again.");
  }
}

export async function ingestFile(): Promise<void> {
  const chatModeStore = useChatModeStore.getState();
  const uiStore = useUIStore.getState();
  
  try {
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Documents",
          extensions: DOCUMENT_PICKER_EXTENSIONS,
        },
      ],
    });
    if (!selected) return;
    const files = Array.isArray(selected) ? selected : [selected];
    if (files.length === 0) return;

    // Add placeholder entries to the side panel immediately so users can
    // click to view the file while ingestion is still running.
    const placeholders: IngestionStatus[] = files.map((f, i) => ({
      doc_id: -(i + 1), // negative IDs to avoid clashing with real docs
      title: f.split(/[\\/]/).pop() || f,
      file_path: f,
      total_chunks: 0,
      embedded_chunks: 0,
      enriched_chunks: 0,
      phase: "ingesting",
    }));
    chatModeStore.setRagDocs((prev) => [...placeholders, ...prev]);

    chatModeStore.setRagIngesting(true);

    // Ingest all files in parallel so the UI doesn't hang waiting on each one.
    // As each file finishes, refresh the doc list to replace its placeholder.
    const results = await Promise.allSettled(
      files.map((f) =>
        Api.ingestDocument(f).then(async (res) => {
          await loadRagDocs(); // refresh side panel as each file completes
          return res;
        })
      )
    );

    await loadRagDocs();
    chatModeStore.setRagIngesting(false);

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      alert(
        failures.length === 1
          ? "One document couldn't be added. Please try again."
          : `${failures.length} documents couldn't be added. Please try again.`
      );
    }
  } catch (e) {
    console.error(e);
    chatModeStore.setRagIngesting(false);
    await loadRagDocs();
    uiStore.showError("Couldn't add those documents. Please try again.");
  }
}

export async function ingestDir(): Promise<void> {
  const chatModeStore = useChatModeStore.getState();
  const uiStore = useUIStore.getState();
  
  try {
    const selected = await open({ directory: true });
    if (selected && typeof selected === "string") {
      chatModeStore.setRagIngesting(true);
      await Api.ingestFolder(selected);
      await loadRagDocs();
      chatModeStore.setRagIngesting(false);
    }
  } catch (e) {
    console.error(e);
    chatModeStore.setRagIngesting(false);
    uiStore.showError("Couldn't add that folder. Please try again.");
  }
}

export async function deleteRagDoc(docId: number): Promise<void> {
  const chatModeStore = useChatModeStore.getState();
  const uiStore = useUIStore.getState();
  
  try {
    // Close the viewer if the deleted document is currently open
    const doc = chatModeStore.ragDocs.find((d) => d.doc_id === docId);
    if (doc) {
      const delPath = doc.file_path;
      if (uiStore.pdfViewerData && doc.title === uiStore.pdfViewerData.title) {
        uiStore.setPdfViewerData(null);
      }
      if (uiStore.docViewerFile && uiStore.docViewerFile.filePath === delPath) {
        uiStore.setDocViewerFile(null);
      }
    }

    await Api.deleteRagDocument(docId);
    await loadRagDocs();
  } catch (e) {
    console.error(e);
    uiStore.showError("Couldn't remove that document. Please try again.");
  }
}

export async function deleteAllRagDocs(): Promise<void> {
  const chatModeStore = useChatModeStore.getState();
  const uiStore = useUIStore.getState();
  
  if (chatModeStore.ragDocs.length === 0) return;
  if (!window.confirm("Remove every document from the library? This cannot be undone.")) return;

  try {
    uiStore.setPdfViewerData(null);
    uiStore.setDocViewerFile(null);
    await Api.deleteAllRagDocuments();
    await loadRagDocs();
  } catch (e) {
    console.error(e);
    uiStore.showError("Couldn't clear the library. Please try again.");
  }
}

export async function openDocViewer(doc: IngestionStatus): Promise<void> {
  const uiStore = useUIStore.getState();
  const VIEWABLE_EXTS = new Set([
    "txt", "md", "json", "xml", "html", "htm", "css", "js", "ts", "jsx", "tsx",
    "py", "java", "c", "cpp", "h", "go", "rs", "rb", "sh", "sql", "yaml", "yml", "toml",
    "csv", "tsv", "log", "ini", "cfg"
  ]);
  
  const ext = doc.file_path.split(".").pop()?.toLowerCase() || "";

  if (ext === "pdf") {
    // PDF uses the dedicated PdfViewer
    try {
      uiStore.setPdfLoading(true);
      const data = await Api.readFileBase64(doc.file_path);
      uiStore.setPdfViewerData({ data, title: doc.title });
      uiStore.setDocViewerFile(null); // Clear any other open viewer
    } catch (e) {
      console.error("Failed to load PDF:", e);
      uiStore.showError("Couldn't open that document. Please try again.");
    } finally {
      uiStore.setPdfLoading(false);
    }
  } else if (VIEWABLE_EXTS.has(ext)) {
    // Everything else uses the universal DocumentViewer
    uiStore.setDocViewerFile({ filePath: doc.file_path, title: doc.title });
    uiStore.setPdfViewerData(null); // Clear any PDF viewer
  }
}