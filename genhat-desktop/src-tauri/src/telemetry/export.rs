use regex::Regex;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

/// Export the telemetry log files to the user's Downloads directory as a sanitized ZIP archive.
///
/// Scrubs absolute paths, system usernames, emails, and IP addresses to maintain zero-egress privacy (revamp.md §11).
pub fn export_logs(app_cache_dir: &Path, downloads_dir: &Path) -> Result<PathBuf, String> {
    let log_path = app_cache_dir.join("nela_telemetry.log");
    let log_backup_path = app_cache_dir.join("nela_telemetry.log.1");

    let mut raw_logs = String::new();

    // 1. Read existing log backups if present
    if log_backup_path.exists() {
        if let Ok(mut f) = File::open(&log_backup_path) {
            f.read_to_string(&mut raw_logs).ok();
        }
    }

    // 2. Read active log file
    if log_path.exists() {
        if let Ok(mut f) = File::open(&log_path) {
            f.read_to_string(&mut raw_logs).ok();
        }
    }

    if raw_logs.is_empty() {
        return Err("No diagnostic logs found to export".to_string());
    }

    // 3. Perform sanitization
    let sanitized_logs = sanitize_log_text(&raw_logs);

    // 4. Create ZIP archive in Downloads
    let zip_path = downloads_dir.join("nela_diagnostics.zip");
    let file = File::create(&zip_path)
        .map_err(|e| format!("Failed to create diagnostic file: {e}"))?;

    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(6));

    zip.start_file("nela_telemetry_sanitized.log", options)
        .map_err(|e| format!("Failed to create zip file entry: {e}"))?;
    
    zip.write_all(sanitized_logs.as_bytes())
        .map_err(|e| format!("Failed to write contents to zip: {e}"))?;

    zip.finish()
        .map_err(|e| format!("Failed to finalize zip archive: {e}"))?;

    Ok(zip_path)
}

/// Scrub absolute paths, usernames, emails, and IPs from log text.
fn sanitize_log_text(text: &str) -> String {
    let mut sanitized = text.to_string();

    // Redact Emails
    if let Ok(re_email) = Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}") {
        sanitized = re_email.replace_all(&sanitized, "[EMAIL_REDACTED]").to_string();
    }

    // Redact IPv4
    if let Ok(re_ip) = Regex::new(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b") {
        sanitized = re_ip.replace_all(&sanitized, "[IP_REDACTED]").to_string();
    }

    // Redact absolute home directory paths containing local usernames
    let username = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "user".to_string());

    let user_pattern_mac_linux = format!("/home/{}", username);
    let user_pattern_mac = format!("/Users/{}", username);
    let user_pattern_win = format!("C:\\Users\\{}", username);

    sanitized = sanitized.replace(&user_pattern_mac_linux, "/home/user");
    sanitized = sanitized.replace(&user_pattern_mac, "/Users/user");
    sanitized = sanitized.replace(&user_pattern_win, "C:\\Users\\user");
    sanitized = sanitized.replace(&username, "user");

    sanitized
}
