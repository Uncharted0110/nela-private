# NELA — Non-Technical User UX Improvement Spec

> **Audience for this document:** an autonomous coding agent that makes **code changes only** (no version control, no pull requests, no commits — just edit the files).
> **Goal:** make NELA usable and trustworthy for non-technical, privacy-focused professionals (lawyers, clinicians, accountants, HR, government) without removing power-user capability.
> **Repository:** `Uncharted0110/nela-private`
> **Working directory for ALL tasks:** `genhat-desktop/`
> **Backend edits are allowed and expected where specified.** When a task has a "Backend changes" section, implement it in `src-tauri/` (Rust).

---

## 0. Global rules (READ FIRST — applies to every task)

1. **Do not change runtime/AI behavior** unless a task explicitly says so. Renaming a label is allowed; changing what a toggle *does* is not (except where a task explicitly redefines behavior, e.g. Task 9).
2. **Frontend + backend.** Edit `src/` (TypeScript/React) and, where a task's "Backend changes" section says so, `src-tauri/` (Rust).
3. **Preserve all `data-tour="..."` attributes** exactly. The tour system (`src/tours.tsx`, `src/hooks/useTour.tsx`) targets them by string. If you move an element, keep its `data-tour` attribute on it.
4. **Validate your work:**
   - Frontend: `cd genhat-desktop && npm run lint && npm run build` must both succeed.
   - Backend (if you edited Rust): `cd genhat-desktop/src-tauri && cargo check` must succeed.
   - Fix anything you break.
5. **Do not add new npm dependencies** unless a task explicitly allows it. Use what is already in `package.json` (React 19, lucide-react, Tailwind v4, Tauri API).
6. **Styling:** the project uses Tailwind utility classes inline plus per-component `.css` files and CSS custom properties (design tokens like `bg-void-900`, `text-neon`, `text-txt-muted`). When a task says "use a token," use the existing token; do not hardcode hex values unless a task tells you to.
7. **Copy rules (the whole point of this spec):** these words must NEVER appear in user-facing UI text (labels, tooltips, placeholders, empty states, badges) in **simple mode**:
   `RAG`, `ingest`, `ingesting`, `ingested`, `chunk`, `chunks`, `phase1`, `phase2`, `embedding`, `embed`, `enrichment`, `token`/`tokens`, `RRF`, `vector`, `BM25`, `HyDE`, `RAPTOR`, `GGUF`.
   They may remain in **code identifiers, comments, variable names, and Advanced-mode-only screens.**
8. **`.github` docs sync:** after a task changes user-facing behavior, append one concise bullet to `.github/copilot-instructions.md` under a section called `## UX (non-technical mode)` (create the section if missing). Do not rewrite large sections — append short bullets. This repo has a documented sync policy; keep it satisfied.
9. **Accessibility baseline for any button you touch:** if a button is icon-only, it MUST have an `aria-label`. Prefer `aria-label` over relying on `title` alone (keep `title` for the hover tooltip if present).

---

## Shared foundation (IMPLEMENT FIRST — Tasks 4, 6, 8, 9, 11, 12 depend on it)

Create these two small modules before the dependent tasks.

### F1. Advanced-mode hook

Create `src/hooks/useAdvancedMode.ts`:

```ts
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "nela:ux:advancedMode:v1";
const EVENT_NAME = "nela:advanced-mode-changed";

/** Read the current advanced-mode flag from localStorage (default: false = simple mode). */
export function getAdvancedMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Set the advanced-mode flag and broadcast the change to all hook instances. */
export function setAdvancedMode(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
  } catch {
    /* ignore storage errors (private mode, etc.) */
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: value }));
}

/**
 * React hook for advanced mode.
 * `advanced` is the current value; `setAdvanced` updates it everywhere.
 * Defaults to FALSE — non-technical "simple" mode is the default experience.
 */
export function useAdvancedMode(): { advanced: boolean; setAdvanced: (v: boolean) => void } {
  const [advanced, setAdvancedState] = useState<boolean>(() => getAdvancedMode());

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      setAdvancedState(Boolean(detail));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setAdvancedState(e.newValue === "true");
    };
    window.addEventListener(EVENT_NAME, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setAdvanced = useCallback((v: boolean) => setAdvancedMode(v), []);
  return { advanced, setAdvanced };
}
```

### F2. Central copy/label map

Create `src/app/copy.ts`. This is the single source of truth for user-facing strings that replace jargon. Every task that renames something imports from here.

```ts
/**
 * Central user-facing copy. Non-technical "simple mode" wording lives here so
 * we never scatter jargon across components. Code identifiers keep their
 * original technical names; only the DISPLAYED text comes from this file.
 */
export const COPY = {
  // Tools menu (was: RAG / Web search / Thinking)
  toolSearchDocs: "Search my documents",
  toolSearchDocsHint: "Look through documents you've added to answer your question.",
  toolSearchWeb: "Search the web",
  toolSearchWebHint: "Allow looking things up online for this question.",
  toolShowReasoning: "Show reasoning", // advanced-only; see Task 12
  toolShowReasoningHint: "Show the assistant's step-by-step thinking.",

  // Attach menu (was: Add Files / Ingest / direct)
  addDocumentsTitle: "Add documents",
  addDocumentsHint: "PDF, Word, PowerPoint, text, and more.",
  addFolderTitle: "Add a folder",
  addFolderHint: "Add every supported file in a folder.",
  uploadImageTitle: "Upload an image",
  uploadImageHint: "JPG, PNG, WEBP, GIF, or BMP.",

  // Knowledge base (was: Knowledge Base / chunks / phaseN / ingesting)
  libraryTitle: "Document Library",
  libraryEmpty: "No documents yet. Use \u201CAdd documents\u201D to get started.",
  docStateAdding: "Adding\u2026",
  docStateReady: "Ready",
  docStateEnhanced: "Enhanced",
  processing: "Processing\u2026",

  // Sources (was: score: 0.0473)
  sourcesTitle: "Sources",
  relevanceHigh: "High relevance",
  relevanceMedium: "Medium relevance",
  relevanceLow: "Low relevance",

  // Auto-scan (was: Auto-scan Folders / watched paths)
  syncFolderTitle: "Keep a folder in sync",
  syncFolderReassure: "Files are read and indexed on this device only.",
  syncFolderEmpty: "No folders yet. Add one to keep it in sync automatically.",

  // Privacy indicator (Task 1)
  privacyPrivate: "Private \u00B7 on this device",
  privacyPrivateTooltip:
    "Everything you do stays on this computer. Nothing is sent anywhere. The only time NELA uses the internet is when you choose to download a model.",
  privacyNetwork: "Downloading model\u2026",
  privacyNetworkTooltip:
    "NELA is downloading a model from the internet right now. This is the only time it goes online. Your documents and chats are never uploaded.",

  // Response style (Task 4)
  responseStyleLabel: "Response style",
  responseStylePrecise: "Precise",
  responseStylePreciseHint: "Focused, consistent answers. Best for facts and analysis.",
  responseStyleBalanced: "Balanced",
  responseStyleBalancedHint: "A mix of accuracy and flexibility. Good default.",
  responseStyleCreative: "Creative",
  responseStyleCreativeHint: "More varied, imaginative answers.",

  // Generic errors (Task 10)
  errorNotReady: "NELA is still getting ready. Please try again in a moment.",
  errorGeneric: "Something went wrong. Please try again.",
  retry: "Try again",
} as const;

export type CopyKey = keyof typeof COPY;
```

> After F1 and F2 exist, the remaining tasks can be done in any order. Tasks that depend on the foundation note it in their header.

---

# TASK 1 — Persistent "Private · on this device" indicator

**Depends on:** F2 (copy).
**Impact:** highest. Makes the core privacy value visible on every screen.

### Files

- New: `src/components/PrivacyIndicator.tsx`
- New: `src/hooks/useNetworkActivity.ts`
- Edit: `src/components/AppMainTopBar.tsx` (render the indicator)
- Edit: the component that renders `AppMainTopBar` (likely `App.tsx` or `app-backend.tsx`) to supply `networkActive`.

### Behavior

- Default: a small pill with a **lock icon** + **"Private · on this device"** (`COPY.privacyPrivate`).
- During a model download: pill switches to a **globe icon** + **"Downloading model…"** (`COPY.privacyNetwork`) with a pulsing dot.
- Hover shows the matching tooltip (`privacyPrivateTooltip` / `privacyNetworkTooltip`).
- Keyboard-focusable; `aria-label` equals the visible text.

### Component code

Create `src/components/PrivacyIndicator.tsx`:

```tsx
import React from "react";
import { ShieldCheck, Globe } from "lucide-react";
import { COPY } from "../app/copy";

interface PrivacyIndicatorProps {
  /** True only while a model download (the sole outbound activity) is running. */
  networkActive?: boolean;
}

/**
 * Always-visible trust indicator. Default = fully private/offline.
 * Flips to "Downloading model…" only during an explicit model download.
 */
const PrivacyIndicator: React.FC<PrivacyIndicatorProps> = ({ networkActive = false }) => {
  const label = networkActive ? COPY.privacyNetwork : COPY.privacyPrivate;
  const tooltip = networkActive ? COPY.privacyNetworkTooltip : COPY.privacyPrivateTooltip;

  return (
    <div
      role="status"
      aria-label={label}
      title={tooltip}
      tabIndex={0}
      data-tour="privacy-indicator"
      className={[
        "inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full border text-[0.78rem] font-medium select-none",
        "transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-0",
        networkActive
          ? "border-amber-400/40 bg-amber-400/10 text-amber-200 focus-visible:ring-amber-300/50"
          : "border-emerald-400/40 bg-emerald-400/10 text-emerald-200 focus-visible:ring-emerald-300/50",
      ].join(" ")}
    >
      {networkActive ? (
        <>
          <Globe size={13} className="shrink-0" />
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-300 opacity-75 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-300" />
          </span>
        </>
      ) : (
        <ShieldCheck size={13} className="shrink-0" />
      )}
      <span className="leading-none">{label}</span>
    </div>
  );
};

export default PrivacyIndicator;
```

### Network-activity hook

Create `src/hooks/useNetworkActivity.ts`:

```ts
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Tracks whether any model download is currently running.
 * Listens to the download lifecycle events emitted by the Rust backend.
 *
 * IMPORTANT: confirm these event names against the codebase. Search src-tauri
 * for `emit(` / `app.emit(` calls related to downloads (e.g. "download:progress",
 * "download:started", "download:complete", "download:finished", "download:error").
 * Update the strings below to match what the backend actually emits.
 */
export function useNetworkActivity(): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let inFlight = 0;
    const bump = (delta: number) => {
      inFlight = Math.max(0, inFlight + delta);
      setActive(inFlight > 0);
    };

    const wire = async () => {
      unsubs.push(await listen("download:started", () => bump(+1)));
      unsubs.push(await listen("download:progress", () => setActive(true)));
      unsubs.push(await listen("download:finished", () => bump(-1)));
      unsubs.push(await listen("download:complete", () => bump(-1)));
      unsubs.push(await listen("download:error", () => bump(-1)));
      unsubs.push(await listen("download:cancelled", () => bump(-1)));
    };
    void wire();

    return () => {
      unsubs.forEach((u) => u());
    };
  }, []);

  return active;
}
```

### Wiring

1. In `AppMainTopBar.tsx`: `import PrivacyIndicator from "./PrivacyIndicator";`. Render `<PrivacyIndicator networkActive={networkActive} />` in the **leading (left) position** of the top bar. Add `networkActive?: boolean;` to its props and thread it through.
2. In the parent that renders `AppMainTopBar`: `const networkActive = useNetworkActivity();` and pass it down.
3. **Verify the event names** in `useNetworkActivity.ts` by searching `src-tauri` for download `emit` calls; update strings to match. The download command lives around `src-tauri/src/commands/download.rs`.

> **Fallback if download events cannot be confirmed:** render the indicator permanently in the "Private" state (`networkActive={false}`). The static private indicator alone delivers most of the value.

### Acceptance criteria

- [ ] A lock pill "Private · on this device" is visible in the top bar at all times.
- [ ] Hover shows the reassurance tooltip.
- [ ] (If events wired) starting a model download flips it to "Downloading model…" and it reverts when the download ends.
- [ ] Pill is keyboard-focusable with a visible focus ring and correct `aria-label`.
- [ ] Lint + build pass.

---

# TASK 2 — Plain-language relabel of the chat Tools & Attach menus

**Depends on:** F2.
**File:** `src/components/ChatWindow.tsx` only.
**Rule:** **Do not change behavior or handlers.** Only change displayed text, tooltips, and `aria-label`s. Keep `onToggleRagEnabled`, `onToggleWebEnabled`, `onToggleThinking` and their wiring intact.

Add `import { COPY } from "../app/copy";`.

### 2A. Tools menu (`renderToolsMenu`)

- RAG toggle: visible text `RAG` → `{COPY.toolSearchDocs}`. Enabled tooltip → `COPY.toolSearchDocsHint`; disabled tooltip → `"Available when chatting"`. Add `aria-label={COPY.toolSearchDocs}`.
- Web search toggle: visible text `Web search` → `{COPY.toolSearchWeb}`. Enabled tooltip → `COPY.toolSearchWebHint`; disabled → `"Available when chatting"`. Add `aria-label`.
- Web depth sub-control: `Snippets` → `"Quick"`, `Full` → `"Thorough"`. Add `aria-label="Quick web results"` / `aria-label="Thorough web results"`.
- Thinking toggle: visible text `Thinking` → `{COPY.toolShowReasoning}`. Add `aria-label`. (Task 12 hides this in simple mode.)

### 2B. Attach menu (`renderAttachMenu`)

- Vision branch: "Upload Image" → `{COPY.uploadImageTitle}`; "JPG, PNG, WEBP, GIF, BMP" → `{COPY.uploadImageHint}`.
- Direct-attach branch (`chatMode === "text" && !ragEnabled`): "Attach Files" → `{COPY.addDocumentsTitle}`; "Send directly to model" → `{COPY.addDocumentsHint}`.
- KB branch (else): "Add Files" → `{COPY.addDocumentsTitle}`; "PDF, DOCX, TXT, code..." → `{COPY.addDocumentsHint}`. "Add Folder" → `{COPY.addFolderTitle}`; "Ingest entire directory" → `{COPY.addFolderHint}`.

### 2C. Attach button tooltip

The `+` button's `title` cycles between "Upload image" / "Attach documents directly to the model" / "Add documents to knowledge base". Replace with `COPY.uploadImageTitle` (vision) and `COPY.addDocumentsTitle` (both text branches). Add an `aria-label` (image variant in vision mode, otherwise `COPY.addDocumentsTitle`).

### 2D. Knowledge-base pill in the input row

Both input rows render a pill reading `Knowledge Base` (no docs) or `${ragDocs.length} files loaded`. Change the `"Knowledge Base"` literal to `COPY.libraryTitle`. Keep pluralization. Change `title="Toggle knowledge base panel"` → `"Show or hide your documents"`.

### Acceptance criteria

- [ ] No `RAG`, `ingest`, `chunk`, `directly to model`, or `Knowledge Base` text remains visible in `ChatWindow.tsx`.
- [ ] All toggles still call the same handlers.
- [ ] Every icon-only button touched has an `aria-label`.
- [ ] Lint + build pass.

---

# TASK 3 — Humanize the Document Library sidebar

**Depends on:** F2.
**File:** `src/components/KnowledgeBaseSidebar.tsx` only.

Add `import { COPY } from "../app/copy";`.

### 3A. Title & buttons

- Header `Knowledge Base` → `{COPY.libraryTitle}`. Close button: add `aria-label="Close document library"`.
- `Add Files` → `{COPY.addDocumentsTitle}`; `Add Folder` → `{COPY.addFolderTitle}`. Add `aria-label`s.

### 3B. Per-document row: remove jargon

Add this helper after imports:

```ts
/** Map internal ingestion phase + placeholder state to a friendly status. */
function friendlyDocStatus(phase: string, isPlaceholder: boolean): {
  label: string;
  tone: "adding" | "ready" | "enhanced";
} {
  if (isPlaceholder) return { label: "Adding\u2026", tone: "adding" };
  if (phase.includes("phase2_complete")) return { label: "Enhanced", tone: "enhanced" };
  if (phase.includes("phase2")) return { label: "Ready", tone: "ready" };
  return { label: "Ready", tone: "ready" };
}
```

In the row JSX:
- **Delete** the `{doc.total_chunks} chunks` span.
- Replace the phase pill content with `friendlyDocStatus(...).label`, colored by `tone`:
  - `adding` → amber pill + `Loader2` spinner,
  - `ready` → neutral/blue pill,
  - `enhanced` → green pill + `CheckCircle2` icon (no emoji).
- Keep click-to-view and delete. Add `aria-label="Remove document"` to the trash button.

### 3C. Status strip

- `Ingesting...` → `{COPY.processing}`.
- For `enrichmentStatus`: if truthy, show `{COPY.docStateEnhanced}` with the check icon; **do not print the raw string** (it may contain "enrichment"/"RAPTOR").

### 3D. Empty state

`No documents ingested yet. Use the buttons above to add files.` → `{COPY.libraryEmpty}`.

### 3E. Sources panel — remove raw score

In the Sources `<details>` summary, remove `(score: {src.score.toFixed(4)})`. Add this helper and render a relevance word instead:

```ts
function relevanceLabel(score: number): string {
  // RRF scores are small positive numbers; rank-relative, not absolute.
  if (score >= 0.03) return "High relevance";
  if (score >= 0.015) return "Medium relevance";
  return "Low relevance";
}
```

Render `{relevanceLabel(src.score)}`. Keep the source title and `formatPageLabel(src.page_info)`.
*(Task 5 upgrades this to a real backend grade.)*

### 3F. Auto-scan section

- `Auto-scan Folders` → `{COPY.syncFolderTitle}`. Add a muted line `{COPY.syncFolderReassure}` under the header. Empty state → `{COPY.syncFolderEmpty}`.
- Add `aria-label="Re-scan folders"` and `aria-label="Add a folder to keep in sync"` to the icon buttons.

### Acceptance criteria

- [ ] No "chunks", "phaseN", "ingest", "enrichment", "Knowledge Base", or raw `score:` text visible.
- [ ] Each document shows exactly one friendly status: Adding… / Ready / Enhanced.
- [ ] Sources show a relevance word, not a number.
- [ ] All icon buttons have `aria-label`s.
- [ ] Lint + build pass.

---

# TASK 4 — Replace the parameter dock with a "Response style" control (simple mode)

**Depends on:** F1, F2.
**Impact:** removes the scariest technical surface for non-tech users while preserving full control for power users.

### Concept

- Simple mode (default): a 3-option **Response style** control (Precise / Balanced / Creative). Each maps to existing params (`temp`, `top_p`, `top_k`, `repeat_penalty`) and calls the SAME apply path the dock already uses.
- Advanced mode: the existing `ActiveModelParamsDock` renders unchanged.

### Files

- New: `src/components/ResponseStyleControl.tsx`
- Edit: every render site of `ActiveModelParamsDock` (search the codebase) to conditionally render `ResponseStyleControl` (simple) vs `ActiveModelParamsDock` (advanced).

### Component code

Create `src/components/ResponseStyleControl.tsx`:

```tsx
import React, { useMemo, useState } from "react";
import { Loader2, CheckCircle } from "lucide-react";
import { COPY } from "../app/copy";

export type ResponseStyle = "precise" | "balanced" | "creative";

export const RESPONSE_STYLE_PRESETS: Record<ResponseStyle, Record<string, string>> = {
  precise:  { temp: "0.2", top_p: "0.85", top_k: "20", repeat_penalty: "1.1" },
  balanced: { temp: "0.7", top_p: "0.9",  top_k: "40", repeat_penalty: "1.1" },
  creative: { temp: "1.0", top_p: "0.95", top_k: "80", repeat_penalty: "1.05" },
};

export function inferStyle(params: Record<string, string> | undefined): ResponseStyle {
  const t = Number.parseFloat(params?.temp ?? "0.7");
  if (!Number.isFinite(t)) return "balanced";
  if (t <= 0.4) return "precise";
  if (t >= 0.95) return "creative";
  return "balanced";
}

interface ResponseStyleControlProps {
  /** Current params for the active model (to highlight the matching style). */
  currentParams?: Record<string, string>;
  /** Same apply path the advanced dock uses. Merges with existing params upstream. */
  onApply: (params: Record<string, string>) => Promise<void>;
  /** Only applies to text-generation (LlamaServer) models. */
  disabled?: boolean;
}

const STYLES: Array<{ key: ResponseStyle; label: string; hint: string }> = [
  { key: "precise", label: COPY.responseStylePrecise, hint: COPY.responseStylePreciseHint },
  { key: "balanced", label: COPY.responseStyleBalanced, hint: COPY.responseStyleBalancedHint },
  { key: "creative", label: COPY.responseStyleCreative, hint: COPY.responseStyleCreativeHint },
];

const ResponseStyleControl: React.FC<ResponseStyleControlProps> = ({
  currentParams,
  onApply,
  disabled = false,
}) => {
  const initial = useMemo(() => inferStyle(currentParams), [currentParams]);
  const [selected, setSelected] = useState<ResponseStyle>(initial);
  const [saving, setSaving] = useState<ResponseStyle | null>(null);
  const [savedStyle, setSavedStyle] = useState<ResponseStyle | null>(null);

  const choose = async (style: ResponseStyle) => {
    if (disabled || saving) return;
    setSelected(style);
    setSaving(style);
    try {
      await onApply(RESPONSE_STYLE_PRESETS[style]);
      setSavedStyle(style);
      window.setTimeout(() => setSavedStyle(null), 1600);
    } catch {
      /* keep UI calm; selection simply won't show the check */
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="p-3">
      <div className="text-[0.8rem] font-semibold text-txt mb-2">{COPY.responseStyleLabel}</div>
      <div role="radiogroup" aria-label={COPY.responseStyleLabel} className="flex flex-col gap-2">
        {STYLES.map((s) => {
          const active = selected === s.key;
          return (
            <button
              key={s.key}
              role="radio"
              aria-checked={active}
              aria-label={`${s.label}. ${s.hint}`}
              disabled={disabled || saving !== null}
              onClick={() => void choose(s.key)}
              className={[
                "w-full text-left rounded-xl border px-3 py-2.5 transition-all duration-150",
                "outline-none focus-visible:ring-2 focus-visible:ring-sky-300/50",
                active
                  ? "border-sky-400/50 bg-sky-400/10"
                  : "border-glass-border bg-void-700/50 hover:border-glass-border hover:bg-glass-hover",
                disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
              ].join(" ")}
            >
              <div className="flex items-center justify-between">
                <span className="text-[0.82rem] font-semibold text-txt">{s.label}</span>
                {saving === s.key ? (
                  <Loader2 size={14} className="animate-spin text-sky-300" />
                ) : savedStyle === s.key ? (
                  <CheckCircle size={14} className="text-emerald-300" />
                ) : null}
              </div>
              <div className="text-[0.78rem] text-txt-muted mt-0.5">{s.hint}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ResponseStyleControl;
```

### Wiring

At each render site of `ActiveModelParamsDock`:

```tsx
import { useAdvancedMode } from "../hooks/useAdvancedMode";
import ResponseStyleControl from "./ResponseStyleControl";
// ...
const { advanced } = useAdvancedMode();
// `target` is the existing RuntimeParamsTarget; `applyParams` is the existing async apply handler.

{advanced ? (
  <ActiveModelParamsDock target={target} onApply={applyParams} onClose={onClose} />
) : (
  <ResponseStyleControl
    currentParams={target?.params}
    onApply={applyParams}
    disabled={target?.backend !== "LlamaServer"}
  />
)}
```

### Acceptance criteria

- [ ] Default mode shows only Precise/Balanced/Creative.
- [ ] Selecting a style calls the existing apply path and the model picks up new params.
- [ ] Advanced mode shows the original dock unchanged.
- [ ] Radio group is keyboard-navigable with `aria-checked`.
- [ ] Lint + build pass.

---

# TASK 5 — Surface a real relevance grade for sources (backend + frontend)

**Depends on:** Task 3.

### Backend changes (`src-tauri/`)

The RAG pipeline grades chunks 1–5 internally (`grade_chunk` in `src-tauri/src/rag/pipeline.rs`) but discards the grade before returning `SourceChunk`. Expose it.

1. In `src-tauri/src/rag/pipeline.rs`, add a field to `SourceChunk`:
   ```rust
   /// Optional cross-encoder relevance grade (1-5). None if grading was unavailable.
   #[serde(default)]
   pub grade: Option<u8>,
   ```
2. At every place a `SourceChunk` is constructed, set `grade`:
   - In graded paths (`query`, `retrieve_for_query`): set `grade: Some(grade)` using the `grade` value computed in that scope (the `u8` from `grade_chunk` / `select_graded_sources`). If the grade is only available as part of `graded_sources`, carry it through into the `SourceChunk` you build.
   - In ungraded paths (RAPTOR retrieval, plain `retrieve`, rephrase-retry sources): set `grade: None`.
3. Keep the existing `score` field (do not remove it).
4. Run `cargo check` in `src-tauri/`.

### Frontend changes (`src/`)

1. In `src/types.ts`, add to `SourceChunk`:
   ```ts
   /** Optional relevance grade (1-5) from the backend. */
   grade?: number | null;
   ```
2. In `KnowledgeBaseSidebar.tsx`, replace the Task 3 `relevanceLabel` usage with a grade-preferring version:
   ```ts
   function relevanceLabelFromGradeOrScore(grade: number | null | undefined, score: number): string {
     if (typeof grade === "number") {
       if (grade >= 4) return "High relevance";
       if (grade >= 3) return "Medium relevance";
       return "Low relevance";
     }
     if (score >= 0.03) return "High relevance";
     if (score >= 0.015) return "Medium relevance";
     return "Low relevance";
   }
   ```
   Render `{relevanceLabelFromGradeOrScore(src.grade, src.score)}`.

### Acceptance criteria

- [ ] `SourceChunk` carries `grade`; `cargo check` passes.
- [ ] Sources display a grade-based relevance word (falling back to the score heuristic when grade is null).
- [ ] Lint + build pass.

---

# TASK 6 — Rewrite the default onboarding tour (task/privacy-first)

**Depends on:** F1, Task 1 (privacy indicator target), F2.
**File:** `src/tours.tsx` (primarily).

### Changes

Replace the `getting-started` tour's steps with a trust- and task-first sequence. **Keep all other tours** (`models`, `mindmaps`, `podcast`, `documents`, `audio-prompting`, `audio-tts`) intact. **Remove the model/parameter steps from `getting-started`.**

New `getting-started` steps (in order):

1. **Privacy first** — target `[data-tour="privacy-indicator"]` (added in Task 1).
   - Title: "Your data stays here"
   - Body: "Everything you do in NELA happens on this computer. Your documents and chats are never uploaded."
2. **Workspace** — target `[data-tour="workspace-selector"]`.
   - Title: "Create a private space"
   - Body: "Workspaces keep each project's documents and chats separate and organized."
3. **Add a document** — target `[data-tour="attach-button"]`.
   - Title: "Add your documents"
   - Body: "Add PDFs, Word files, and more. NELA reads them on this device so you can ask questions about them."
4. **Ask a question** — target `[data-tour="chat-input"]`.
   - Title: "Ask in plain language"
   - Body: "Type a question and press Enter. NELA answers using your documents and shows you its sources."
5. **Sources/trust** — target `[data-tour="kb-sidebar"]`; open the panel via the existing `openDocPanel` binding (mirror the `documents` tour's `onBeforeStep` pattern).
   - Title: "Check the sources"
   - Body: "Every answer lists the documents it came from, so you can verify it."

### Implementation notes

- Reuse `switchModeFromBindings` / `openDocPanelFromBindings` at the top of `tours.tsx`.
- Bump the `getting-started` tour's `version` from `1` to `2`.
- If Task 1 hasn't added `data-tour="privacy-indicator"` yet, temporarily target `[data-tour="workspace-selector"]` for step 1 and leave a `// TODO: retarget to privacy-indicator` comment.

### Acceptance criteria

- [ ] `getting-started` no longer references models/parameters.
- [ ] The new 5-step flow runs; missing targets are skipped gracefully.
- [ ] Other tours unchanged.
- [ ] Lint + build pass.

---

# TASK 7 — Professional light theme (default for non-technical users)

**Depends on:** F2. (Theme toggle uses its own hook below.)
**Impact:** changes the product's feel from neon/dev to calm/professional. **Largest visual task; do it carefully.**

### Strategy (do NOT rewrite all of App.css)

Introduce a **theme attribute** on `<html>` and a **light token set** that overrides the existing CSS custom properties. Components keep using the same token classes; only the variable *values* change per theme.

### Step 7.1 — Find token definitions

Open `src/index.css` and `src/App.css`. Locate where the variables behind tokens are declared (`:root { --... }` and/or a Tailwind v4 `@theme { ... }` block defining `--color-void-900`, `--color-txt`, `--color-neon`, `--color-glass-border`, etc.). Record the exact variable names.

### Step 7.2 — Add a light override

Add a light theme keyed on `data-theme="professional"`. **Match the variable names you found** (names below are illustrative):

```css
/* Default (existing) dark "neon" theme stays on :root. */

/* Professional light theme: calm, high-contrast, single conservative accent. */
:root[data-theme="professional"] {
  --color-void-900: #ffffff;
  --color-void-800: #f7f8fa;
  --color-void-700: #eef1f5;

  --color-txt: #1a2230;
  --color-txt-secondary: #3a4658;
  --color-txt-muted: #5d6b7e;

  --color-neon: #0b6bcb;
  --color-neon-subtle: rgba(11, 107, 203, 0.08);

  --color-glass-border: #d8dee7;
  --color-glass-bg: #ffffff;
  --color-glass-hover: #eef1f5;

  --color-success: #15803d;
  --color-warning: #b45309;
  --color-danger: #b91c1c;
}
```

> If tokens are declared in a Tailwind `@theme` block rather than `:root`, replicate the override so its specificity wins (e.g. `[data-theme="professional"] { --color-...: ...; }`). Mirror the existing declaration mechanism.

### Step 7.3 — Disable neon-only flourishes in professional theme

```css
:root[data-theme="professional"] .welcome-orb,
:root[data-theme="professional"] .startup-waves {
  display: none;
}

:root[data-theme="professional"] .send-btn,
:root[data-theme="professional"] .glass-strong,
:root[data-theme="professional"] .glass {
  box-shadow: none !important;
  backdrop-filter: none !important;
}
```

Adjust selectors to actual class names (`.welcome-orb` and `.startup-waves` exist; verify the rest).

### Step 7.4 — Apply theme on boot + toggle

Create `src/hooks/useTheme.ts`:

```ts
import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "nela:ux:theme:v1";
export type ThemeName = "professional" | "neon";

/** Professional (light) is the DEFAULT for the non-technical target market. */
function readTheme(): ThemeName {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "neon" ? "neon" : "professional";
  } catch {
    return "professional";
  }
}

function applyTheme(theme: ThemeName) {
  const root = document.documentElement;
  if (theme === "professional") root.setAttribute("data-theme", "professional");
  else root.removeAttribute("data-theme"); // neon = default :root tokens
}

export function useTheme(): { theme: ThemeName; setTheme: (t: ThemeName) => void } {
  const [theme, setThemeState] = useState<ThemeName>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((t: ThemeName) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
    setThemeState(t);
  }, []);

  return { theme, setTheme };
}
```

In `src/main.tsx`, apply the theme **before render** to avoid a flash:

```ts
(() => {
  try {
    const t = localStorage.getItem("nela:ux:theme:v1");
    if (t !== "neon") document.documentElement.setAttribute("data-theme", "professional");
  } catch {
    document.documentElement.setAttribute("data-theme", "professional");
  }
})();
```

Add a theme switch in Settings (`ModelsSettingsModal.tsx` or a general settings area): two options "Professional (light)" / "Classic (dark)" calling `useTheme().setTheme`.

### Step 7.5 — Visual cleanup

Search components for hardcoded dark colors (`rgba(0, 212, 255`, `#0`-prefixed hex literals) in `ChatWindow.tsx`, `StartupModal.tsx`, etc. Replace with token classes so they adapt. Prioritize: startup modal, chat welcome state, chat bubbles, input bar, Document Library sidebar, Settings.

### Acceptance criteria

- [ ] App boots in light professional theme by default, no dark flash.
- [ ] A Settings control switches to Classic (dark) and back; choice persists.
- [ ] Professional theme: white/neutral surfaces, navy accent, no neon glow, no animated orb/waves.
- [ ] Muted text meets ~4.5:1 contrast on light surfaces (spot-check).
- [ ] Lint + build pass.

> If needed, implement in two passes: (7a) token override + boot + toggle, then (7b) per-component hardcoded-color cleanup.

---

# TASK 8 — Accessibility pass

**Depends on:** none (easier after Task 7).
**Scope:** high-traffic components: `ChatWindow.tsx`, `KnowledgeBaseSidebar.tsx`, `AppMainTopBar.tsx`, `AppMainModeControls.tsx`, `ModelSelector.tsx`, `GlassDropdown.tsx`, `StartupModal.tsx`, `ModelsSettingsModal.tsx`.

### 8.1 — `aria-label` on every icon-only button

For each `<button>` whose only child is an SVG/icon, add an `aria-label`. Keep `title`. Examples: Send → "Send message"; Stop → "Stop response"; Copy → "Copy response"; Close → "Close"; Attach `+` → "Add documents" (image variant in vision mode).

### 8.2 — Minimum readable font sizes (simple-mode surfaces only)

Raise sub-11px text:
- `text-[0.68rem]` → `text-[0.78rem]`
- `text-[0.7rem]` → `text-[0.8rem]`
- `text-[0.72rem]` → `text-[0.8rem]`

Do **not** change sizes inside Advanced-mode-only components (the param dock may stay dense). If a layout breaks, adjust padding rather than reverting the size.

### 8.3 — Don't rely on color alone

Every color-coded status (Adding/Enhanced/error) must also have an icon or text label. Verify amber "Processing…" and green "Enhanced" include both.

### 8.4 — Focus visibility & keyboard operability

Custom click-driven menus/dropdowns (`GlassDropdown.tsx`, the mode/tools menus in `ChatWindow.tsx`) must be keyboard-reachable with a visible focus ring. Prefer converting clickable `div`s to real `<button>`s. If too risky, add `role="button"`, `tabIndex={0}`, an Enter/Space `onKeyDown`, and `focus-visible:ring-2 focus-visible:ring-sky-300/50`.

### 8.5 — Image alt text

Decorative images use `alt=""`; the assistant-identifying NELA logo keeps `alt="NELA"`.

### Acceptance criteria

- [ ] No icon-only button in touched files lacks `aria-label`.
- [ ] No simple-mode body/status text smaller than ~12.5px (`0.78rem`).
- [ ] Status conveyed without color alone.
- [ ] Custom menus/dropdowns keyboard-operable with visible focus.
- [ ] Lint + build pass.

---

# TASK 9 — Unify the dual document-grounding into one "Add documents" flow

**Depends on:** F1, F2, Task 2.
**Impact:** removes the most confusing interaction (the `+` button behaves differently based on a hidden RAG toggle).

### Target behavior

- Simple mode (default): the `+` ALWAYS offers **"Add documents"** and **"Add a folder"** (the knowledge-base path). The app decides retrieval automatically via the existing query classifier. The user-facing RAG toggle is hidden. The separate "direct attach" path is not surfaced.
- Advanced mode: keep the existing toggle + both paths exactly as today.

### Implementation

1. In the component owning chat state (where `ragEnabled` and `onToggleRagEnabled` live — likely `App.tsx`/`app-backend.tsx`):
   - `import { useAdvancedMode } from "../hooks/useAdvancedMode";`
   - Compute `const effectiveRagEnabled = advanced ? ragEnabled : true;` and pass `effectiveRagEnabled` to `ChatWindow` as the `ragEnabled` prop (this makes the `+` show the KB path in simple mode).
   - Do not persist the forced value back into the user's stored preference; keep the stored toggle as the advanced preference.
2. In `ChatWindow.tsx` `renderToolsMenu`:
   - Render the "Search my documents" (RAG) toggle **only when `advanced` is true**. Keep "Search the web" visible in both modes.
   - Obtain `advanced` either via a new prop passed from the parent, or by calling `useAdvancedMode()` inside `ChatWindow`.
3. In `ChatWindow.tsx` `renderAttachMenu`, text branch:
   - In simple mode (`!advanced`), always render the KB branch ("Add documents" / "Add a folder"); never the direct-attach branch.
   - In advanced mode, keep current behavior.

### Edge cases

- Vision mode unaffected.
- Do not delete the direct-attach handlers/props; advanced mode uses them.
- Existing sessions with `ragEnabled=false` work because simple mode forces effective-true.

### Acceptance criteria

- [ ] Default mode: `+` always shows "Add documents"/"Add a folder"; no RAG toggle; no "send directly to model".
- [ ] Asking about an added document still retrieves and answers (classifier-driven).
- [ ] Advanced mode restores the toggle + dual paths.
- [ ] Lint + build pass.

---

# TASK 10 — Humanize errors and empty states + add recovery

**Depends on:** F2.

### 10.1 — Friendly chat errors

Create `src/app/friendlyError.ts`:

```ts
import { COPY } from "./copy";

/**
 * Convert raw backend/error strings into calm, non-technical messages.
 * Keep the original text for Advanced mode / logs (caller decides).
 */
export function friendlyError(raw: string | undefined | null): string {
  const text = (raw ?? "").toLowerCase();
  if (!text) return COPY.errorGeneric;

  if (
    text.includes("not be loaded") ||
    text.includes("model may not") ||
    text.includes("no model") ||
    text.includes("failed to start") ||
    text.includes("not running") ||
    text.includes("loading")
  ) {
    return COPY.errorNotReady;
  }
  if (text.includes("timeout") || text.includes("timed out")) {
    return "That took too long. Please try again.";
  }
  if (text.includes("out of memory") || text.includes("oom") || text.includes("memory")) {
    return "Your computer ran low on memory. Try a smaller model or close other apps.";
  }
  return COPY.errorGeneric;
}
```

In `ChatWindow.tsx`, when a message represents an error, display `friendlyError(rawText)` instead of the raw text. If you cannot reliably detect "this message is an error," scope this to the artifact error path (`msg.artifactStage === "Error"`) and explicit error toasts, leaving normal assistant text untouched. In advanced mode you may optionally show the raw text in a collapsible "Technical details."

### 10.2 — Recovery action

Where a friendly error is shown for a failed send, render a small "Try again" button (`COPY.retry`) that re-sends the last user message via the existing `onSend`. If resend wiring is non-trivial, at minimum show the friendly text.

### 10.3 — Empty copy

Ensure the chat welcome state and the Document Library empty state (`COPY.libraryEmpty` from Task 3) contain no jargon.

### Acceptance criteria

- [ ] Known technical failure strings render as calm messages.
- [ ] A "Try again" affordance exists for failed sends (or limitation noted in code comments).
- [ ] Lint + build pass.

---

# TASK 11 — Settings: add the "Advanced mode" switch

**Depends on:** F1.

In `ModelsSettingsModal.tsx` (or the most general settings surface), add a labeled toggle near the top:

```tsx
import { useAdvancedMode } from "../hooks/useAdvancedMode";
// ...
const { advanced, setAdvanced } = useAdvancedMode();

<div className="flex items-center justify-between gap-3 py-2">
  <div>
    <div className="text-[0.85rem] font-semibold text-txt">Advanced mode</div>
    <div className="text-[0.78rem] text-txt-muted">
      Show technical controls like model parameters and document search options.
      Most people can leave this off.
    </div>
  </div>
  <button
    role="switch"
    aria-checked={advanced}
    aria-label="Advanced mode"
    onClick={() => setAdvanced(!advanced)}
    className={[
      "relative inline-flex h-5 w-9 rounded-full transition-colors outline-none",
      "focus-visible:ring-2 focus-visible:ring-sky-300/50",
      advanced ? "bg-sky-500" : "bg-void-700 border border-glass-border",
    ].join(" ")}
  >
    <span
      className={[
        "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
        advanced ? "translate-x-4" : "translate-x-0.5",
      ].join(" ")}
    />
  </button>
</div>
```

### Acceptance criteria

- [ ] Toggling it flips all advanced-gated UI (param dock vs response style, RAG toggle visibility, reasoning toggle) live, without reload.
- [ ] Choice persists across restarts.
- [ ] Lint + build pass.

---

# TASK 12 — Hide "Show reasoning" / Thinking internals in simple mode

**Depends on:** F1, Task 2.
**File:** `src/components/ChatWindow.tsx`.

### Changes

1. Tools menu: render the "Show reasoning" (formerly Thinking) toggle **only when `advanced` is true**. In simple mode, hide it and do not pass `thinkingEnabled` as true. Use `useAdvancedMode()` (or an `advanced` prop) inside `ChatWindow`.
2. `ThinkingBox` and the streaming-thinking block: render **only when `advanced` is true**. In simple mode, do not render the collapsible "Thinking (N chars)" box or the live "Thinking..." monospace stream.
3. Advanced mode behaves exactly as today.

### Acceptance criteria

- [ ] Default mode: no "Thinking"/"Show reasoning" toggle and no reasoning box/stream.
- [ ] Advanced mode: everything works as before.
- [ ] Lint + build pass.

---

## Final validation checklist (run after each task)

- [ ] `cd genhat-desktop && npm run lint` → clean
- [ ] `cd genhat-desktop && npm run build` → succeeds
- [ ] If Rust was edited: `cd genhat-desktop/src-tauri && cargo check` → succeeds
- [ ] All `data-tour="..."` attributes preserved
- [ ] No banned jargon (Section 0, rule 7) visible in changed simple-mode UI
- [ ] Every icon-only button touched has an `aria-label`
- [ ] Appended a bullet to `.github/copilot-instructions.md` under `## UX (non-technical mode)` if behavior changed

## Recommended implementation order

1. Foundation (F1 + F2)
2. Task 1 — Privacy indicator
3. Task 2 — Chat relabel
4. Task 3 — Library sidebar
5. Task 11 — Advanced-mode switch (so later gated tasks are testable)
6. Task 4 — Response style
7. Task 12 — Hide reasoning
8. Task 9 — Unify add-docs
9. Task 10 — Friendly errors
10. Task 6 — Onboarding tour
11. Task 5 — Relevance grade (backend + frontend)
12. Task 7 — Professional theme (largest; may be split 7a/7b)