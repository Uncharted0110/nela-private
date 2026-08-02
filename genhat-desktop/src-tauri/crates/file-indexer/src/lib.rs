//! file_indexer_core
//! Stage 1: Tier 0 filename index (build + substring search)
//! Stage 2: persistence (save/load)
//! Stage 3: incremental updates (upsert/remove for live watching) + fuzzy search
//! Stage 4: plain-text content indexing + body search
//! Stage 5: PDF / DOCX / PPTX content extraction, with a Poppler fallback
//! Stage 6: BM25-ranked content search (with short-document length-ratio floor)
//! Stage 7: title/body/semantic fusion via normalized score fusion (CombSUM)
//! Stage 8: semantic (embedding-based) search, with anisotropy correction
//! Stage 9: multi-root indexing + interactive folder configuration

use rayon::prelude::*;
use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::Reader;
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
#[cfg(windows)]
#[allow(unused_imports)]
use ort::ep::DirectML;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;
use walkdir::WalkDir;

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "rs", "py", "rb", "c", "cpp", "h", "hpp", "cs", "js", "ts",
    "json", "toml", "yaml", "yml", "ini", "cfg", "log", "csv",
];

const MAX_TEXT_BYTES: u64 = 2_000_000;
const MAX_DOCUMENT_BYTES: u64 = 30_000_000;

const BM25_K1: f64 = 1.2;
const BM25_B: f64 = 0.75;

/// Semantic search only needs a representative excerpt, not full document
/// text — BM25 body search already covers exact full-text matching
/// separately. Shrinking embedded input is what actually controls
/// embedding speed, since transformer attention cost grows faster than
/// linearly with sequence length.
const EXCERPT_INTRO_CHARS: usize = 200;
const EXCERPT_MAX_HEADINGS: usize = 4;
const EXCERPT_HEADING_MAX_LEN: usize = 60;

/// Common English function words stripped only from the *query* side of
/// lexical matching (title/body) — they carry almost no discriminating
/// power and otherwise drown out words that actually matter. Never applied
/// to document indexing or to text sent to the embedder.
const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
    "he", "in", "is", "it", "its", "of", "on", "that", "the", "to", "was",
    "were", "will", "with", "i", "you", "your", "my", "me", "who", "what",
    "when", "where", "why", "how", "do", "does", "did", "can", "could",
    "would", "should", "this", "these", "those", "there", "here", "am",
];

/// Directory names skipped entirely during indexing — never scanned, never
/// extracted, never embedded. These are vendor/dependency/build-tool
/// trees that are near-universally noise for personal file search: you
/// don't search for "the file inside vcpkg's 40,000-file build cache" by
/// meaning. Matched case-insensitively against the directory name itself,
/// not the full path.
const EXCLUDED_DIR_NAMES: &[&str] = &[
    ".git", ".svn", ".hg", ".vs", "node_modules", "vcpkg", "vcpkg_installed",
    "__pycache__", ".venv", "venv", "target", ".cache",
];

fn is_excluded_dir(entry: &walkdir::DirEntry) -> bool {
    if !entry.file_type().is_dir() {
        return false;
    }
    entry
        .file_name()
        .to_str()
        .map(|name| EXCLUDED_DIR_NAMES.iter().any(|ex| ex.eq_ignore_ascii_case(name)))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContentSource {
    PlainText,
    Docx,
    Pptx,
    PdfNative,
    PdfPoppler,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchField {
    Title,
    Body,
    Semantic,
}

pub struct FusedResult<'a> {
    pub entry: &'a FileEntry,
    pub score: f64,
    pub matched_fields: Vec<MatchField>,
}

fn looks_like_real_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.chars().count() < 20 {
        return false;
    }
    let total = trimmed.chars().count() as f32;
    let plausible = trimmed
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || c.is_ascii_punctuation())
        .count() as f32;
    plausible / total > 0.85
}

fn extract_pdf_via_poppler(path: &Path) -> Option<String> {
    let output = Command::new("pdftotext")
        .args(["-q", "-enc", "UTF-8"])
        .arg(path)
        .arg("-")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    looks_like_real_text(&text).then_some(text)
}

fn extract_pdf_text(path: &Path) -> Option<(String, ContentSource)> {
    // pdf_extract can panic (not just return Err) on malformed embedded
    // font data — seen in practice with certain Type3 fonts carrying
    // corrupt width tables. catch_unwind stops that panic from crashing
    // the whole program; a single bad PDF should fall through to the
    // Poppler fallback like any other extraction failure, not take down
    // the indexer.
    let path_owned = path.to_path_buf();
    let native_result = std::panic::catch_unwind(move || pdf_extract::extract_text(&path_owned));

    if let Ok(Ok(text)) = native_result {
        if looks_like_real_text(&text) {
            return Some((text, ContentSource::PdfNative));
        }
    }
    extract_pdf_via_poppler(path).map(|t| (t, ContentSource::PdfPoppler))
}

fn extract_tag_text(xml: &str, text_tag: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut capturing = false;
    let mut out = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.name().as_ref() == text_tag.as_bytes() => {
                capturing = true;
            }
            Ok(Event::End(e)) if e.name().as_ref() == text_tag.as_bytes() => {
                capturing = false;
            }
            Ok(Event::Text(e)) if capturing => {
                if let Ok(decoded) = e.decode() {
                    if let Ok(text) = unescape(&decoded) {
                        out.push_str(&text);
                        out.push(' ');
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

fn extract_ooxml_text(path: &Path, part_matches: impl Fn(&str) -> bool, text_tag: &str) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut combined = String::new();

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        if !part_matches(&name) {
            continue;
        }
        let mut xml = String::new();
        if entry.read_to_string(&mut xml).is_err() {
            continue;
        }
        combined.push_str(&extract_tag_text(&xml, text_tag));
    }

    (!combined.trim().is_empty()).then_some(combined)
}

fn extract_content(path: &Path, size: u64) -> Option<(String, ContentSource)> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    match ext.as_deref() {
        Some(e) if TEXT_EXTENSIONS.contains(&e) => {
            if size > MAX_TEXT_BYTES {
                return None;
            }
            fs::read_to_string(path).ok().map(|s| (s, ContentSource::PlainText))
        }
        Some("pdf") => {
            if size > MAX_DOCUMENT_BYTES {
                return None;
            }
            extract_pdf_text(path)
        }
        Some("docx") => {
            if size > MAX_DOCUMENT_BYTES {
                return None;
            }
            extract_ooxml_text(path, |name| name == "word/document.xml", "w:t")
                .map(|s| (s, ContentSource::Docx))
        }
        Some("pptx") => {
            if size > MAX_DOCUMENT_BYTES {
                return None;
            }
            extract_ooxml_text(
                path,
                |name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
                "a:t",
            )
            .map(|s| (s, ContentSource::Pptx))
        }
        _ => None,
    }
    .map(|(text, source)| (text.to_lowercase(), source))
}

fn word_tokens(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect()
}

fn tokens(name_lower: &str) -> Vec<&str> {
    name_lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect()
}

fn auto_fuzzy_distance(len: usize) -> usize {
    match len {
        0..=2 => 0,
        3..=5 => 1,
        _ => 2,
    }
}

/// Removes stopwords from a query's tokens. If every token happens to be a
/// stopword, falls back to the original unfiltered list — an imperfect
/// match beats returning nothing.
fn filter_stopwords(words: Vec<&str>) -> Vec<&str> {
    let filtered: Vec<&str> = words.iter().copied().filter(|w| !STOPWORDS.contains(w)).collect();
    if filtered.is_empty() { words } else { filtered }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TermStats {
    term_freq: HashMap<String, u32>,
    doc_len: u32,
}

impl TermStats {
    fn from_content(content_lower: &str) -> Self {
        let mut term_freq: HashMap<String, u32> = HashMap::new();
        let mut doc_len = 0u32;
        for tok in word_tokens(content_lower) {
            *term_freq.entry(tok.to_string()).or_insert(0) += 1;
            doc_len += 1;
        }
        Self { term_freq, doc_len }
    }
}

/// Wraps the embedding model. Expensive to construct — create exactly one
/// and reuse it everywhere.
pub struct Embedder(TextEmbedding);

impl Embedder {
    /// First call on a machine downloads the model to local cache.
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        Self::with_cache_dir_opt(None)
    }

    /// Load (or download into) a specific fastembed cache directory.
    /// Expected layout: `{cache_dir}/models--Qdrant--all-MiniLM-L6-v2-onnx/...`
    pub fn with_cache_dir(cache_dir: impl AsRef<Path>) -> Result<Self, Box<dyn std::error::Error>> {
        Self::with_cache_dir_opt(Some(cache_dir.as_ref().to_path_buf()))
    }

    fn with_cache_dir_opt(cache_dir: Option<PathBuf>) -> Result<Self, Box<dyn std::error::Error>> {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let mut opts = InitOptions::new(EmbeddingModel::AllMiniLML6V2Q)
            .with_show_download_progress(true)
            .with_intra_threads(cores);
        if let Some(dir) = cache_dir {
            std::fs::create_dir_all(&dir)?;
            opts = opts.with_cache_dir(dir);
        }
        let model = TextEmbedding::try_new(opts)?;
        Ok(Self(model))
    }

    pub fn embed_many(&mut self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
        let batch_size = texts.len();
        Ok(self.0.embed(texts, Some(batch_size))?)
    }

    pub fn embed_one(&mut self, text: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let mut result = self.0.embed(vec![text.to_string()], None)?;
        Ok(result.remove(0))
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a * norm_b)
}

/// Rescales a list of (index, score) pairs to 0-1 based on that list's own
/// min/max. Used to fuse rankers whose raw scores live on incompatible
/// scales (BM25 vs. cosine vs. inverse edit-distance).
fn min_max_normalize(scored: &[(usize, f64)]) -> HashMap<usize, f64> {
    if scored.is_empty() {
        return HashMap::new();
    }
    let min = scored.iter().map(|(_, s)| *s).fold(f64::INFINITY, f64::min);
    let max = scored.iter().map(|(_, s)| *s).fold(f64::NEG_INFINITY, f64::max);
    let range = max - min;
    scored
        .iter()
        .map(|(idx, s)| {
            let norm = if range > 0.0 { (s - min) / range } else { 1.0 };
            (*idx, norm)
        })
        .collect()
}

/// A line is code-like (not a genuine heading) if it's mostly punctuation
/// or contains obvious code syntax — braces, semicolons, includes,
/// indentation-style whitespace. Without this check, the old heuristic
/// misfired badly on source files: nearly every short C++/header line
/// (function signatures, `#include`, closing braces) looks like a
/// "heading" under a pure length/punctuation rule, quietly inflating
/// embedded text for every code file back toward full-length.
fn looks_like_code_line(line: &str) -> bool {
    let code_chars = ['{', '}', ';', '#', '<', '>', '(', ')', '='];
    let code_char_count = line.chars().filter(|c| code_chars.contains(c)).count();
    let total = line.chars().count().max(1);
    (code_char_count as f32 / total as f32) > 0.15
}

fn build_semantic_excerpt(content_lower: &str) -> String {
    let intro: String = content_lower.chars().take(EXCERPT_INTRO_CHARS).collect();

    let headings: Vec<&str> = content_lower
        .lines()
        .filter(|line| {
            let t = line.trim();
            if t.is_empty() || t.chars().count() > EXCERPT_HEADING_MAX_LEN {
                return false;
            }
            if looks_like_code_line(t) {
                return false;
            }
            t.starts_with('#') || (!t.ends_with('.') && !t.ends_with(',') && t.split_whitespace().count() <= 8)
        })
        .take(EXCERPT_MAX_HEADINGS)
        .collect();

    let mut excerpt = intro;
    if !headings.is_empty() {
        excerpt.push(' ');
        excerpt.push_str(&headings.join(" "));
    }
    excerpt
}

/// The text an entry contributes to its own embedding.
fn embedding_source_text(entry: &FileEntry) -> String {
    if let Some(content) = &entry.content_lower {
        return build_semantic_excerpt(content);
    }
    // No extractable content: embed filename + a couple parent folder
    // names, so files sharing a basename (vendored duplicate libs, etc.)
    // don't collapse into identical embeddings.
    let parent_parts: Vec<String> = entry
        .path
        .parent()
        .map(|p| {
            p.components()
                .rev()
                .take(2)
                .filter_map(|c| c.as_os_str().to_str())
                .map(|s| s.to_lowercase())
                .collect()
        })
        .unwrap_or_default();
    let mut text = parent_parts.join(" ");
    text.push(' ');
    text.push_str(
        &entry
            .name_lower
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { ' ' })
            .collect::<String>(),
    );
    text
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: PathBuf,
    pub name: String,
    name_lower: String,
    pub size: u64,
    pub modified: Option<SystemTime>,
    content_lower: Option<String>,
    pub content_source: Option<ContentSource>,
    term_stats: Option<TermStats>,
    embedding: Option<Vec<f32>>,
    /// True if `embedding` was built from the filename/path fallback
    /// rather than real extracted content.
    embedding_is_fallback: bool,
}

impl FileEntry {
    fn build(path: PathBuf, metadata: &std::fs::Metadata) -> Option<Self> {
        let name = path.file_name()?.to_string_lossy().into_owned();
        let name_lower = name.to_lowercase();
        let size = metadata.len();
        let (content_lower, content_source, term_stats) = match extract_content(&path, size) {
            Some((text, source)) => {
                let stats = TermStats::from_content(&text);
                (Some(text), Some(source), Some(stats))
            }
            None => (None, None, None),
        };
        Some(Self {
            path,
            name,
            name_lower,
            size,
            modified: metadata.modified().ok(),
            embedding_is_fallback: content_lower.is_none(),
            content_lower,
            content_source,
            term_stats,
            embedding: None,
        })
    }

    fn from_dir_entry(entry: &walkdir::DirEntry) -> Option<Self> {
        let metadata = entry.metadata().ok()?;
        Self::build(entry.path().to_path_buf(), &metadata)
    }

    fn from_path(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        Self::build(path.to_path_buf(), &metadata)
    }

    pub fn has_content(&self) -> bool {
        self.content_lower.is_some()
    }

    pub fn has_embedding(&self) -> bool {
        self.embedding.is_some()
    }

    pub fn extension(&self) -> Option<String> {
        self.path.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase())
    }
}

#[derive(Serialize, Deserialize)]
pub struct FilenameIndex {
    entries: Vec<FileEntry>,
}

impl FilenameIndex {
    /// Builds an index from a single root — delegates to `build_from_roots`.
    pub fn build<P: AsRef<Path>>(root: P) -> Self {
        Self::build_from_roots(&[root])
    }

    /// Builds an index by walking multiple root folders and merging results.
    /// Directory traversal itself stays sequential (inherent to walking a
    /// tree), but per-file work — metadata reads, content extraction —
    /// is fully independent between files, so it's parallelized across
    /// all available cores via rayon. This is the real cost center for
    /// folders with lots of real documents (PDF/DOCX/PPTX parsing is not
    /// cheap), not the directory walk itself.
    pub fn build_from_roots<P: AsRef<Path>>(roots: &[P]) -> Self {
        Self::build_from_roots_with_progress(roots, |_, _, _| {})
    }

    /// Same as [`build_from_roots`], but invokes `on_progress(phase, files_seen, files_total)`
    /// during the walk (`files_total == 0`) and content extraction (`files_total > 0`).
    pub fn build_from_roots_with_progress<P, F>(roots: &[P], mut on_progress: F) -> Self
    where
        P: AsRef<Path>,
        F: FnMut(&str, usize, usize),
    {
        let mut all_paths: Vec<PathBuf> = Vec::new();
        let overall_start = std::time::Instant::now();

        for root in roots {
            let root = root.as_ref();
            eprintln!("Scanning {}...", root.display());
            on_progress("walking", all_paths.len(), 0);
            let walk_start = std::time::Instant::now();
            let mut count = 0u64;

            for entry in WalkDir::new(root)
                .follow_links(true)
                .into_iter()
                .filter_entry(|e| !is_excluded_dir(e))
            {                let Ok(entry) = entry else { continue };
                if !entry.file_type().is_file() {
                    continue;
                }
                all_paths.push(entry.path().to_path_buf());
                count += 1;
                if count % 2000 == 0 {
                    on_progress("walking", all_paths.len(), 0);
                }
            }
            eprintln!(
                "  found {count} files in {} ({:.1}s)",
                root.display(),
                walk_start.elapsed().as_secs_f64()
            );
            on_progress("walking", all_paths.len(), 0);
        }

        eprintln!(
            "All roots walked: {} files found ({:.1}s elapsed). Extracting content in parallel across {} cores...",
            all_paths.len(),
            overall_start.elapsed().as_secs_f64(),
            rayon::current_num_threads()
        );

        let extract_start = std::time::Instant::now();
        let total = all_paths.len();
        on_progress("extracting", 0, total);

        // Chunk so we can emit progress between rayon batches (FnMut can't cross workers).
        let mut entries: Vec<FileEntry> = Vec::with_capacity(total);
        const CHUNK: usize = 100;
        for (chunk_idx, chunk) in all_paths.chunks(CHUNK).enumerate() {
            let chunk_entries: Vec<FileEntry> = chunk
                .par_iter()
                .filter_map(|path| {
                    let metadata = std::fs::metadata(path).ok()?;
                    FileEntry::build(path.clone(), &metadata)
                })
                .collect();
            let done = ((chunk_idx + 1) * CHUNK).min(total);
            on_progress("extracting", done, total);
            if done % 500 < CHUNK || done == total {
                eprintln!(
                    "  processed {done}/{total} ({:.1}s elapsed)...",
                    extract_start.elapsed().as_secs_f64()
                );
            }
            entries.extend(chunk_entries);
        }

        eprintln!(
            "All content processed: {} entries built ({:.1}s elapsed)",
            entries.len(),
            extract_start.elapsed().as_secs_f64()
        );
        Self { entries }
    }

    /// Walks a single additional root and upserts every file found into
    /// this already-built index. Unchanged files (same size + mtime) are skipped.
    pub fn add_root<P: AsRef<Path>>(&mut self, root: P) {
        self.add_root_with_progress(root, |_, _| {});
    }

    /// Like [`add_root`], with `on_progress(seen, changed)`.
    pub fn add_root_with_progress<P, F>(&mut self, root: P, mut on_progress: F)
    where
        P: AsRef<Path>,
        F: FnMut(usize, usize),
    {
        let root = root.as_ref();
        let mut seen = 0usize;
        let mut changed = 0usize;
        for entry in WalkDir::new(root)
            .follow_links(true)
            .into_iter()
            .filter_entry(|e| !is_excluded_dir(e))
        {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() {
                continue;
            }
            seen += 1;
            if self.upsert_path_if_changed(entry.path()) {
                changed += 1;
            }
            if seen % 500 == 0 {
                on_progress(seen, changed);
            }
        }
        on_progress(seen, changed);
        eprintln!("  synced {changed} changed / {seen} seen from {}", root.display());
    }

    /// Drop entries that no longer fall under any configured root.
    pub fn retain_under_roots<P: AsRef<Path>>(&mut self, roots: &[P]) {
        self.entries.retain(|e| {
            roots.iter().any(|r| {
                let root = r.as_ref();
                e.path.starts_with(root)
            })
        });
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn search(&self, query: &str) -> Vec<&FileEntry> {
        let query_lower = query.to_lowercase();
        if query_lower.is_empty() {
            return Vec::new();
        }
        self.entries.iter().filter(|e| e.name_lower.contains(&query_lower)).collect()
    }

    pub fn search_content(&self, query: &str) -> Vec<&FileEntry> {
        let query_lower = query.to_lowercase();
        if query_lower.is_empty() {
            return Vec::new();
        }
        self.entries
            .iter()
            .filter(|e| e.content_lower.as_ref().map(|c| c.contains(&query_lower)).unwrap_or(false))
            .collect()
    }

    /// Ranks entries by title relevance. Whole-string check first, then
    /// each query word is checked separately against the filename's own
    /// tokens — this is what makes multi-word queries find files whose
    /// name only shares one significant word with the query.
    fn rank_title_indices(&self, query_lower: &str) -> Vec<(usize, usize)> {
        if query_lower.is_empty() {
            return Vec::new();
        }
        let query_words: Vec<&str> = filter_stopwords(word_tokens(query_lower));

        let mut candidates: Vec<(usize, usize)> = Vec::new();
        for (i, e) in self.entries.iter().enumerate() {
            if e.name_lower.contains(query_lower) {
                candidates.push((i, 0));
                continue;
            }

            let name_tokens = tokens(&e.name_lower);
            let best = query_words
                .iter()
                .filter_map(|qw| {
                    if e.name_lower.contains(qw) {
                        return Some(0);
                    }
                    name_tokens
                        .iter()
                        .filter_map(|t| {
                            let d = strsim::levenshtein(t, qw);
                            (d <= auto_fuzzy_distance(qw.chars().count())).then_some(d)
                        })
                        .min()
                })
                .min();

            if let Some(dist) = best {
                candidates.push((i, dist));
            }
        }
        candidates.sort_by_key(|(_, d)| *d);
        candidates
    }

    /// BM25-ranked content search indices, with a length-ratio floor so a
    /// pathologically short document can't get an outsized score boost
    /// from length normalization relative to much longer, more relevant
    /// documents.
    fn rank_body_indices(&self, query: &str) -> Vec<(usize, f64)> {
        let query_terms: Vec<String> = filter_stopwords(word_tokens(&query.to_lowercase()))
            .into_iter()
            .map(|t| t.to_string())
            .collect();
        if query_terms.is_empty() {
            return Vec::new();
        }

        let doc_indices: Vec<usize> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.term_stats.is_some())
            .map(|(i, _)| i)
            .collect();
        let n = doc_indices.len() as f64;
        if n == 0.0 {
            return Vec::new();
        }

        let avg_dl: f64 = doc_indices
            .iter()
            .map(|&i| self.entries[i].term_stats.as_ref().unwrap().doc_len as f64)
            .sum::<f64>()
            / n;

        let mut doc_freq: HashMap<&str, f64> = HashMap::new();
        for term in &query_terms {
            let df = doc_indices
                .iter()
                .filter(|&&i| {
                    self.entries[i].term_stats.as_ref().unwrap().term_freq.contains_key(term.as_str())
                })
                .count() as f64;
            doc_freq.insert(term.as_str(), df);
        }

        let mut scored: Vec<(usize, f64)> = doc_indices
            .into_iter()
            .filter_map(|i| {
                let stats = self.entries[i].term_stats.as_ref().unwrap();
                let dl = stats.doc_len as f64;
                let mut score = 0.0;
                for term in &query_terms {
                    let tf = *stats.term_freq.get(term.as_str()).unwrap_or(&0) as f64;
                    if tf == 0.0 {
                        continue;
                    }
                    let df = doc_freq[term.as_str()];
                    let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                    let length_ratio = (dl / avg_dl).max(0.5);
                    let numerator = tf * (BM25_K1 + 1.0);
                    let denominator = tf + BM25_K1 * (1.0 - BM25_B + BM25_B * length_ratio);
                    score += idf * (numerator / denominator);
                }
                (score > 0.0).then_some((i, score))
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        scored
    }

    pub fn search_content_ranked(&self, query: &str) -> Vec<(&FileEntry, f64)> {
        self.rank_body_indices(query).into_iter().map(|(i, score)| (&self.entries[i], score)).collect()
    }

    pub fn fuzzy_search(&self, query: &str, max_distance: usize) -> Vec<(&FileEntry, usize)> {
        let query_lower = query.to_lowercase();
        let mut scored: Vec<(&FileEntry, usize)> = self
            .entries
            .iter()
            .filter_map(|e| {
                let cap = max_distance.min(auto_fuzzy_distance(query_lower.chars().count()));
                let dist = tokens(&e.name_lower)
                    .into_iter()
                    .filter_map(|t| {
                        let d = strsim::levenshtein(t, &query_lower);
                        (d <= cap).then_some(d)
                    })
                    .min()?;
                (dist > 0).then_some((e, dist))
            })
            .collect();
        scored.sort_by_key(|(_, d)| *d);
        scored
    }

    /// Fused title + body + semantic search via normalized score fusion
    /// (CombSUM with min-max normalization). Preserves real score
    /// magnitude, unlike RRF, so a genuine standout keeps a real gap over
    /// weaker matches instead of everything decaying by rank alone.
    pub fn search_fused(&self, embedder: &mut Embedder, query: &str) -> Vec<FusedResult<'_>> {
        let query_lower = query.to_lowercase();

        let title_ranked = self.rank_title_indices(&query_lower);
        let title_scored: Vec<(usize, f64)> = title_ranked
            .iter()
            .map(|(idx, dist)| (*idx, 1.0 / (1.0 + *dist as f64)))
            .collect();

        let body_scored = self.rank_body_indices(query);

        let semantic_scored: Vec<(usize, f64)> = self
            .search_semantic(embedder, query, 100)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(entry, sim)| {
                self.entries.iter().position(|e| std::ptr::eq(e, entry)).map(|idx| (idx, sim as f64))
            })
            .collect();

        let title_norm = min_max_normalize(&title_scored);
        let body_norm = min_max_normalize(&body_scored);
        let semantic_norm = min_max_normalize(&semantic_scored);

        const TITLE_WEIGHT: f64 = 1.0;
        const BODY_WEIGHT: f64 = 1.0;
        // Semantic gets slightly less weight — it's the noisier signal of
        // the three, so it should contribute, not dominate, when lexical
        // signals disagree.
        const SEMANTIC_WEIGHT: f64 = 0.7;

        let mut combined: HashMap<usize, (f64, Vec<MatchField>)> = HashMap::new();

        for (idx, norm_score) in &title_norm {
            let entry = combined.entry(*idx).or_insert((0.0, Vec::new()));
            entry.0 += norm_score * TITLE_WEIGHT;
            entry.1.push(MatchField::Title);
        }
        for (idx, norm_score) in &body_norm {
            let entry = combined.entry(*idx).or_insert((0.0, Vec::new()));
            entry.0 += norm_score * BODY_WEIGHT;
            entry.1.push(MatchField::Body);
        }
        for (idx, norm_score) in &semantic_norm {
            let entry = combined.entry(*idx).or_insert((0.0, Vec::new()));
            entry.0 += norm_score * SEMANTIC_WEIGHT;
            entry.1.push(MatchField::Semantic);
        }

        let mut results: Vec<FusedResult> = combined
            .into_iter()
            .map(|(idx, (score, matched_fields))| FusedResult {
                entry: &self.entries[idx],
                score,
                matched_fields,
            })
            .collect();

        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        results
    }

    /// Computes and stores embeddings for every entry that doesn't already
    /// have one. Deduplicates by content hash first — vendored/duplicated
    /// directory trees commonly contain byte-identical files, and
    /// embedding each unique text once (sharing the vector across every
    /// entry with that text) avoids redundant model calls entirely.
    /// Computes and stores embeddings for every entry that doesn't already
    /// have one, checkpointing to disk periodically. Without this, an
    /// interrupted run (Ctrl+C, crash, closing the terminal) on a large
    /// folder loses all progress — a multi-minute operation with no
    /// checkpoint is fragile by construction, especially once folders can
    /// contain tens of thousands of files (vendored dependency trees, SDKs).
    pub fn build_embeddings(
        &mut self,
        embedder: &mut Embedder,
        checkpoint_path: &Path,
        batch_size: usize,
    ) -> Result<usize, Box<dyn std::error::Error>> {
        self.build_embeddings_with_progress(embedder, checkpoint_path, batch_size, |_, _| {})
    }

    /// Like [`Self::build_embeddings`], but reports `(done_unique, total_unique)` after each batch.
    pub fn build_embeddings_with_progress<F>(
        &mut self,
        embedder: &mut Embedder,
        checkpoint_path: &Path,
        batch_size: usize,
        mut on_progress: F,
    ) -> Result<usize, Box<dyn std::error::Error>>
    where
        F: FnMut(usize, usize),
    {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        const CHECKPOINT_EVERY_N_BATCHES: usize = 20;

        let pending_indices: Vec<usize> =
            self.entries.iter().enumerate().filter(|(_, e)| e.embedding.is_none()).map(|(i, _)| i).collect();

        if pending_indices.is_empty() {
            return Ok(self.entries.iter().filter(|e| e.embedding.is_some()).count());
        }

        let mut hash_to_text: HashMap<u64, String> = HashMap::new();
        let mut hash_to_indices: HashMap<u64, Vec<usize>> = HashMap::new();
        for &idx in &pending_indices {
            let text = embedding_source_text(&self.entries[idx]);
            let mut hasher = DefaultHasher::new();
            text.hash(&mut hasher);
            let h = hasher.finish();
            hash_to_indices.entry(h).or_default().push(idx);
            hash_to_text.entry(h).or_insert(text);
        }

        let unique_hashes: Vec<u64> = hash_to_text.keys().copied().collect();
        let total_unique = unique_hashes.len();
        let total_pending = pending_indices.len();
        let duplicates_skipped = total_pending - total_unique;
        eprintln!("  {total_pending} files pending, {total_unique} unique texts ({duplicates_skipped} duplicates skipped)");
        on_progress(0, total_unique);

        let start = std::time::Instant::now();
        let mut done_unique = 0usize;
        for (batch_num, chunk) in unique_hashes.chunks(batch_size).enumerate() {
            let texts: Vec<String> = chunk.iter().map(|h| hash_to_text[h].clone()).collect();
            let vectors = embedder.embed_many(texts)?;
            for (h, vec) in chunk.iter().zip(vectors) {
                for &idx in &hash_to_indices[h] {
                    self.entries[idx].embedding = Some(vec.clone());
                }
            }
            done_unique += chunk.len();
            let elapsed = start.elapsed().as_secs_f64();
            let rate = done_unique as f64 / elapsed.max(0.001);
            eprintln!("  embedded {done_unique}/{total_unique} unique  ({elapsed:.1}s elapsed, {rate:.0}/s)");
            on_progress(done_unique, total_unique);

            if (batch_num + 1) % CHECKPOINT_EVERY_N_BATCHES == 0 {
                if let Err(e) = self.save(checkpoint_path) {
                    eprintln!("  warning: checkpoint save failed: {e}");
                } else {
                    eprintln!("  (checkpoint saved — safe to interrupt from here)");
                }
            }
        }

        self.save(checkpoint_path)?;
        Ok(self.entries.iter().filter(|e| e.embedding.is_some()).count())
    }

    /// Benchmarks a handful of candidate batch sizes on a real sample of
    /// this corpus's actual embedding text, and returns whichever was
    /// fastest. Batch-size-vs-throughput isn't monotonic — it depends on
    /// a tradeoff between fixed per-call overhead (favors bigger batches)
    /// and memory/cache pressure (favors smaller batches on constrained
    /// hardware) — so guessing a "reasonable" number isn't reliable across
    /// different machines or excerpt lengths. This measures it directly
    /// instead of assuming.
    pub fn benchmark_batch_size(
        &self,
        embedder: &mut Embedder,
        candidates: &[usize],
        sample_size: usize,
    ) -> usize {
        let sample_texts: Vec<String> = self
            .entries
            .iter()
            .filter(|e| e.content_lower.is_some())
            .take(sample_size)
            .map(embedding_source_text)
            .collect();

        if sample_texts.len() < sample_size {
            eprintln!(
                "  (only {} sample texts available, benchmark may be less reliable)",
                sample_texts.len()
            );
        }
        if sample_texts.is_empty() {
            eprintln!("  (no content available to benchmark against — defaulting to batch size 32)");
            return 32;
        }

        eprintln!("  Benchmarking batch sizes on {} sample texts...", sample_texts.len());
        let mut best_batch = candidates[0];
        let mut best_rate = 0.0f64;

        for &batch_size in candidates {
            let mut total_embedded = 0usize;
            let start = std::time::Instant::now();

            for chunk in sample_texts.chunks(batch_size) {
                if embedder.embed_many(chunk.to_vec()).is_err() {
                    continue;
                }
                total_embedded += chunk.len();
            }

            let elapsed = start.elapsed().as_secs_f64();
            let rate = total_embedded as f64 / elapsed.max(0.001);
            eprintln!("    batch {batch_size}: {rate:.0}/s");

            if rate > best_rate {
                best_rate = rate;
                best_batch = batch_size;
            }
        }

        eprintln!("  Best: batch size {best_batch} ({best_rate:.0}/s)");
        best_batch
    }

    /// Semantic search with anisotropy correction (mean-centering) and
    /// tiered results: real-content matches always rank above
    /// filename/path-fallback matches, since fallback text is short and
    /// prone to spuriously high raw cosine similarity.
    pub fn search_semantic(
        &self,
        embedder: &mut Embedder,
        query: &str,
        top_k: usize,
    ) -> Result<Vec<(&FileEntry, f32)>, Box<dyn std::error::Error>> {
        let query_vec = embedder.embed_one(query)?;

        let dim = match self.entries.iter().find_map(|e| e.embedding.as_ref().map(|v| v.len())) {
            Some(d) => d,
            None => return Ok(Vec::new()),
        };
        let mut mean = vec![0f32; dim];
        let mut count = 0usize;
        for e in &self.entries {
            if let Some(v) = &e.embedding {
                for (m, x) in mean.iter_mut().zip(v) {
                    *m += x;
                }
                count += 1;
            }
        }
        if count == 0 {
            return Ok(Vec::new());
        }
        for m in mean.iter_mut() {
            *m /= count as f32;
        }

        let center = |v: &[f32]| -> Vec<f32> { v.iter().zip(&mean).map(|(x, m)| x - m).collect() };
        let centered_query = center(&query_vec);

        let mut content_scored: Vec<(&FileEntry, f32)> = Vec::new();
        let mut fallback_scored: Vec<(&FileEntry, f32)> = Vec::new();

        for e in &self.entries {
            if let Some(v) = &e.embedding {
                let sim = cosine_similarity(&centered_query, &center(v));
                if e.embedding_is_fallback {
                    fallback_scored.push((e, sim));
                } else {
                    content_scored.push((e, sim));
                }
            }
        }

        content_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        fallback_scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

        content_scored.extend(fallback_scored);
        content_scored.truncate(top_k);
        Ok(content_scored)
    }

    /// Diagnostic: raw semantic similarity (no centering) of specific
    /// files against a query.
    pub fn debug_semantic_score(
        &self,
        embedder: &mut Embedder,
        name_filter: &str,
        query: &str,
    ) -> Result<Vec<(&FileEntry, f32)>, Box<dyn std::error::Error>> {
        let query_vec = embedder.embed_one(query)?;
        let filter_lower = name_filter.to_lowercase();
        let mut out: Vec<(&FileEntry, f32)> = self
            .entries
            .iter()
            .filter(|e| e.name_lower.contains(&filter_lower))
            .filter_map(|e| e.embedding.as_ref().map(|v| (e, cosine_similarity(&query_vec, v))))
            .collect();
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        Ok(out)
    }

    /// Diagnostic: each ranker's raw contribution to a file's fused score,
    /// separately — title (inverse-distance), BM25 body, raw semantic.
    pub fn debug_fusion_breakdown(
        &self,
        embedder: &mut Embedder,
        name_filter: &str,
        query: &str,
    ) -> Vec<(String, Option<f64>, Option<f64>, Option<f32>)> {
        let query_lower = query.to_lowercase();
        let filter_lower = name_filter.to_lowercase();

        let title_ranked = self.rank_title_indices(&query_lower);
        let body_ranked = self.rank_body_indices(query);
        let semantic_ranked = self.search_semantic(embedder, query, self.entries.len()).unwrap_or_default();

        self.entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.name_lower.contains(&filter_lower))
            .map(|(i, e)| {
                let title_score =
                    title_ranked.iter().find(|(idx, _)| *idx == i).map(|(_, dist)| 1.0 / (1.0 + *dist as f64));
                let body_score = body_ranked.iter().find(|(idx, _)| *idx == i).map(|(_, score)| *score);
                let semantic_score = semantic_ranked
                    .iter()
                    .find(|(entry, _)| std::ptr::eq(*entry, e))
                    .map(|(_, score)| *score);
                (e.path.display().to_string(), title_score, body_score, semantic_score)
            })
            .collect()
    }

    /// Distinct extensions present among a set of entries, most common
    /// first — used to offer "narrow by file type" as concrete choices.
    pub fn extension_breakdown(entries: &[&FileEntry]) -> Vec<(String, usize)> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for e in entries {
            let ext = e.extension().unwrap_or_else(|| "(no extension)".to_string());
            *counts.entry(ext).or_insert(0) += 1;
        }
        let mut out: Vec<(String, usize)> = counts.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1));
        out
    }

    pub fn iter(&self) -> impl Iterator<Item = &FileEntry> {
        self.entries.iter()
    }

    pub fn upsert_path(&mut self, path: &Path) {
        self.remove_path(path);
        if let Some(entry) = FileEntry::from_path(path) {
            self.entries.push(entry);
        }
    }

    /// Upsert only when the file is new or its size/mtime changed. Returns true if changed.
    pub fn upsert_path_if_changed(&mut self, path: &Path) -> bool {
        let metadata = match std::fs::metadata(path) {
            Ok(m) if m.is_file() => m,
            _ => {
                let had = self.entries.iter().any(|e| e.path == path);
                self.remove_path(path);
                return had;
            }
        };
        let size = metadata.len();
        let modified = metadata.modified().ok();
        if let Some(existing) = self.entries.iter().find(|e| e.path == path) {
            if existing.size == size && existing.modified == modified {
                return false;
            }
        }
        self.upsert_path(path);
        true
    }

    pub fn remove_path(&mut self, path: &Path) {
        self.entries.retain(|e| e.path != path);
    }

    pub fn save<P: AsRef<Path>>(&self, path: P) -> Result<(), Box<dyn std::error::Error>> {
        let path = path.as_ref();
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let tmp = parent.join(format!(
            "{}.tmp",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file_indexer_index.bin")
        ));
        {
            let file = File::create(&tmp)?;
            bincode::serialize_into(BufWriter::new(file), &self.entries)?;
        }
        // Never truncate the live index first — write temp, then replace.
        // Windows can't rename over an existing file, so copy-replace there.
        if path.exists() {
            fs::copy(&tmp, path)?;
            let _ = fs::remove_file(&tmp);
        } else if let Err(e) = fs::rename(&tmp, path) {
            fs::copy(&tmp, path).map_err(|_| e)?;
            let _ = fs::remove_file(&tmp);
        }
        Ok(())
    }

    pub fn load<P: AsRef<Path>>(path: P) -> Result<Self, Box<dyn std::error::Error>> {
        let path = path.as_ref();
        let meta = fs::metadata(path)?;
        if meta.len() == 0 {
            return Err("index file is empty (truncated write)".into());
        }
        let file = File::open(path)?;
        let entries: Vec<FileEntry> = bincode::deserialize_from(BufReader::new(file))?;
        Ok(Self { entries })
    }
}