pub mod assembler;
pub mod pipeline;

pub use assembler::assemble_markdown;
pub use pipeline::{
    discover_files, index_one_deferred, max_file_bytes_for_ext, parse_pass2_with_timeout,
    parse_with_timeout, query_kb, run_incremental_sync, run_pipeline, sync_paths,
    BackgroundIndexStatus, IndexingProgress, PipelineReport, PipelineTiming, ProgressCallback,
    EXCLUDED_DIR_NAMES, MAX_BLOCKS_PER_DOC, MAX_FILE_BYTES, PARSE_TIMEOUT_PASS1,
    PARSE_TIMEOUT_PASS2,
};
