//! On-disk filename search when the SQLite index has not caught up yet.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use walkdir::WalkDir;

use crate::indexer::db::Candidate;
use crate::indexer::paths::{collect_index_roots, is_blacklisted, is_path_under, normalize_index_path};
use crate::indexer::query::SearchHints;

fn filename_matches_doc_types(filename: &str, doc_types: &[String]) -> bool {
    let hay = filename.to_lowercase();
    doc_types.iter().any(|dt| match dt.as_str() {
        "resume" => hay.contains("resume") || hay.contains("résumé") || hay.contains("resumé"),
        "cv" => hay.contains("cv") || hay.contains("curriculum"),
        "cover" => hay.contains("cover") && hay.contains("letter"),
        other => hay.contains(other),
    })
}

fn filename_matches_terms(filename: &str, terms: &[String]) -> bool {
    if terms.is_empty() {
        return true;
    }
    let hay = filename.to_lowercase();
    terms.iter().any(|t| hay.contains(t.as_str()))
}

/// Walk scoped user folders and return files whose names match the query hints.
pub fn find_on_disk(home_dir: &Path, workspace_paths: &[PathBuf], hints: &SearchHints, limit: usize) -> Vec<Candidate> {
    let roots = collect_index_roots(home_dir, workspace_paths);
    let mut matches: Vec<Candidate> = Vec::new();

    for root in roots {
        if matches.len() >= limit {
            break;
        }

        let walk = WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !is_blacklisted(e.path()));

        for entry in walk.flatten() {
            if matches.len() >= limit {
                break;
            }
            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            let path_str = normalize_index_path(path);
            let filename = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            if let Some(ref abs) = hints.absolute_path {
                if path_str != *abs {
                    continue;
                }
            } else {
                if !hints.doc_type_tokens.is_empty()
                    && !filename_matches_doc_types(&filename, &hints.doc_type_tokens)
                {
                    continue;
                }
                if !filename_matches_terms(&filename, &hints.terms)
                    && hints.doc_type_tokens.is_empty()
                    && hints.filename_literal.is_none()
                {
                    continue;
                }
                if let Some(ref literal) = hints.filename_literal {
                    if filename.to_lowercase() != *literal {
                        continue;
                    }
                }
            }

            let metadata = match fs::metadata(path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            matches.push(Candidate {
                path: path_str,
                filename,
                is_dir: false,
                size: metadata.len() as i64,
                mtime,
                location: crate::indexer::crawler::parent_location(path, 2),
                snippet: String::new(),
            });
        }
    }

    if hints.wants_latest {
        matches.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    }

    matches.truncate(limit);
    matches
}

/// True when `path` exists on disk and lies under an allowed index root.
pub fn is_allowed_existing_path(home_dir: &Path, workspace_paths: &[PathBuf], path_key: &str) -> bool {
    if !Path::new(path_key).exists() {
        return false;
    }
    let roots = collect_index_roots(home_dir, workspace_paths);
    let path = Path::new(path_key);
    roots.iter().any(|root| is_path_under(path, root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn finds_resume_by_filename_on_disk() {
        let base = std::env::temp_dir().join("nela_disk_search_test");
        let docs = base.join("Documents");
        let resumes = docs.join("resumes");
        fs::create_dir_all(&resumes).unwrap();
        let file = resumes.join("amogh_latest_resume.pdf");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "fake pdf").unwrap();

        let hints = crate::indexer::query::parse_search_hints("latest resume");
        let found = find_on_disk(&base, &[], &hints, 5);
        assert!(found.iter().any(|c| c.filename.contains("resume")));

        fs::remove_dir_all(&base).ok();
    }
}
