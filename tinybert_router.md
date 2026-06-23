# NELA Macro-Intent Router — TinyBERT ONNX Training Spec

**Document version:** 1.1  
**Target model ID (registry):** `macro-intent-router`  
**Task type (registry):** `macro_classify` (separate from RAG `classify` / `query-router`)  
**Base architecture:** TinyBERT-4L-312D (or `huawei-noah/TinyBERT_General_4L_312D`)  
**Deployment backend:** `onnx_classifier` (ONNX Runtime, in-process, CPU/CoreML)  
**Max sequence length:** **128 tokens** (locked)  
**Auto-start at app launch:** **Yes** (locked)  
**Language (v1):** **English only** (locked)  
**Consumer:** NELA / GenHat desktop app — Tier 1 macro-intent resolution in `intent/resolver.rs`

This spec is written for an ML training agent. Follow it end-to-end to produce a model artifact that plugs into NELA without architectural surprises.

---

## 1. Problem statement

NELA is a local-first desktop AI assistant. Before any heavy LLM or artifact pipeline runs, the app must decide **what kind of task** the user wants. Target latency: **≤30 ms** inference on CPU.

Primary users are **non-technical**. They type natural language, not slash commands. Slash commands (`/ppt`, `/web /excel`, etc.) are handled deterministically in Tier 0 and **must not appear in training data** (the router only sees the natural-language path).

### What this model does

Predicts **macro-intent** from a single user query string:

1. **Primary output type** (exactly one): normal chat, presentation, spreadsheet, HTML page, or summarize.
2. **Source modifiers** (zero or more): needs web search, needs ingested document (RAG) grounding, needs local file search on disk.

### What this model does NOT do

| Responsibility | Handled by |
|----------------|------------|
| RAG retrieval strategy (`no_retrieval` / `simple_rag` / `multi_doc`) | Existing **`query-router`** DistilBERT (`classifier/distilBert-query-router/`) |
| Vision, audio, podcast, mindmap modes | UI mode switch (not text chat) |
| Patch/edit existing artifact | Separate `Patch` intent (Tier 0 / future) |
| Slash command parsing | `genhat-desktop/src/app/slashCommands.ts` (Tier 0) |
| Keyword artifact triggers (“create a ppt about…”) | Tier 0 regex in `intent/resolver.rs` (optional fallback; router should still learn these phrases) |

**Do not merge** macro-intent labels into the existing 4-class RAG classifier. Train a **separate** model.

---

## 2. NELA routing context (read this first)

### 2.1 Tiered intent resolver

```
User query (text chat mode)
        │
        ▼
┌───────────────────┐
│ Tier 0            │  Slash commands, UI buttons, high-confidence keywords
│ (deterministic)   │  → skips macro router if matched
└─────────┬─────────┘
          │ no match
          ▼
┌───────────────────┐
│ Tier 1            │  ◄── THIS MODEL (macro-intent-router)
│ TinyBERT ONNX     │  10–30 ms, in-process
└─────────┬─────────┘
          │ low confidence → default Chat
          ▼
┌───────────────────┐
│ Application       │  Maps labels → handleSend.ts routing
│ routing           │
└───────────────────┘
```

Reference: `genhat-desktop/src-tauri/src/intent/resolver.rs`, `genhat-desktop/src/app/handleSend.ts`.

### 2.2 Downstream routes (what labels must trigger)

| Router prediction | Application behavior |
|-------------------|----------------------|
| `chat` | Standard streaming LLM chat |
| `artifact_ppt` | `handleArtifactGeneration` → `mcp-server-presentation` / `presentation_synthesis` |
| `artifact_excel` | `handleArtifactGeneration` → `mcp-server-excel` / `spreadsheet_synthesis` |
| `artifact_html` | `handleArtifactGeneration` → `mcp-server-html` / `html_synthesis` |
| `summarize` | Dedicated summarization path (`IntentKind::Summarize`) — see §5.5 for when `chat` is also valid |
| `use_web` = true | Enable web search context injection (`Api.webSearch`) for this request |
| `use_rag` = true | Query ingested knowledge-base documents (`Api.queryRagStream`) |
| `use_local_files` = true | Ambient FTS5 file search on user's machine (`Api.searchAmbientFiles`) |

Modifiers **combine** with primary output. Examples:

- `artifact_excel` + `use_web` → build spreadsheet using web research as context  
- `artifact_ppt` + `use_rag` → build slides grounded in uploaded documents  
- `chat` + `use_local_files` → answer using content found on disk  
- `chat` + `use_web` + `use_rag` → rare; prefer `use_web` OR `use_rag` unless query clearly needs both

### 2.3 Simple mode UX (non-technical users)

- RAG toggle is **hidden**; document search is automatic when docs are ingested (`effectiveRagEnabled = true` in simple mode).
- Users say things like “summarize my report”, “make slides”, “find my tax form” — not “enable RAG”.
- The router must infer **intent from phrasing**, not from UI state.
- Prefer **false → chat** over false → artifact (wrong spreadsheet is worse than a normal answer).

### 2.4 Distinction: three “search” concepts

Train the model to separate these carefully:

| Label | User means | NELA mechanism |
|-------|------------|----------------|
| `use_rag` | “From my uploaded documents / library / what I added” | Knowledge-base RAG pipeline |
| `use_local_files` | “On my computer / in my files / find the PDF named X” | Ambient file indexer (FTS5) |
| `use_web` | “Online / latest news / current price / from the internet” | Web search API |

**Hard negatives:** “search my documents” → `use_rag`, NOT `use_local_files`.  
**Hard negatives:** “search the web for…” → `use_web`, NOT `use_local_files`.

---

## 3. Output schema

### 3.1 Multi-label design (required)

Use **multi-label classification** with **sigmoid** per label (NOT single softmax over joint classes).

**Reason:** Routes combine (`web + excel`). A single 32-class softmax cannot scale and will not generalize.

#### Label inventory (8 labels)

| Index | Label name | Type | Description |
|-------|------------|------|-------------|
| 0 | `chat` | Primary (mutually exclusive group) | Default conversational response |
| 1 | `artifact_ppt` | Primary | Generate PowerPoint / slide deck |
| 2 | `artifact_excel` | Primary | Generate spreadsheet / Excel / CSV output |
| 3 | `artifact_html` | Primary | Generate HTML webpage / landing page |
| 4 | `summarize` | Primary | Summarize content (docs, text, or general) |
| 5 | `use_web` | Modifier | Needs live web search context |
| 6 | `use_rag` | Modifier | Needs ingested knowledge-base retrieval |
| 7 | `use_local_files` | Modifier | Needs ambient local file search |

**Constraint at inference time (application enforces):**

- Exactly **one** of labels 0–4 must be active (pick highest logit among the five if multiple exceed threshold).
- Labels 5–7 are independent (threshold per label).

#### Training target format

Each training example is a JSON object:

```json
{
  "id": "train_000001",
  "text": "Make me a slide deck about renewable energy using the latest news online",
  "labels": {
    "chat": 0,
    "artifact_ppt": 1,
    "artifact_excel": 0,
    "artifact_html": 0,
    "summarize": 0,
    "use_web": 1,
    "use_rag": 0,
    "use_local_files": 0
  },
  "meta": {
    "split": "train",
    "source": "synthetic",
    "locale": "en"
  }
}
```

Use integers `0`/`1` only. For primary group, **exactly one** must be `1`.

### 3.2 HuggingFace `id2label` mapping (for ONNX export)

Export `config.json` with string keys matching indices:

```json
{
  "id2label": {
    "0": "chat",
    "1": "artifact_ppt",
    "2": "artifact_excel",
    "3": "artifact_html",
    "4": "summarize",
    "5": "use_web",
    "6": "use_rag",
    "7": "use_local_files"
  },
  "problem_type": "multi_label_classification"
}
```

> **Integration note:** The current `onnx_classifier.rs` backend applies **softmax** and returns a single label. NELA engineers will extend it for this model to apply **sigmoid** per logit and return a multi-label vector. Export standard HuggingFace sequence-classification ONNX with output name `logits` shape `[1, 8]`.

---

## 4. Minimum dataset size

### 4.1 Absolute minimums (v1 shippable)

| Category | Min examples | Recommended |
|----------|--------------|-------------|
| **Primary: `chat`** | 1,200 | 2,500 |
| **Primary: `artifact_ppt`** | 800 | 1,500 |
| **Primary: `artifact_excel`** | 800 | 1,500 |
| **Primary: `artifact_html`** | 600 | 1,200 |
| **Primary: `summarize`** | 400 | 800 |
| **Modifier positives: `use_web`** | 500 | 1,000 |
| **Modifier positives: `use_rag`** | 500 | 1,000 |
| **Modifier positives: `use_local_files`** | 500 | 1,000 |
| **Hard negatives** (looks like route but is chat) | 1,500 | 3,000 |
| **Combined routes** (artifact + ≥1 modifier) | 400 | 800 |

**Total unique examples (minimum):** **~8,000**  
**Total unique examples (recommended):** **~12,000–15,000**

Split: **80% train / 10% val / 10% test** (stratify by primary label; ensure combo routes appear in all splits).

### 4.2 Per-combination minimums (combined routes)

At least **50 examples** each for frequent combos:

| Combo | Min count |
|-------|-----------|
| `artifact_ppt` + `use_web` | 80 |
| `artifact_excel` + `use_web` | 80 |
| `artifact_html` + `use_web` | 50 |
| `artifact_ppt` + `use_rag` | 80 |
| `artifact_excel` + `use_rag` | 80 |
| `summarize` + `use_rag` | 100 |
| `chat` + `use_local_files` | 100 |
| `chat` + `use_web` | 150 |
| `artifact_*` + `use_local_files` | 40 each |

---

## 5. Example types to cover

### 5.1 Primary: `chat` (default)

General Q&A, explanations, coding help, opinions, math, chit-chat.

```
What is photosynthesis?
Explain blockchain in simple terms
How do I write a good cover letter?
Write a Python function to sort a list
Who was the first president of India?
Thanks, that helped!
Can you help me think through this decision?
```

**Must be labeled `chat` only** (all modifiers 0) unless web/rag/files clearly needed.

### 5.2 Primary: `artifact_ppt`

User wants a **generated slide deck file**, not a text outline in chat.

```
Create a presentation about climate change
Make me slides for my startup pitch
I need a PowerPoint on machine learning basics
Put together a 10-slide deck about quarterly results
Turn this topic into something I can present to my class
Build a slide show about healthy eating
```

**Signals:** presentation, slides, deck, PowerPoint, ppt, “present to”, “pitch deck”.

**NOT artifact_ppt** (label `chat`):

```
Give me bullet points about climate change        → chat (text answer)
What should I include in a presentation?          → chat (advice)
How do I use PowerPoint?                            → chat (how-to)
```

### 5.3 Primary: `artifact_excel`

User wants a **generated spreadsheet file**.

```
Create a spreadsheet of monthly expenses
Make an Excel file tracking inventory
Build a budget template with categories
Generate a CSV of country populations
Put this data in a table I can open in Excel
Create a sales tracker spreadsheet
```

**Signals:** spreadsheet, Excel, xlsx, sheet, table (with create/make intent), CSV output.

**NOT artifact_excel:**

```
What is Excel?                                    → chat
How do I sum a column in Excel?                   → chat
Show me a table of populations in your answer     → chat (inline markdown table)
```

### 5.4 Primary: `artifact_html`

User wants a **generated HTML page file** (webpage, landing page, interactive page).

```
Create a webpage about my bakery
Build a landing page for my app
Make an HTML page with a contact form
Generate a simple portfolio website
Create a web page that shows a countdown timer
```

**Signals:** webpage, website, HTML page, landing page, “site” with create intent.

**NOT artifact_html:**

```
What is HTML?                                     → chat
Show me HTML code for a button                    → chat (snippet in message)
```

### 5.5 Primary: `summarize` vs `chat`

NELA supports two acceptable outcomes for “summarize this”-style requests:

| User intent | Primary label | Application behavior |
|-------------|---------------|----------------------|
| **Dedicated summarize task** — user wants the app in summarization mode, often with a specific document/source | `summarize` | `IntentKind::Summarize` pipeline |
| **Casual summary in conversation** — user wants a shorter answer inline, no special summarize mode | `chat` | Normal LLM chat (model summarizes in the reply) |

**Label as `summarize` when:**

- User explicitly asks to summarize **their documents / library / uploaded files** (often + `use_rag`)
- User asks to summarize **a specific local file** (often + `use_local_files`)
- Phrasing like “summarize my report”, “TLDR of the document I added”, “condense the uploaded PDF”
- User expects summarization to be the **main action**, not a side effect of Q&A

**Label as `chat` when:**

- “Give me a quick summary of World War 2” (general knowledge → chat, optional `use_web` if current)
- “Can you summarize that in 3 bullet points?” (follow-up / response shape)
- “Short version please” / “TLDR?” (conversational brevity)
- “Summarize the pros and cons” (analysis in chat, not document summarization mode)

**Training split guidance:** ~60% of summary-flavored examples → `chat`, ~40% → `summarize`, so the model does not over-trigger the summarize pipeline.

**Examples → `summarize`:**

```
Summarize the document I uploaded
Give me a TLDR of my ingested reports
Short summary of the main points from my library
Condense the PDF I added into key takeaways
```

**Examples → `chat` (acceptable alternative):**

```
Summarize World War 2 in a paragraph
Give me a quick overview of machine learning
Can you give me the short version?
TLDR on what happened at the summit yesterday   → chat + use_web
```

### 5.6 Modifier: `use_web`

Live / current / internet information needed.

```
What happened in the news today?
Latest stock price of Apple
Current weather in Mumbai
Who won the match yesterday?
Look up recent AI regulations online
Create a spreadsheet of 2025 Fortune 500 companies   → artifact_excel + use_web
Make slides about the latest iPhone features         → artifact_ppt + use_web
```

**NOT use_web:**

```
Explain how TCP/IP works                          → chat (timeless knowledge)
Summarize my uploaded PDF                         → summarize + use_rag
```

### 5.7 Modifier: `use_rag`

References **ingested knowledge base / uploaded library** (not arbitrary disk search).

```
Based on my uploaded documents, what are the risks?
From the reports I added, summarize findings
Search my document library for mentions of revenue
Answer using the files in my workspace
What do my ingested papers say about climate?
```

**Phrasing for non-tech users (no “RAG” jargon):**

```
From the documents I added...
Using my uploaded files...
In the reports I gave you...
```

### 5.8 Modifier: `use_local_files`

Search **files on the computer** (ambient indexer), not the web, not necessarily the KB.

```
Find my resume on this computer
Search my files for budget_2024.xlsx
Where is my tax return PDF?
Open the file called project_plan.docx
Look on my laptop for the invoice
Get me the contents of report.pdf from my downloads
```

**Signals:** “my computer”, “my files”, “on my disk”, filename with extension, “find/locate/open” + file.

**NOT use_local_files:**

```
Search the web for my resume online               → use_web
From my uploaded documents...                     → use_rag
```

### 5.9 Hard negatives (critical)

Include **≥1,500** examples that look like a route but should be **`chat` only**:

```
What is a spreadsheet?
Tell me about PowerPoint features
How do I make a website?
Search engine optimization tips
Find the meaning of life
Excel vs Google Sheets comparison
I hate presentations
Draft an email to my boss               → chat (not artifact)
Write a poem about slides               → chat (not artifact_ppt)
```

### 5.10 Style diversity (required augmentation)

For every template, generate variants:

- Formal / casual / terse  
- Typos and autocorrect (`presenation`, `spredsheet`)  
- Non-native English  
- Questions vs imperatives  
- With and without polite fillers (“please”, “can you”, “I need”)  
- **No slash commands** (`/ppt`, `/excel`) in training text  
- Length: 3–40 words typical; include some up to **128 tokens** (model max length)

---

## 6. Model & training hyperparameters

### 6.1 Base model

**Recommended:** `huawei-noah/TinyBERT_General_4L_312D`  
**Alternative:** `Intel/dynamic_tinybert` or DistilBERT if TinyBERT underperforms on val (DistilBERT is larger but proven in NELA).

| Parameter | Value |
|-----------|-------|
| Max sequence length | **128** (locked — train, export, and runtime all use 128) |
| Optimizer | AdamW |
| Learning rate | 3e-5 (range 2e-5 – 5e-5) |
| Batch size | 32 (adjust for GPU memory) |
| Epochs | 4–8 with early stopping on val F1 |
| Loss | `BCEWithLogitsLoss` (multi-label) |
| Class weights | Upweight `artifact_*` and modifiers (see §6.3) |
| Warmup | 10% of steps |

### 6.2 Class imbalance weights (starting point)

Primary outputs are imbalanced (`chat` dominates). Use positive weights:

| Label | Weight multiplier |
|-------|-------------------|
| `chat` | 1.0 |
| `artifact_ppt` | 2.0 |
| `artifact_excel` | 2.0 |
| `artifact_html` | 2.0 |
| `summarize` | 1.5 |
| `use_web` | 1.5 |
| `use_rag` | 1.5 |
| `use_local_files` | 1.5 |

Tune on validation so artifact precision ≥ 0.85.

### 6.3 Data generation strategy

1. **60%** synthetic templates (paraphrase with LLM or rule-based)  
2. **25%** human-written or curated real-world queries  
3. **15%** adversarial / hard negatives  

If using LLM for synthesis, **human-review at least 10%** of each batch for label correctness.

---

## 7. ONNX export & NELA packaging

### 7.1 Deliverable directory layout

Ship a zip matching the existing query-router layout:

```
classifier/tinybert-macro-router/
└── onnx_model/
    ├── model.onnx          # Required: logits output [1, 8]
    ├── config.json         # Required: id2label, problem_type
    └── tokenizer.json      # Required: HuggingFace fast tokenizer
```

### 7.2 ONNX export requirements

- Opset ≥ 14  
- Input names: `input_ids`, `attention_mask` (match existing backend)  
- Output name: `logits`  
- Dynamic axes optional; batch size 1 is fine  
- Validate with `onnxruntime` Python before handoff  
- **Quantization (optional):** INT8 dynamic quant if accuracy drop &lt; 1% F1; otherwise float32  

### 7.3 Reference implementation in NELA

Mirror existing registry entry (`query-router` in `models.toml`):

```toml
[[models]]
id = "macro-intent-router"
name = "NELA Macro Intent Router (TinyBERT ONNX)"
backend = "onnx_classifier"
kind = "in_process"
model_file = "classifier/tinybert-macro-router/onnx_model/model.onnx"
tasks = ["macro_classify"]   # Separate from RAG query-router `classify` task
auto_start = true            # Locked: pre-warm on app launch (~50–80 MB RAM)
max_instances = 1
idle_timeout_s = 300
priority = 20
memory_mb = 80

[models.params]
config_file = "classifier/tinybert-macro-router/onnx_model/config.json"
tokenizer_file = "classifier/tinybert-macro-router/onnx_model/tokenizer.json"
max_length = "128"
multi_label = "true"
macro_classify = "true"
```

### 7.4 Inference contract (for integration engineer)

Application-side decoding pseudo-code:

```python
probs = sigmoid(logits)  # NOT softmax for modifiers

PRIMARY = ["chat", "artifact_ppt", "artifact_excel", "artifact_html", "summarize"]
MODIFIERS = ["use_web", "use_rag", "use_local_files"]

primary_idx = argmax(probs[0:5])
primary_conf = probs[primary_idx]

if primary_conf < 0.55:
    route = "chat"  # fail-open
else:
    route = PRIMARY[primary_idx]

modifiers = {m: probs[i] > THRESHOLD[m] for m, i in MODIFIERS.items()}
# Suggested thresholds: use_web=0.50, use_rag=0.50, use_local_files=0.55
# artifact_* primary: require primary_conf >= 0.70 to avoid false artifacts
```

---

## 8. Evaluation criteria (acceptance gates)

### 8.1 Metrics (test set)

Report per-label and macro-averaged:

| Metric | Target (minimum to ship) |
|--------|--------------------------|
| Primary accuracy (exact match on labels 0–4) | ≥ **88%** |
| `artifact_ppt` precision | ≥ **85%** |
| `artifact_excel` precision | ≥ **85%** |
| `artifact_html` precision | ≥ **82%** |
| `use_web` F1 | ≥ **80%** |
| `use_rag` F1 | ≥ **80%** |
| `use_local_files` F1 | ≥ **78%** |
| Combined-route exact match (primary + all modifiers) | ≥ **75%** |
| False artifact rate on `chat` test subset | ≤ **3%** |

**False artifact rate** = `(artifact_* predicted | true chat) / N` — most important UX metric.

### 8.2 Latency (CPU)

| Environment | Target |
|-------------|--------|
| Desktop CPU (4+ cores), batch=1 | p50 ≤ **15 ms**, p95 ≤ **30 ms** |
| Apple Silicon (CoreML EP) | p50 ≤ **10 ms** |

Benchmark with ONNX Runtime using the same thread policy as `onnx_classifier.rs` (intra threads = min(cores, 8)).

### 8.3 Confusion matrices to deliver

1. 5×5 primary label confusion  
2. Binary confusion per modifier  
3. Top 50 failure cases with predicted vs gold labels  

---

## 9. Mapping model output → NELA `IntentKind`

Integration reference (`genhat-desktop/src-tauri/src/intent/types.rs`):

| Prediction | `IntentKind` | Extra fields |
|------------|--------------|--------------|
| `chat` (+ modifiers) | `Chat` | Pass modifiers to frontend `handleSend` flags |
| `artifact_ppt` | `Artifact { tool: "mcp-server-presentation", schema_id: "presentation_synthesis" }` | |
| `artifact_excel` | `Artifact { tool: "mcp-server-excel", schema_id: "spreadsheet_synthesis" }` | |
| `artifact_html` | `Artifact { tool: "mcp-server-html", schema_id: "html_synthesis" }` | |
| `summarize` | `Summarize` | |
| `use_local_files` (modifier) | Sets `FileSearch` behavior in `handleSend.ts` | Same as slash `/files` |

Frontend flags (already implemented for slash commands):

```typescript
// genhat-desktop/src/app/handleSend.ts
effectiveWebEnabled = ctx.webEnabled || slash.web;      // ← use_web
effectiveRagEnabled = ctx.ragEnabled || slash.rag;      // ← use_rag
slashFileSearch / resolvedIntentKind === "FileSearch"    // ← use_local_files
```

The macro router should populate the same flags when Tier 1 fires.

---

## 10. Training agent deliverables checklist

- [ ] `dataset/` — `train.jsonl`, `val.jsonl`, `test.jsonl` (one JSON object per line)  
- [ ] `dataset/README.md` — counts per label, combo stats, generation methodology  
- [ ] `training/` — reproducible train script or notebook with fixed seed  
- [ ] `classifier/tinybert-macro-router/onnx_model/` — ONNX bundle (§7.1)  
- [ ] `evaluation/report.md` — metrics tables, confusion matrices, failure analysis  
- [ ] `evaluation/benchmark.json` — latency percentiles on CPU  
- [ ] `evaluation/thresholds.json` — recommended per-label thresholds  
- [ ] Optional: `gdrive_upload.zip` for NELA model distribution (same pattern as `query-router`)

---

## 11. Out of scope (do not train)

- Slash commands (`/ppt`, `/web`, etc.)  
- Vision / image queries  
- Audio / TTS / podcast / mindmap modes  
- RAG retrieval class (`no_retrieval`, `simple_rag`, `multi_doc`) — separate model  
- Patch / edit existing artifact  
- Language other than **English** in v1 (document as future work)  
- Detecting **which** local file (filename resolution) — only **whether** to trigger file search  
- Multi-turn conversation context — **single query only** in v1  

---

## 12. Future extensions (v2, not required now)

- **Context features** as additional model inputs (binary flags in text prefix):  
  `[CTX docs=1 web_toggle=0 files_attached=0] user query here`  
- Multilingual head (Hindi/Hinglish for NELA user base)  
- Confidence calibration (temperature scaling on val set)  
- Active learning loop from production misroutes  

---

## 13. Locked product decisions (NELA team, v1.1)

These decisions are **final for v1**. Do not treat as open questions.

| Decision | Value |
|----------|--------|
| `max_length` | **128 tokens** (train, ONNX export, and runtime) |
| Auto-start at app launch | **Yes** (~50–80 MB RAM; acceptable for routing latency) |
| `summarize` vs `chat` | **Both valid** for summary-flavored queries; see §5.5 for annotation rules |
| Language | **English only** in v1 (no Hindi/Hinglish required) |
| Task type | **`macro_classify`** — separate from RAG `classify` / `query-router` |
| `summarize` + `artifact_*` co-occurrence | **No** — summarize remains exclusive in the primary group |

---

## 14. Quick reference — label decision tree (for annotators)

```
Does user want a FILE generated (ppt/xlsx/html)?
  YES → artifact_* (+ modifiers)
  NO → Does user want DEDICATED summarization mode (docs/files/library)?
    YES → summarize (+ modifiers)
    NO → chat (+ modifiers)
         ↑ includes casual "summarize/TLDR" requests (see §5.5)

Modifiers (can stack):
  Needs internet/live data?     → use_web
  References uploaded library?  → use_rag
  References local disk/files?  → use_local_files
```

When in doubt: **`chat` with no modifiers**.

---

*End of spec. For codebase questions, see `genhat-desktop/src-tauri/src/intent/`, `genhat-desktop/src/app/slashCommands.ts`, and `genhat-desktop/src/app/handleSend.ts`.*
