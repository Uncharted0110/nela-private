//! Interactive CLI: multi-root config, build/load, live watching, and
//! search (exact + fuzzy + BM25 + semantic, fused and ranked).

use file_indexer::{Embedder, FilenameIndex};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::env;
use std::io::{self, Write};
use std::sync::mpsc;
use std::sync::{Arc, RwLock};

const ROOTS_CONFIG_PATH: &str = "file_indexer_roots.txt";


fn load_roots() -> Vec<std::path::PathBuf> {
    std::fs::read_to_string(ROOTS_CONFIG_PATH)
        .unwrap_or_default()
        .lines()
        .map(|l| std::path::PathBuf::from(l.trim()))
        .filter(|p| !p.as_os_str().is_empty())
        .collect()
}

fn save_roots(roots: &[std::path::PathBuf]) {
    let content = roots.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join("\n");
    let _ = std::fs::write(ROOTS_CONFIG_PATH, content);
}

/// Interactively asks the user for folders to index, one per line, until
/// a blank line is entered.
fn prompt_for_roots() -> Vec<std::path::PathBuf> {
    println!("No folders configured yet. Enter folders to index, one per line.");
    println!("(blank line when done)");
    let mut roots = Vec::new();
    let stdin = io::stdin();
    loop {
        print!("  folder> ");
        io::stdout().flush().unwrap();
        let mut line = String::new();
        if stdin.read_line(&mut line).unwrap() == 0 {
            break;
        }
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        let path = std::path::PathBuf::from(line);
        if !path.is_dir() {
            println!("    '{line}' isn't a valid directory — skipped.");
            continue;
        }
        roots.push(path);
    }
    roots
}

/// Prints a set of scored results, calling out a clear #1 as "Best match"
/// when it meaningfully outscores #2, and printing a flat list otherwise.
fn print_ranked<'a, T>(items: &'a [T], score_of: impl Fn(&'a T) -> f64, label: impl Fn(&'a T) -> String) {
    const DOMINANCE_RATIO: f64 = 1.15;

    if items.is_empty() {
        return;
    }

    let clear_winner = items.len() == 1 || score_of(&items[0]) >= score_of(&items[1]) * DOMINANCE_RATIO;

    if clear_winner {
        println!("  Best match:");
        println!("    {}", label(&items[0]));
        if items.len() > 1 {
            println!("  Other potential matches:");
            for item in &items[1..] {
                println!("    {}", label(item));
            }
        }
    } else {
        println!("  Results:");
        for item in items {
            println!("    {}", label(item));
        }
    }
}

fn main() {
    let index_path = "file_indexer_index.bin";

    // Roots: command-line args take priority (and get saved as the new
    // config). Otherwise fall back to a saved config, or prompt
    // interactively if neither exists.
    let cli_roots: Vec<std::path::PathBuf> = env::args().skip(1).map(std::path::PathBuf::from).collect();

    let roots = if !cli_roots.is_empty() {
        save_roots(&cli_roots);
        cli_roots
    } else {
        let saved = load_roots();
        if saved.is_empty() {
            let prompted = prompt_for_roots();
            if prompted.is_empty() {
                eprintln!("No folders selected — nothing to index. Exiting.");
                return;
            }
            save_roots(&prompted);
            prompted
        } else {
            println!("Using saved folders:");
            for r in &saved {
                println!("  {}", r.display());
            }
            saved
        }
    };

    let mut index = if std::path::Path::new(index_path).exists() {
        println!("Loading existing index from {index_path}...");
        FilenameIndex::load(index_path).expect("failed to load index")
    } else {
        println!("No saved index found — building (first run is the slow one)...");
        let idx = FilenameIndex::build_from_roots(&roots);
        idx.save(index_path).expect("failed to save index");
        idx
    };
    println!("Index ready: {} files.\n", index.len());

    println!("Loading embedding model (first run downloads it, may take a bit)...");
    let mut embedder = Embedder::new().expect("failed to load embedding model");

    let batch_size = index.benchmark_batch_size(&mut embedder, &[1, 2, 4, 8, 16, 32, 64], 128);

    println!("Building embeddings for files that don't have one yet...");
    let embedded_count = match index.build_embeddings(&mut embedder, std::path::Path::new(index_path), batch_size) {
        Ok(count) => count,
        Err(e) => {
            eprintln!("Embedding build hit an error and stopped early: {e}");
            eprintln!("Continuing with whatever embeddings completed before the error.");
            index.iter().filter(|e| e.has_embedding()).count()
        }
    };
    println!("Embeddings ready for {embedded_count} files.\n");
    
    let index = Arc::new(RwLock::new(index));

    // --- Watcher: keeps the index live while the CLI runs ---
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |res| { let _ = tx.send(res); }).expect("failed to create watcher");
    for r in &roots {
        if let Err(e) = watcher.watch(r, RecursiveMode::Recursive) {
            eprintln!("  warning: couldn't watch {}: {e}", r.display());
        }
    }

    let watched_index = Arc::clone(&index);
    std::thread::spawn(move || {
        for res in rx {
            let Ok(event) = res else { continue };
            let mut idx = watched_index.write().unwrap();
            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {
                    for path in &event.paths {
                        idx.upsert_path(path);
                    }
                }
                EventKind::Remove(_) => {
                    for path in &event.paths {
                        idx.remove_path(path);
                    }
                }
                _ => {}
            }
        }
    });

    // --- Interactive query loop ---
    println!("Type a query, 'save' to persist, or 'quit' to exit.");
    let stdin = io::stdin();
    loop {
        print!("> ");
        io::stdout().flush().unwrap();
        let mut line = String::new();
        if stdin.read_line(&mut line).unwrap() == 0 {
            break;
        }
        let query = line.trim();
        match query {
            "" => continue,
            "quit" | "exit" => break,
            "save" => {
                index.read().unwrap().save(index_path).unwrap();
                println!("Saved.");
                continue;
            }
            _ => {}
        }

        if let Some(new_folder) = query.strip_prefix("addfolder:") {
            let path = std::path::PathBuf::from(new_folder.trim());
            if !path.is_dir() {
                println!("'{new_folder}' isn't a valid directory.");
                continue;
            }
            {
                let mut idx = index.write().unwrap();
                idx.add_root(&path);
            }
            if let Err(e) = watcher.watch(&path, RecursiveMode::Recursive) {
                eprintln!("  warning: couldn't watch new folder: {e}");
            }
            let mut all_roots = load_roots();
            all_roots.push(path);
            save_roots(&all_roots);
            println!("Folder added and now being watched.");
            continue;
        }

        let idx = index.read().unwrap();

        if let Some(term) = query.strip_prefix("info:") {
            let matches = idx.search(term);
            if matches.is_empty() {
                println!("No filename match for '{term}'.");
            } else {
                for entry in matches.iter().take(5) {
                    println!("{}", entry.path.display());
                    println!("  has_content: {}", entry.has_content());
                    println!("  has_embedding: {}", entry.has_embedding());
                    println!("  content_source: {:?}", entry.content_source);
                }
            }
            continue;
        }

        if let Some(rest) = query.strip_prefix("why:") {
            if let Some((name_filter, q)) = rest.split_once('|') {
                match idx.debug_semantic_score(&mut embedder, name_filter.trim(), q.trim()) {
                    Ok(hits) if hits.is_empty() => println!("No files match '{}'.", name_filter.trim()),
                    Ok(hits) => {
                        for (entry, raw_score) in hits {
                            println!(
                                "  raw_cosine={:.4}  has_content={}  {}",
                                raw_score,
                                entry.has_content(),
                                entry.path.display()
                            );
                        }
                    }
                    Err(e) => println!("Error: {e}"),
                }
            } else {
                println!("Usage: why:<filename fragment>|<query>");
            }
            continue;
        }

        if let Some(rest) = query.strip_prefix("breakdown:") {
            if let Some((name_filter, q)) = rest.split_once('|') {
                for (name, title, body, semantic) in idx.debug_fusion_breakdown(&mut embedder, name_filter.trim(), q.trim()) {
                    println!("  {name}");
                    println!("    title_raw={:?}  body_raw={:?}  semantic_raw={:?}", title, body, semantic);
                }
            } else {
                println!("Usage: breakdown:<filename fragment>|<query>");
            }
            continue;
        }

        if let Some(term) = query.strip_prefix("meaning:") {
            match idx.search_semantic(&mut embedder, term, 10) {
                Ok(hits) if hits.is_empty() => println!("No semantic matches."),
                Ok(hits) => {
                    for (entry, score) in hits {
                        println!("  [{:.4}] {}", score, entry.path.display());
                    }
                }
                Err(e) => println!("Semantic search failed: {e}"),
            }
            continue;
        }

        if let Some(term) = query.strip_prefix("body:") {
            let hits = idx.search_content_ranked(term);
            if hits.is_empty() {
                println!("No content matches for '{term}'.");
            } else {
                for (entry, score) in hits.iter().take(20) {
                    println!("  [{:.3}] {}", score, entry.path.display());
                }
            }
            continue;
        }

        // Default: fused title + body + semantic search
        let results = idx.search_fused(&mut embedder, query);
        if results.is_empty() {
            println!("No matches.");
        } else {
            const RELEVANCE_RATIO: f64 = 0.35;
            const HARD_CAP: usize = 20;

            let top_score = results[0].score;
            let threshold = top_score * RELEVANCE_RATIO;
            let shown: Vec<_> = results.iter().take_while(|r| r.score >= threshold).take(HARD_CAP).collect();

            print_ranked(
                &shown,
                |r| r.score,
                |r| {
                    let fields: Vec<&str> = r
                        .matched_fields
                        .iter()
                        .map(|f| match f {
                            file_indexer::MatchField::Title => "title",
                            file_indexer::MatchField::Body => "body",
                            file_indexer::MatchField::Semantic => "semantic",
                        })
                        .collect();
                    format!("[{:.4}] ({}) {}", r.score, fields.join("+"), r.entry.path.display())
                },
            );

            let hidden = results.len() - shown.len();
            if hidden > 0 {
                println!(
                    "  ...{hidden} more below threshold (showing top {} of {})",
                    shown.len(),
                    results.len()
                );
            }

            // Interactive narrowing: offered whenever there's a real
            // number of results to sift through, regardless of whether
            // #1 already looks confident — narrowing is a separate,
            // always-available tool, not a fallback for uncertainty.
            if shown.len() > 5 {
                let entries_only: Vec<&file_indexer::FileEntry> = shown.iter().map(|r| r.entry).collect();
                let breakdown = FilenameIndex::extension_breakdown(&entries_only);

                println!("\n  {} results shown — narrow by file type? Options:", shown.len());
                for (i, (ext, count)) in breakdown.iter().take(6).enumerate() {
                    println!("    {}. .{ext} ({count})", i + 1);
                }
                println!("    r. recently modified only (last 30 days)");
                println!("    (Enter to skip)");
                print!("  > ");
                io::stdout().flush().unwrap();

                let mut choice = String::new();
                io::stdin().read_line(&mut choice).unwrap();
                let choice = choice.trim();

                if let Ok(n) = choice.parse::<usize>() {
                    if n >= 1 && n <= breakdown.len().min(6) {
                        let (target_ext, _) = &breakdown[n - 1];
                        println!("\n  Filtered to .{target_ext}:");
                        let filtered: Vec<_> = shown
                            .iter()
                            .filter(|r| r.entry.extension().as_deref() == Some(target_ext.as_str()))
                            .collect();
                        print_ranked(&filtered, |r| r.score, |r| r.entry.path.display().to_string());
                    }
                } else if choice.eq_ignore_ascii_case("r") {
                    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 24 * 3600);
                    println!("\n  Filtered to last 30 days:");
                    for r in shown.iter().filter(|r| r.entry.modified.map(|m| m >= cutoff).unwrap_or(false)) {
                        println!("    {}", r.entry.path.display());
                    }
                }
            }
        }
    }

    index.read().unwrap().save(index_path).unwrap();
    println!("Index saved. Bye.");
}