# File Retrieval Rework — Follow-up (V2): close the gaps from the V1 audit

> **Audience:** the engineer/agent implementing this. Verbose and prescriptive on purpose. Do the
> fixes in order. Where it says *verify*, actually run the command and read the output before
> continuing. Do **not** invent new patterns — match what's already in the files.
>
> **Prerequisite:** V1 of this rework is already implemented and committed (see
> `file_retrieval_rework.md` and commit `b400b7d`). This document only fixes the 6 issues found when
> auditing that V1 work. Everything else in V1 is correct — do not redo it.

---

## 0. Context & current status

V1 replaced the old "random files" ambient search with a 3-stage pipeline: FTS5 BM25 → cross-encoder
rerank (`ms-marco-grader`) → relevance threshold → top-K with snippets. It works and is committed.

An audit found **6 remaining issues**. This doc fixes them. Severity legend:
- **[HIGH]** — functional correctness / matches a requirement that's currently only half-met.
- **[VERIFY]** — probably fine, but a silent failure mode means you must confirm by running.
- **[MED] / [LOW]** — robustness, tuning, docs.

Same hard constraints as V1: **local-first, CPU-only, total search ≤ 1 second, reuse existing
patterns, do not rename IPC commands or model/task IDs.**

| # | Fix | Severity | One-line |
|---|---|---|---|
| 1 | Feed folder `location` into the reranker | **HIGH** | the 2-parent-dir disambiguation never reaches the cross-encoder |
| 2 | Confirm `bm25` weights don't silently fall back to `LIKE` | **VERIFY** | a wrong weight count would break ranking for *every* query |
| 3 | Measure latency; tune if it busts the 1 s / deadline budget | **VERIFY** | 15 sequential rerank calls may exceed the deadline on slow CPUs |
| 4 | Decouple the deadline-fallback score from `MIN_RELEVANCE` | **MED** | raising the threshold later silently drops slow-CPU results |
| 5 | Code-file *content* is no longer searchable (decision + optional path) | **MED** | confirm intended; optional low-weight re-enable |
| 6 | Finish governance docs (2 missing instruction files) | **LOW** | repo rule requires all four `.github` files |

---

## 1. Orientation (files you will touch)

| Concern | File |
|---|---|
| Candidate struct + FTS query | `genhat-desktop/src-tauri/src/indexer/db.rs` |
| Rerank orchestrator + constants | `genhat-desktop/src-tauri/src/indexer/rank.rs` |
| Crawler content rules (Fix 5 only) | `genhat-desktop/src-tauri/src/indexer/crawler.rs` |
| Watcher content rules (Fix 5 only) | `genhat-desktop/src-tauri/src/indexer/watcher.rs` |
| Governance docs (Fix 6) | `.github/instructions/rust-backend-tauri.instructions.md`, `.github/instructions/frontend-react-tauri.instructions.md` |

After Rust edits run from `genhat-desktop/src-tauri/`: `cargo check` (then `cargo build`). After
TS/doc edits run from `genhat-desktop/`: `npm run lint && npm run build`.

---

## 2. FIX 1 — [HIGH] Feed the folder `location` into the reranker

### Symptom (current code)
The `location` column (last 2 parent dir names, e.g. `projecta src`) is **indexed and used by BM25**,
but it is **never given to the cross-encoder**. Today:

`indexer/db.rs` — `Candidate` has no `location` field:
```rust
pub struct Candidate {
    pub path: String,
    pub filename: String,
    pub is_dir: bool,
    pub size: i64,
    pub mtime: i64,
    pub snippet: String,
}
```
`indexer/rank.rs` — the rerank passage uses only filename + snippet:
```rust
fn passage_for(c: &Candidate) -> String {
    let base = format!("{} | {}", c.filename, c.snippet);
    truncate_chars(&base, PASSAGE_MAX_CHARS)
}
```

### Why it matters
The whole point of indexing the 2 parent directories was to disambiguate **same-named files across
different projects** (e.g. `analytics/.../main.rs` vs `webapp/.../main.rs`). BM25 can favor the right
one, but the **cross-encoder runs last and re-sorts everything**. Two same-named files produce nearly
identical passages (`main.rs | <similar snippet>`) → near-identical scores → the BM25 location
advantage is washed out. So the disambiguation requirement is only half-met.

### Change

**2a. Add `location` to `Candidate`** (`indexer/db.rs`):
```rust
#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: String,
    pub filename: String,
    pub is_dir: bool,
    pub size: i64,
    pub mtime: i64,
    pub location: String, // NEW: 2 parent dir names (from files_fts.location)
    pub snippet: String,
}
```

**2b. Select `location` in `search_candidates`** (`indexer/db.rs`). Update the FTS SQL and BOTH the
`run(...)` closure and the `LIKE` fallback. The FTS `SELECT` becomes (note the new `fts.location`
column — it shifts the column indices, so update every `row.get(...)`):
```rust
let sql = "
    SELECT f.path, f.filename, f.is_dir, f.size, f.mtime,
           fts.location AS location,
           snippet(files_fts, 2, '', '', '…', 24) AS snip
    FROM files_fts fts
    JOIN files f ON f.path = fts.path
    WHERE files_fts MATCH ?1
    ORDER BY bm25(files_fts, 10.0, 4.0, 1.0, 1.0)
    LIMIT ?2";

let run = |match_expr: &str| -> Result<Vec<Candidate>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Prepare FTS query failed: {e}"))?;
    let rows = stmt
        .query_map(params![match_expr, limit as i64], |row| {
            Ok(Candidate {
                path: row.get(0)?,
                filename: row.get(1)?,
                is_dir: row.get::<_, i32>(2)? == 1,
                size: row.get(3)?,
                mtime: row.get(4)?,
                location: row.get::<_, String>(5).unwrap_or_default(), // NEW (index 5)
                snippet: row.get::<_, String>(6).unwrap_or_default(),   // shifted to index 6
            })
        })
        .map_err(|e| format!("FTS query_map failed: {e}"))?;
    let mut out = Vec::new();
    for r in rows { if let Ok(c) = r { out.push(c); } }
    Ok(out)
};
```
In the `LIKE` fallback `query_map` (the `files`-table query, which has no `location` column), set it
empty:
```rust
Ok(Candidate {
    path: row.get(0)?, filename: row.get(1)?,
    is_dir: row.get::<_, i32>(2)? == 1, size: row.get(3)?, mtime: row.get(4)?,
    location: String::new(), // files table has no location
    snippet: String::new(),
})
```

**2c. Include `location` in the rerank passage** (`indexer/rank.rs`):
```rust
fn passage_for(c: &Candidate) -> String {
    // filename + folder context + content snippet, capped.
    let base = format!("{} | {} | {}", c.filename, c.location, c.snippet);
    truncate_chars(&base, PASSAGE_MAX_CHARS)
}
```

> Note: `search()` (the legacy delegating wrapper in `db.rs`) maps `Candidate → FileRecord` and does
> NOT use `location`, so it's unaffected — leave it.

**Verify:** `cargo check && cargo build`. Then in a live run (see §3), query a filename that exists
in two folders and confirm the one whose folder you named ranks first.

---

## 3. FIX 2 + FIX 3 — [VERIFY] Confirm `bm25` works and latency stays under budget

These two are *verification* tasks (with a conditional code change). Do them together in one live run.

### FIX 2 — does `bm25(files_fts, 10.0, 4.0, 1.0, 1.0)` actually run?

`search_candidates` uses **4 weights** including one for the `UNINDEXED` `path` column
(`db.rs`, the `ORDER BY bm25(...)` line). If SQLite's FTS5 rejects the weight count, **both the AND
and OR queries throw**, and every search silently falls through to the `LIKE` branch — which has
**no ranking** and only matches filename/path (not content). That would quietly undo most of V1.

**Verify:**
1. `cd genhat-desktop && npx tauri dev`. Let the crawler index (watch logs for
   `Background ambient crawl completed`).
2. In chat (RAG off) ask something like `find my budget` and watch the terminal logs.
3. **PASS:** you see `ambient search_ranked: '...' -> N results in M ms` and you do **NOT** see
   `FTS AND query failed` / `FTS OR query failed`.
4. **FAIL:** if you see those warnings, the weight count is wrong. Change the `ORDER BY` to **3
   weights** (drop the trailing `path` weight):
   ```rust
   ORDER BY bm25(files_fts, 10.0, 4.0, 1.0)
   ```
   Rebuild and re-test until the warnings are gone. (One of the two forms is correct for this SQLite
   build; keep that one.)

### FIX 3 — latency under 1 s on CPU

The rerank loop in `rank.rs` issues **15 sequential** `router.route(&grade_request(...)).await`
calls (`RERANK_POOL = 15`). Each is a cross-encoder inference. On a slow CPU this can approach or
exceed `RERANK_DEADLINE_MS = 650`, which trips the deadline fallback and returns BM25-order results
(precision loss), or push total time over 1 s.

**Verify & tune:**
1. With the app running (above), do ~5 varied searches. Read the `... in M ms (deadline_hit=...)`
   log line each time.
2. **Targets:** `M < 1000` ms consistently, and `deadline_hit=false` for the common case.
3. If `M` is too high or `deadline_hit=true` often, apply one or more (cheapest first):
   - Lower `RERANK_POOL` from `15` to `10` (fewer cross-encoder calls).
   - Lower `PASSAGE_MAX_CHARS` from `400` to `256` (shorter passages = faster inference).
   - Confirm the **pre-warm** in `main.rs` (`grade_request("warm up", ...)`) actually ran at startup
     (search logs for `[CrossEncoder] Model loaded`). If the FIRST search is the only slow one, the
     pre-warm may not be firing — make sure it isn't gated out.
4. **Do NOT** try to parallelize the rerank calls: the cross-encoder backend holds a single ONNX
   session behind a `Mutex` (`backends/cross_encoder.rs`), so concurrent calls just serialize. Fewer,
   shorter calls is the correct lever.

> Record the observed `M` values in the PR description so the latency budget is documented.

---

## 4. FIX 4 — [MED] Decouple the deadline-fallback score from the relevance threshold

### Symptom (current code)
In `rank.rs`, when the deadline is hit the remaining candidates are pushed with a score of exactly
`MIN_RELEVANCE`, and the final filter keeps `score >= MIN_RELEVANCE`:
```rust
if started.elapsed().as_millis() > RERANK_DEADLINE_MS {
    deadline_hit = true;
    scored.push((c, MIN_RELEVANCE)); // neutral; will pass threshold as a fallback
    continue;
}
...
.filter(|(_, s)| *s >= MIN_RELEVANCE)
```
This works **only because** the fallback score equals the threshold. If anyone later raises
`MIN_RELEVANCE` (e.g. to 0.6 during tuning — see §6), deadline-skipped candidates (still 0.50) get
**dropped**, so on a slow CPU the user can get *zero* results purely due to timing. The two concepts
(precision threshold vs. "ran out of time") should not share a number.

### Change (two-bucket approach) — `rank.rs`
Replace the single `scored` loop + filter with separate "scored" and "overflow" buckets:
```rust
let pool = candidates.into_iter().take(RERANK_POOL).collect::<Vec<_>>();
let mut scored: Vec<(Candidate, f32)> = Vec::new();
let mut overflow: Vec<Candidate> = Vec::new(); // deadline-skipped; keep in BM25 order
let mut deadline_hit = false;

for c in pool {
    if started.elapsed().as_millis() > RERANK_DEADLINE_MS {
        deadline_hit = true;
        overflow.push(c);
        continue;
    }
    let passage = passage_for(&c);
    let req = grade_request(query, &passage);
    let score = match router.route(&req).await {
        Ok(TaskResponse::Score(s)) => s,
        Ok(_) => 0.0,
        Err(e) => { log::debug!("ambient rerank grade failed: {e}"); 0.0 }
    };
    scored.push((c, score));
}

// Precision: sort graded candidates desc and keep those above the threshold.
scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
let mut out: Vec<RankedFileRecord> = scored
    .into_iter()
    .filter(|(_, s)| *s >= MIN_RELEVANCE)
    .map(|(c, s)| to_ranked(c, s))
    .collect();

// Only if we hit the deadline AND still have empty slots, backfill with BM25-order overflow
// so a slow CPU still returns *something*. These are explicitly "unscored" (score = -1.0).
if deadline_hit && out.len() < TOP_K {
    for c in overflow.into_iter().take(TOP_K - out.len()) {
        out.push(to_ranked(c, -1.0));
    }
}
out.truncate(TOP_K);
```
Add a small helper next to `search_ranked` (replaces the inline `.map`):
```rust
fn to_ranked(c: Candidate, score: f32) -> RankedFileRecord {
    RankedFileRecord {
        path: c.path, filename: c.filename, is_dir: c.is_dir,
        size: c.size, mtime: c.mtime, score, snippet: c.snippet,
    }
}
```
Notes:
- Grading failures now score `0.0` (below threshold) instead of `MIN_RELEVANCE`. If the grader is
  entirely down, `scored` will be empty → and (only if `deadline_hit`) overflow backfills. If the
  grader is up but a single pair errors, that one file is correctly demoted.
- `score = -1.0` marks "returned without grading (deadline)". The frontend ignores `score`, so this
  is safe; it just documents intent.

**Verify:** `cargo check`. Logic test: temporarily set `RERANK_DEADLINE_MS = 0` and confirm a search
still returns up to `TOP_K` files (all overflow, BM25 order). Restore `650` afterwards.

---

## 5. FIX 5 — [MED / CONFIRM] Code-file content is no longer searchable

### What changed in V1 (intended)
Per the product decision, code files (`.rs .py .js .ts .tsx .html .css .json .toml .yaml`) **no
longer have their content indexed** — only `txt`/`md` get content; everything else is `=> None`
(`crawler.rs` and `watcher.rs` content match arms). Code files are still findable **by filename and
folder**.

### Consequence to confirm
A query about something *inside* a code file (e.g. *"which file defines the tax calculation"*) can no
longer match on code body — only on the file/folder name. **Confirm this is acceptable.** If yes,
no action; just keep it. (It is the agreed tradeoff to kill the `return`/`list`/`form` token noise.)

### OPTIONAL (only if you later want code body searchable without the noise)
Do **not** do this unless asked. If code-content search is wanted back, the clean way is a separate
low-weight FTS column so it can match but rarely outranks real documents:
1. Add a `code_content` column to the `files_fts` schema (bump `INDEXER_SCHEMA_VERSION` to `3` so the
   migration rebuilds).
2. In `crawler.rs`/`watcher.rs`, route code extensions to `read_first_10kb` again but store the text
   in `code_content` (not `content`); pass it as a new arg through `insert_or_update`.
3. Give it a tiny BM25 weight, e.g. `bm25(files_fts, 10.0, 4.0, 1.0, 0.3 /*code_content*/, 1.0 /*path*/)`
   and add it as a second `snippet()` source when `content` is empty.

This is filed as optional/out-of-scope for now.

---

## 6. FIX 6 — [LOW] Finish the governance docs

Repo rule (`.github/instructions/repository-governance.instructions.md`): all `.github`
customization files must stay in sync with behavior. V1 updated `copilot-instructions.md` and
`agents/genhat.md` but **missed two instruction files**. Add a short, factual note to each:

**`.github/instructions/rust-backend-tauri.instructions.md`** — add a bullet:
> Ambient file search lives in `indexer/` (`db.rs` `search_candidates` = BM25 with weighted columns
> `name`/`location`/`content` + AND-first/OR-fallback; `rank.rs` `search_ranked` reranks the top
> candidates with the in-process `ms-marco-grader` cross-encoder via `router::tasks::grade_request`,
> deadline-guarded, then thresholds to top-K). `search_ambient_files` takes `TaskRouterState`. Code
> files index filename + 2 parent dirs only (no body).

**`.github/instructions/frontend-react-tauri.instructions.md`** — add a bullet:
> `Api.searchAmbientFiles` returns up to 5 records ranked best-first with optional `score`/`snippet`
> (empty array = no relevant file). `handleSend.ts` builds multi-file snippet grounding from the top
> 2–3 results (standard-chat path) and uses the top-ranked result for the artifact path; an empty
> result triggers the `FILE_SEARCH_NO_RESULTS` system message.

Keep these concise; do not paste this whole document into them.

---

## 7. Verification checklist (run all)

1. `cd genhat-desktop/src-tauri && cargo check && cargo build` — no errors.
2. `cd genhat-desktop/src-tauri && cargo check --bin rag-bench` — shared types still compile.
3. `cd genhat-desktop && npm run lint && npm run build` — clean.
4. `cd genhat-desktop && npx tauri dev`, wait for `Background ambient crawl completed`, then:

| Test | Expected |
|---|---|
| `find my budget` (file exists) | log shows `... -> N results in <1000 ms (deadline_hit=false)`, **no** `FTS ... query failed` |
| filename present in two project folders, name one project | the file under the named folder ranks #1 (Fix 1 working) |
| `asdkjfh nonsense` | empty → SLM says "couldn't find it" (NO_RESULTS path) |
| repeat 5 searches | all `< 1000 ms`; deadline rarely/never hit (Fix 3) |
| set `RERANK_DEADLINE_MS = 0` temporarily | still returns up to 5 files (BM25 order); restore 650 (Fix 4) |

---

## 8. Tuning guide

- **`MIN_RELEVANCE` (currently 0.50, in `rank.rs`):** the cross-encoder outputs sigmoid scores in
  [0,1]; relevant passages usually score high (>0.8), irrelevant low (<0.2). To tune: add a
  temporary `log::info!("score={} file={}", s, c.filename)` in the loop, run real queries, look at
  where good vs bad matches separate, and set the threshold in the valley (likely 0.4–0.6). Remove
  the temp log after.
- **`RERANK_POOL` / `PASSAGE_MAX_CHARS`:** lower them if latency is tight (§3). Raising `RERANK_POOL`
  improves recall into the rerank but costs latency linearly.
- **BM25 weights `(name=10, location=4, content=1)`:** raise `name` if filename matches should
  dominate more; raise `location` if folder disambiguation is weak.

---

## 9. Out of scope (do not do)
- Re-enabling code-content search (optional path in §5 only if explicitly asked).
- Whole-corpus embedding/vector index (memory — rejected in V1).
- Rewriting `extractSearchQuery`/`hasSearchKeywords` in `handleSend.ts` (crude but acceptable;
  separate task).
- Renaming the `search_ambient_files` command or any model/task IDs.
