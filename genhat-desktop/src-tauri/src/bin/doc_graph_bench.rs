//! Release benchmark: recursively index a directory (default: $HOME).
//!
//! Usage:
//!   cargo run --release --bin doc-graph-bench -- --root "$HOME" --max-files 500
//!   cargo run --release --bin doc-graph-bench -- --root "$HOME" --full   # uncapped, dangerous
//!
//! Defaults to a safe --max-files=500 when indexing $HOME without --full,
//! to avoid OOM on large home directories.
//!
//! After Pass 1, deferred files are retried via Pass 2 (5s timeout) and the
//! bench waits for `pass2-done` before printing the final summary.

use app_lib::doc_graph::budget::IndexerBudget;
use app_lib::doc_graph::engine::{query_kb, run_pipeline, PipelineReport};
use app_lib::doc_graph::state::DocGraphEngine;
use clap::Parser;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

const SAFE_HOME_MAX_FILES: usize = 200;

#[derive(Parser, Debug)]
#[command(name = "doc-graph-bench", about = "Benchmark structural KG indexing")]
struct Args {
    /// Root directory to index recursively (default: $HOME).
    #[arg(long)]
    root: Option<PathBuf>,

    /// Cap on number of files (recommended). Default 500 when root is $HOME.
    #[arg(long)]
    max_files: Option<usize>,

    /// Allow uncapped home indexing (can use many GB of RAM — not recommended).
    #[arg(long, default_value_t = false)]
    full: bool,

    /// Output directory for bench KB + JSON report.
    #[arg(long)]
    out_dir: Option<PathBuf>,

    /// Skip Pass 2 background retry (Pass 1 only).
    #[arg(long, default_value_t = false)]
    skip_pass2: bool,
}

fn main() {
    let args = Args::parse();
    let root = args.root.unwrap_or_else(|| {
        dirs_fallback_home().expect("--root not set and HOME unavailable")
    });
    let out_dir = args
        .out_dir
        .unwrap_or_else(|| std::env::temp_dir().join("nela_doc_graph_bench"));

    let home = dirs_fallback_home();
    let indexing_home = home
        .as_ref()
        .map(|h| root.canonicalize().unwrap_or(root.clone()) == *h)
        .unwrap_or(false);

    let max_files = if let Some(m) = args.max_files {
        Some(m)
    } else if indexing_home && !args.full {
        eprintln!(
            "NOTE: defaulting to --max-files={SAFE_HOME_MAX_FILES} for $HOME (use --full to override)."
        );
        Some(SAFE_HOME_MAX_FILES)
    } else if args.full && indexing_home {
        eprintln!(
            "WARNING: --full on $HOME can consume many GB of RAM and freeze the machine."
        );
        None
    } else {
        args.max_files
    };

    let budget = IndexerBudget::detect();
    println!("doc-graph-bench");
    println!("  root: {}", root.display());
    println!("  out:  {}", out_dir.display());
    println!(
        "  budget: {} (pass1={} pass2={} embed={})",
        budget.progress_label(),
        budget.pass1_threads,
        budget.pass2_threads,
        budget.embed_threads
    );
    match max_files {
        Some(m) => println!("  max-files: {m}"),
        None => println!("  max-files: (uncapped)"),
    }
    println!(
        "  pass2: {}",
        if args.skip_pass2 {
            "skipped"
        } else {
            "enabled (wait for completion)"
        }
    );

    let _ = std::fs::remove_dir_all(&out_dir);
    std::fs::create_dir_all(&out_dir).expect("create out_dir");

    let engine = Arc::new(DocGraphEngine::open(out_dir.clone()).expect("open DocGraphEngine"));
    println!("Loading FastEmbed model (used at query time only)…");
    let t_model = Instant::now();
    let embedder = engine.embedder().expect("init embedder");
    println!(
        "  model ready in {}ms (dim={})",
        t_model.elapsed().as_millis(),
        embedder.dim()
    );

    let on_progress = Arc::new(|p: app_lib::doc_graph::engine::IndexingProgress| {
        if p.files_parsed % 50 == 0
            || matches!(
                p.phase.as_str(),
                "done" | "flush" | "discovery" | "pass2" | "pass2-done"
            )
            || p.message.contains("Batch")
            || p.message.contains("Pass")
        {
            eprintln!(
                "[{}] discovered={} parsed={} failed={} chunks={} — {}",
                p.phase,
                p.files_discovered,
                p.files_parsed,
                p.files_failed,
                p.chunks_indexed,
                p.message
            );
        }
    });

    // --- Pass 1 ---
    let report: PipelineReport = run_pipeline(
        &root,
        &engine.data_dir,
        &engine.kb,
        &engine.index,
        &embedder,
        max_files,
        true,
        Some(on_progress.clone()),
    )
    .expect("Pass 1 pipeline failed");

    let pass1_files_per_sec = if report.timing.total_ms > 0 {
        (report.files_parsed as f64) / (report.timing.total_ms as f64 / 1000.0)
    } else {
        0.0
    };

    println!("\n=== Pass 1 Summary (search available) ===");
    println!("files discovered : {}", report.files_discovered);
    println!("files parsed     : {}", report.files_parsed);
    println!("files failed     : {}", report.files_failed);
    println!("files deferred   : {}", report.files_deferred);
    println!("chunks indexed   : {}", report.chunks_indexed);
    println!("graph nodes/edges: {} / {}", report.nodes, report.edges);
    println!("timing total     : {} ms", report.timing.total_ms);
    println!("throughput       : {:.2} files/sec", pass1_files_per_sec);

    // --- Pass 2 ---
    let mut pass2_ms = 0u128;
    let mut pass2_status = engine.background_status();
    if !args.skip_pass2 && !report.deferred_files.is_empty() {
        let deferred: Vec<PathBuf> = report
            .deferred_files
            .iter()
            .map(PathBuf::from)
            .collect();
        let t_pass2 = Instant::now();
        engine.spawn_pass2(deferred, Some(on_progress));
        engine.join_pass2();
        pass2_ms = t_pass2.elapsed().as_millis();
        pass2_status = engine.background_status();

        println!("\n=== Pass 2 Summary ===");
        println!("deferred total   : {}", pass2_status.total);
        println!("recovered        : {}", pass2_status.completed);
        println!("still failed     : {}", pass2_status.failed);
        println!("timing pass2     : {} ms", pass2_ms);
    } else if report.deferred_files.is_empty() {
        println!("\n=== Pass 2 Summary ===");
        println!("(nothing deferred)");
    } else {
        println!("\n=== Pass 2 Summary ===");
        println!("(skipped via --skip-pass2; {} files remain deferred)", report.files_deferred);
    }

    let final_stats = engine.stats();
    let wall_ms = report.timing.total_ms + pass2_ms;
    let recovered = pass2_status.completed;
    let total_parsed = report.files_parsed + recovered;
    let total_failed = report.files_failed + pass2_status.failed;
    let wall_files_per_sec = if wall_ms > 0 {
        (total_parsed as f64) / (wall_ms as f64 / 1000.0)
    } else {
        0.0
    };

    println!("\n=== Final Summary ===");
    println!("files discovered : {}", report.files_discovered);
    println!("files parsed     : {} (pass1 {} + pass2 {})", total_parsed, report.files_parsed, recovered);
    println!("files failed     : {}", total_failed);
    println!("chunks indexed   : {} (pass1)", report.chunks_indexed);
    println!("graph nodes/edges: {} / {}", final_stats.nodes, final_stats.edges);
    println!("vectors          : {}", final_stats.vectors);
    println!("timing discovery : {} ms", report.timing.discovery_ms);
    println!("timing parse     : {} ms", report.timing.parse_ms);
    println!("timing assemble  : {} ms", report.timing.assemble_ms);
    println!("timing embed     : {} ms", report.timing.embed_ms);
    println!("timing flush     : {} ms", report.timing.flush_ms);
    println!("timing pass1     : {} ms", report.timing.total_ms);
    println!("timing pass2     : {} ms", pass2_ms);
    println!("timing wall      : {} ms", wall_ms);
    println!("throughput pass1 : {:.2} files/sec", pass1_files_per_sec);
    println!("throughput wall  : {:.2} files/sec", wall_files_per_sec);
    if !report.errors.is_empty() {
        println!("sample pass1 errors ({}):", report.errors.len());
        for e in report.errors.iter().take(10) {
            println!("  - {e}");
        }
    }

    let json_path = out_dir.join("doc_graph_bench.json");
    let json = serde_json::json!({
        "report": report,
        "pass2": {
            "ms": pass2_ms,
            "total": pass2_status.total,
            "completed": pass2_status.completed,
            "failed": pass2_status.failed,
            "skipped": args.skip_pass2,
        },
        "finalStats": {
            "nodes": final_stats.nodes,
            "edges": final_stats.edges,
            "vectors": final_stats.vectors,
            "filesParsed": total_parsed,
            "filesFailed": total_failed,
        },
        "filesPerSecPass1": pass1_files_per_sec,
        "filesPerSecWall": wall_files_per_sec,
        "wallMs": wall_ms,
    });
    std::fs::write(&json_path, serde_json::to_string_pretty(&json).unwrap())
        .expect("write json");
    println!("\nWrote {}", json_path.display());

    if total_parsed > 0 {
        let kb = engine.kb.read();
        match query_kb(
            "revenue growth metrics",
            &kb,
            &engine.index,
            &embedder,
            Some(15),
        ) {
            Ok(md) => {
                println!("\n=== Sample query preview ===");
                for line in md.lines().take(20) {
                    println!("{line}");
                }
            }
            Err(e) => eprintln!("sample query failed: {e}"),
        }
    }
}

fn dirs_fallback_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}
