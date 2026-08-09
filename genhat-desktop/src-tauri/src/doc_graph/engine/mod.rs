pub mod assembler;
pub mod pipeline;

pub use assembler::assemble_markdown;
pub use pipeline::{
    discover_files, index_one_deferred, parse_pass2_with_timeout, parse_with_timeout, query_kb,
    run_incremental_sync, run_pipeline, BackgroundIndexStatus, IndexingProgress, PipelineReport,
    PipelineTiming, ProgressCallback, EXCLUDED_DIR_NAMES, PARSE_TIMEOUT_PASS1, PARSE_TIMEOUT_PASS2,
};
