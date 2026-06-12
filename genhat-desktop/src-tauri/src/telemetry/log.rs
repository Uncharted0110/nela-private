use log::{Level, LevelFilter, Metadata, Record, SetLoggerError};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Custom thread-safe ring-buffered logger.
///
/// Logs to both standard output and a rolling local file in the app cache directory,
/// automatically rotating to `.log.1` when it exceeds the 50MB limit to enforce the memory budget.
pub struct TelemetryLogger {
    file_path: PathBuf,
    file: Mutex<File>,
    max_size: u64,
}

impl TelemetryLogger {
    /// Initialize the logger as the global logger.
    pub fn init(app_cache_dir: &Path) -> Result<(), SetLoggerError> {
        let file_path = app_cache_dir.join("nela_telemetry.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .expect("Failed to open telemetry log file");

        let logger = Box::new(Self {
            file_path,
            file: Mutex::new(file),
            max_size: 50 * 1024 * 1024, // 50 MB limit (revamp.md §11)
        });

        log::set_boxed_logger(logger)?;
        log::set_max_level(LevelFilter::Info);
        Ok(())
    }
}

impl log::Log for TelemetryLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= Level::Info
    }

    fn log(&self, record: &Record) {
        if self.enabled(record.metadata()) {
            let log_line = format!(
                "{} [{}] {} - {}\n",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                record.level(),
                record.target(),
                record.args()
            );

            // Print to standard console
            print!("{}", log_line);

            // Append to rolling file
            if let Ok(mut file) = self.file.lock() {
                if let Ok(meta) = file.metadata() {
                    if meta.len() >= self.max_size {
                        // Drop handle to release file lock before renaming
                        drop(file);

                        // Evict / rotate log files
                        let backup_path = self.file_path.with_extension("log.1");
                        std::fs::rename(&self.file_path, &backup_path).ok();

                        if let Ok(new_file) = OpenOptions::new()
                            .create(true)
                            .write(true)
                            .truncate(true)
                            .open(&self.file_path)
                        {
                            if let Ok(mut lock) = self.file.lock() {
                                *lock = new_file;
                                lock.write_all(log_line.as_bytes()).ok();
                            }
                        }
                        return;
                    }
                }
                file.write_all(log_line.as_bytes()).ok();
            }
        }
    }

    fn flush(&self) {
        if let Ok(mut file) = self.file.lock() {
            file.flush().ok();
        }
    }
}
