//! Structured table extraction from web pages (Wikipedia wikitables, markdown tables).

use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedWebTable {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub source_url: String,
    pub source_title: String,
}

/// Map common factual list queries to authoritative Wikipedia list pages.
pub fn resolve_wikipedia_list_title(query: &str) -> Option<&'static str> {
    let lower = query.to_lowercase();

    if lower.contains("2024")
        && (lower.contains("grossing") || lower.contains("box office"))
        && (lower.contains("film") || lower.contains("movie"))
    {
        return Some("List_of_highest-grossing_films_of_2024");
    }
    if lower.contains("2025")
        && (lower.contains("grossing") || lower.contains("box office"))
        && (lower.contains("film") || lower.contains("movie"))
    {
        return Some("List_of_highest-grossing_films_of_2025");
    }
    if (lower.contains("highest grossing")
        || lower.contains("highest-grossing")
        || lower.contains("top grossing")
        || (lower.contains("box office") && (lower.contains("film") || lower.contains("movie")))
        || (lower.contains("grossing") && (lower.contains("film") || lower.contains("movie"))))
        && (lower.contains("all time")
            || lower.contains("all-time")
            || lower.contains("worldwide")
            || lower.contains("top")
            || lower.contains("highest"))
    {
        return Some("List_of_highest-grossing_films");
    }

    None
}

pub fn extract_row_limit(query: &str) -> Option<usize> {
    let lower = query.to_lowercase();
    for pattern in ["top ", "best ", "first "] {
        if let Some(idx) = lower.find(pattern) {
            let rest = &lower[idx + pattern.len()..];
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = num.parse::<usize>() {
                if n > 0 && n <= 500 {
                    return Some(n);
                }
            }
        }
    }
    None
}

fn normalize_row(width: usize, row: Vec<String>) -> Vec<String> {
    let mut padded = row;
    while padded.len() < width {
        padded.push(String::new());
    }
    padded.truncate(width);
    padded
}

/// Strip Wikipedia footnotes, reference markers, and stray prefix codes from a cell.
fn clean_cell(text: &str) -> String {
    let mut s = text.trim().to_string();

    // Remove bracketed references: [# 86], [53], etc.
    while let Some(start) = s.find('[') {
        if let Some(rel_end) = s[start..].find(']') {
            let end = start + rel_end + 1;
            s = format!("{}{}", &s[..start], &s[end..]);
        } else {
            break;
        }
    }

    // Remove trailing footnote codes glued to values (e.g. "...000R", "IN", "RK").
    while s.len() > 1 {
        let last = s.chars().last().unwrap();
        if last.is_ascii_alphabetic() && !last.is_ascii_digit() {
            let prev = s.chars().nth(s.len() - 2);
            if prev.map(|c| c.is_ascii_digit() || c == ')').unwrap_or(false) {
                s.pop();
                continue;
            }
        }
        break;
    }

    // Strip short alphabetic prefixes before dollar amounts (e.g. "T$2.2B" -> "$2.2B").
    if let Some(idx) = s.find('$') {
        if idx > 0 && idx <= 4 && s[..idx].chars().all(|c| c.is_ascii_alphabetic()) {
            s = s[idx..].to_string();
        }
    }

    s.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn header_cells_lower(row: &[String]) -> Vec<String> {
    row.iter().map(|c| c.to_lowercase()).collect()
}

/// Find the row that looks like column headers (Rank + Title on Wikipedia list pages).
fn find_header_row_index(rows: &[Vec<String>]) -> Option<usize> {
    for (i, row) in rows.iter().enumerate() {
        let lower = header_cells_lower(row);
        let has_rank = lower.iter().any(|h| h == "rank" || h == "#" || h == "no.");
        let has_title = lower.iter().any(|h| h == "title" || h.contains("title"));
        if has_rank && has_title {
            return Some(i);
        }
    }
    None
}

fn is_historical_timeline_table(headers: &[String]) -> bool {
    let lower = header_cells_lower(headers);
    let year_first = lower.first().map(|h| h == "year").unwrap_or(false);
    let has_rank = lower.iter().any(|h| h == "rank" || h == "#");
    year_first && !has_rank
}

fn row_looks_like_silent_era(row: &[String]) -> bool {
    let joined = row
        .iter()
        .map(|c| c.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    joined.contains("birth of a nation")
        || joined.contains("intolerance")
        || joined.contains("1915")
        || joined.contains("1916")
        || joined.contains("1917")
        || joined.contains("1918")
        || joined.contains("1919")
        || joined.contains("1920")
}

fn row_looks_like_modern_blockbuster(row: &[String]) -> bool {
    let joined = row
        .iter()
        .map(|c| c.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    joined.contains("avatar")
        || joined.contains("avengers")
        || joined.contains("titanic")
        || joined.contains("star wars")
        || joined.contains("frozen")
        || joined.contains("jurassic")
}

fn fix_caption_column_misalignment(headers: &mut Vec<String>, rows: &mut Vec<Vec<String>>) {
    if headers.len() < 3 || rows.is_empty() {
        return;
    }

    let h0 = headers[0].to_lowercase();
    let looks_like_caption = !["rank", "#", "year", "title", "peak", "no.", "ref", "references"]
        .contains(&h0.as_str())
        && (h0.contains("film")
            || h0.contains("grossing")
            || h0.contains("series")
            || h0.len() > 16);

    if !looks_like_caption {
        return;
    }

    // Wikipedia puts a section caption in the first header cell, but data rows omit
    // that column — so col0 of each row is actually Rank, not the caption.
    headers.remove(0);
    let width = headers.len();
    for row in rows.iter_mut() {
        *row = normalize_row(width, std::mem::take(row));
    }
}

fn build_table_from_raw_rows(
    raw_rows: Vec<Vec<String>>,
    source_url: &str,
    source_title: &str,
) -> Option<ExtractedWebTable> {
    if raw_rows.len() < 2 {
        return None;
    }

    let header_idx = find_header_row_index(&raw_rows).unwrap_or(0);
    let mut headers: Vec<String> = raw_rows[header_idx]
        .iter()
        .map(|c| clean_cell(c))
        .filter(|s| !s.is_empty())
        .collect();

    if headers.len() < 2 {
        return None;
    }

    let width_before = headers.len();
    let mut rows: Vec<Vec<String>> = raw_rows
        .into_iter()
        .skip(header_idx + 1)
        .map(|r| {
            normalize_row(width_before, r.into_iter().map(|c| clean_cell(&c)).collect())
        })
        .filter(|r| r.iter().any(|c| !c.trim().is_empty()))
        .filter(|r| !r.iter().all(|c| c.chars().all(|ch| ch.is_ascii_digit() || ch.is_whitespace())))
        .collect();

    fix_caption_column_misalignment(&mut headers, &mut rows);

    if rows.len() < 2 {
        return None;
    }

    let width = headers.len();
    let rows: Vec<Vec<String>> = rows
        .into_iter()
        .map(|r| normalize_row(width, r))
        .collect();

    Some(ExtractedWebTable {
        headers: normalize_row(width, headers),
        rows,
        source_url: source_url.to_string(),
        source_title: source_title.to_string(),
    })
}

/// Score how well a table matches the user's query (higher = better).
fn score_table_for_query(table: &ExtractedWebTable, query: &str) -> i32 {
    let q = query.to_lowercase();
    let headers = header_cells_lower(&table.headers);
    let header_text = headers.join(" ");

    let has_rank = headers.iter().any(|h| h == "rank" || h == "#");
    let has_title = headers.iter().any(|h| h.contains("title"));
    let has_gross = headers
        .iter()
        .any(|h| h.contains("gross") || h.contains("box office") || h.contains("revenue"));

    let mut score: i32 = 0;

    if has_rank && has_title && has_gross {
        score += 1000;
    }

    if is_historical_timeline_table(&table.headers) {
        score -= 1200;
    }

    if header_text.contains("budget")
        && (header_text.contains("references") || header_text.contains("ref"))
        && !has_rank
    {
        score -= 600;
    }

    if header_text.contains("adjusted") || header_text.contains("inflation") {
        score -= 400;
    }

    let sample: String = table
        .rows
        .iter()
        .take(3)
        .flat_map(|r| r.iter())
        .map(|s| s.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");

    if q.contains("grossing")
        || q.contains("box office")
        || q.contains("movie")
        || q.contains("film")
    {
        if sample.contains("avatar") || sample.contains("avengers") || sample.contains("titanic") {
            score += 800;
        }
        if table
            .rows
            .first()
            .map(|r| row_looks_like_modern_blockbuster(r))
            .unwrap_or(false)
        {
            score += 600;
        }
        if table
            .rows
            .first()
            .map(|r| row_looks_like_silent_era(r))
            .unwrap_or(false)
        {
            score -= 1500;
        }
    }

    if let Some(limit) = extract_row_limit(query) {
        if table.rows.len() >= limit {
            score += 150;
        }
    }

    // Mild preference for reasonably sized list tables — not the dominant factor.
    score += table.rows.len().min(80) as i32;

    if table.source_url.contains("wikipedia.org") {
        score += 50;
    }

    score
}

/// Parse `table.wikitable` / sortable tables from HTML (Wikipedia list pages).
pub fn extract_html_tables(
    html: &str,
    source_url: &str,
    source_title: &str,
) -> Vec<ExtractedWebTable> {
    let document = Html::parse_document(html);
    let Ok(table_sel) = Selector::parse("table.wikitable, table.sortable") else {
        return Vec::new();
    };
    let Ok(row_sel) = Selector::parse("tr") else {
        return Vec::new();
    };
    let Ok(cell_sel) = Selector::parse("th, td") else {
        return Vec::new();
    };

    let mut tables = Vec::new();

    for table in document.select(&table_sel) {
        let mut raw_rows: Vec<Vec<String>> = Vec::new();
        for tr in table.select(&row_sel) {
            let cells: Vec<String> = tr
                .select(&cell_sel)
                .map(|c| {
                    c.text()
                        .collect::<String>()
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .filter(|s| !s.is_empty())
                .collect();
            if cells.len() >= 2 {
                raw_rows.push(cells);
            }
        }

        if let Some(table) = build_table_from_raw_rows(raw_rows, source_url, source_title) {
            tables.push(table);
        }
    }

    tables
}

/// Parse markdown pipe tables (Jina Reader output).
pub fn extract_markdown_tables(
    text: &str,
    source_url: &str,
    source_title: &str,
) -> Vec<ExtractedWebTable> {
    let lines: Vec<&str> = text.lines().collect();
    let mut tables = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        if !lines[i].contains('|') {
            i += 1;
            continue;
        }

        let start = i;
        while i < lines.len() && lines[i].contains('|') {
            i += 1;
        }

        let block: Vec<&str> = lines[start..i].to_vec();
        if block.len() < 2 {
            continue;
        }

        let mut parsed: Vec<Vec<String>> = block
            .iter()
            .map(|line| {
                line.split('|')
                    .map(|s| s.trim().to_string())
                    .filter(|s: &String| !s.is_empty())
                    .collect()
            })
            .filter(|r: &Vec<String>| !r.is_empty())
            .collect();

        if parsed.len() >= 2
            && parsed[1]
                .iter()
                .all(|c| c.chars().all(|ch| ch == '-' || ch == ':' || ch.is_whitespace()))
        {
            parsed.remove(1);
        }

        if let Some(table) = build_table_from_raw_rows(parsed, source_url, source_title) {
            tables.push(table);
        }
    }

    tables
}

pub fn select_best_table(
    tables: Vec<ExtractedWebTable>,
    query: &str,
    row_limit: Option<usize>,
) -> Option<ExtractedWebTable> {
    let mut best = tables.into_iter().max_by(|a, b| {
        score_table_for_query(a, query).cmp(&score_table_for_query(b, query))
    })?;

    if score_table_for_query(&best, query) < 0 {
        return None;
    }

    if let Some(limit) = row_limit {
        best.rows.truncate(limit);
    }

    if best.rows.is_empty() {
        return None;
    }

    Some(best)
}

pub fn table_to_markdown(table: &ExtractedWebTable) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "Source: {} ({})\n",
        table.source_title, table.source_url
    ));
    out.push('|');
    for h in &table.headers {
        out.push(' ');
        out.push_str(h);
        out.push_str(" |");
    }
    out.push('\n');
    out.push('|');
    for _ in &table.headers {
        out.push_str(" --- |");
    }
    out.push('\n');
    for row in &table.rows {
        out.push('|');
        for cell in row {
            out.push(' ');
            out.push_str(cell);
            out.push_str(" |");
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_highest_grossing_wiki_title() {
        assert_eq!(
            resolve_wikipedia_list_title("top 10 highest grossing movies worldwide"),
            Some("List_of_highest-grossing_films")
        );
    }

    #[test]
    fn parses_markdown_table() {
        let md = "| Rank | Title |\n| --- | --- |\n| 1 | Avatar |\n| 2 | Avengers |\n";
        let tables = extract_markdown_tables(md, "https://example.com", "Example");
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].rows.len(), 2);
        assert_eq!(tables[0].rows[0][1], "Avatar");
    }

    #[test]
    fn prefers_all_time_list_over_historical_timeline() {
        let all_time = ExtractedWebTable {
            headers: vec![
                "Rank".into(),
                "Peak".into(),
                "Title".into(),
                "Worldwide gross".into(),
                "Year".into(),
            ],
            rows: vec![
                vec![
                    "1".into(),
                    "1".into(),
                    "Avatar".into(),
                    "$2,923,710,708".into(),
                    "2009".into(),
                ],
                vec![
                    "2".into(),
                    "1".into(),
                    "Avengers: Endgame".into(),
                    "$2,797,501,328".into(),
                    "2019".into(),
                ],
            ],
            source_url: "https://en.wikipedia.org/wiki/List_of_highest-grossing_films".into(),
            source_title: "List of highest-grossing films".into(),
        };

        let historical = ExtractedWebTable {
            headers: vec![
                "Year".into(),
                "Title".into(),
                "Worldwide gross".into(),
                "Budget".into(),
                "References".into(),
            ],
            rows: (1915..=1930)
                .map(|y| {
                    vec![
                        y.to_string(),
                        "Old Film".into(),
                        "$1,000,000".into(),
                        "$100,000".into(),
                        "[1]".into(),
                    ]
                })
                .collect(),
            source_url: "https://en.wikipedia.org/wiki/List_of_highest-grossing_films".into(),
            source_title: "Timeline".into(),
        };

        let picked = select_best_table(vec![historical, all_time], "top 10 highest grossing movies", Some(10));
        assert!(picked.is_some());
        let picked = picked.unwrap();
        assert_eq!(picked.rows[0][2], "Avatar");
        assert_eq!(picked.headers[0], "Rank");
    }

    #[test]
    fn finds_header_row_with_caption_column() {
        let raw = vec![
            vec![
                "Highest-grossing films".into(),
                "Rank".into(),
                "Peak".into(),
                "Title".into(),
                "Worldwide gross".into(),
                "Year".into(),
            ],
            vec![
                "1".into(),
                "1".into(),
                "Avatar".into(),
                "$2,923,710,708".into(),
                "2009".into(),
            ],
            vec![
                "2".into(),
                "1".into(),
                "Avengers: Endgame".into(),
                "$2,797,501,328".into(),
                "2019".into(),
            ],
        ];
        let table = build_table_from_raw_rows(
            raw,
            "https://en.wikipedia.org/wiki/List_of_highest-grossing_films",
            "Test",
        );
        assert!(table.is_some());
        let table = table.unwrap();
        assert_eq!(table.headers[0], "Rank");
        assert_eq!(table.rows[0][2], "Avatar");
    }
}
