import type { FileRecord } from "../types";
import { extractLocalFilePath, hasLocalFilePathReference } from "./ambientFileContent";

/** Minimum relevance score to inject a file into chat context. */
export const AMBIENT_MIN_SCORE = 0.55;

/** Scores within this delta of the top hit are treated as ambiguous ties. */
export const AMBIENT_SCORE_TIE_DELTA = 0.04;

/** Max files to inject when multiple hits tie at the top. */
export const AMBIENT_MAX_INJECT = 2;

/**
 * Filter ambient search hits for chat injection.
 * Drops low-confidence and ungraded results; prefers a single best match.
 */
export function selectAmbientResultsForInjection(results: FileRecord[]): FileRecord[] {
  const viable = results.filter(
    (r) => !r.is_dir && typeof r.score === "number" && r.score >= AMBIENT_MIN_SCORE
  );
  if (viable.length === 0) {
    return [];
  }

  viable.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const bestScore = viable[0].score ?? 0;
  const tied = viable.filter(
    (r) => (r.score ?? 0) >= bestScore - AMBIENT_SCORE_TIE_DELTA
  );
  return tied.slice(0, AMBIENT_MAX_INJECT);
}

/** Whether the user is asking about a specific local document type (resume, CV, …). */
export function hasDocumentFileIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const docNoun =
    /\b(resume|résumé|resumé|curriculum\s+vitae|\bcv\b|cover\s+letter|transcript|invoice|payslip|paystub)\b/i.test(
      lower
    );
  const fileCue =
    /\b(latest|newest|recent|my|system|files?|computer|find|get|open|read|show|looking\s+at|locate|search)\b/i.test(
      lower
    );
  return docNoun && fileCue;
}

/**
 * Decide whether to run ambient file search for this message.
 * Tighter than before: requires explicit file intent, not generic imperatives.
 */
export function shouldRunAmbientFileSearch(
  text: string,
  options?: { forceFileSearch?: boolean }
): boolean {
  if (options?.forceFileSearch) {
    return true;
  }
  return (
    hasSearchKeywords(text) ||
    hasDocumentFileIntent(text) ||
    hasLocalFilePathReference(text)
  );
}

/** Whether the user used explicit file-search phrasing (miss → "file not found"). */
export function hasSearchKeywords(text: string): boolean {
  const explicitVerb =
    /\b(search\w*|find\w*|locat\w+|look\s*up|retriev\w*|open\s+(the\s+)?file|(get|read|show|open)\s+(me\s+)?(the\s+)?(file|document|doc|pdf|sheet|spreadsheet|presentation|slides?))\b/i;
  const locality =
    /\b(my\s+(system|files?|computer|laptop|pc|disk|drive|machine|documents?|downloads?|desktop)|on\s+my\s+(system|computer|laptop|pc|machine|disk|drive)|from\s+my\s+(system|files?|computer|laptop|pc|disk|drive)|in\s+my\s+files?)\b/i;
  const filename =
    /\b[\w-]+\.(pdf|docx?|pptx?|xlsx?|xls|csv|tsv|txt|md|json|rtf|odt|ods)\b/i;
  return explicitVerb.test(text) || locality.test(text) || filename.test(text);
}

/** Extract a focused search string from a conversational file request. */
export function extractAmbientSearchQuery(text: string): string {
  const directPath = extractLocalFilePath(text);
  if (directPath) {
    const base = directPath.split(/[/\\]/).pop() ?? directPath;
    return base.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim() || directPath;
  }

  const recencyDoc = text.match(
    /\b(?:latest|newest|most\s+recent|recent)\s+(?:[\w-]+\s+){0,2}(?:resume|résumé|resumé|cv|cover\s+letter|transcript)\b/i
  );
  if (recencyDoc) {
    return recencyDoc[0].replace(/[,/#!$%^&*;:{}=`~()?]/g, "").trim();
  }

  const namedDoc = text.match(
    /\b(?:[\w-]+\s+){0,4}(?:resumes?|résumé|resumé|cv|cover\s+letter|transcript)\b/i
  );
  if (namedDoc) {
    return namedDoc[0].replace(/[,/#!$%^&*;:{}=`~()?]/g, "").trim();
  }

  const lowerText = text.toLowerCase();
  let startIdx = 0;
  let endIdx = text.length;

  const prefixes = [
    "can you tell me about",
    "tell me about",
    "give me an overview of",
    "give me a summary of",
    "give me",
    "do you have any info on",
    "do you have",
    "what is in",
    "show me the contents of",
    "show me",
    "search for",
    "look for",
    "look up",
    "find",
    "locate",
    "where is",
    "by looking at",
    "looking at",
  ];
  for (const prefix of prefixes) {
    if (lowerText.includes(prefix)) {
      const idx = lowerText.indexOf(prefix);
      if (idx >= 0) {
        startIdx = Math.max(startIdx, idx + prefix.length);
      }
    }
  }

  const remaining = text.substring(startIdx).trim();
  const lowerRemaining = remaining.toLowerCase();

  const suffixes = [
    "from my system files",
    "from my files",
    "on my system",
    "in my system",
    "in my files",
    "from system files",
    "system files",
    "my files",
    "on my computer",
    "in the system",
  ];
  for (const suffix of suffixes) {
    if (lowerRemaining.endsWith(suffix)) {
      endIdx = startIdx + lowerRemaining.lastIndexOf(suffix);
      break;
    }
  }

  let cleaned = text.substring(startIdx, endIdx).trim();
  const lowerCleaned = cleaned.toLowerCase();

  const stopPhrases = [
    "and make",
    "and create",
    "and generate",
    "and build",
    "into a",
    "to generate",
    "to create",
    "as a",
    "by looking at",
  ];
  for (const sw of stopPhrases) {
    const swIdx = lowerCleaned.indexOf(sw);
    if (swIdx !== -1) {
      cleaned = cleaned.substring(0, swIdx).trim();
      break;
    }
  }

  cleaned = cleaned.replace(/[,/#!$%^&*;:{}=`~()?]/g, "").trim();

  // Preserve document-type phrases when stripping left the query empty.
  if (!cleaned) {
    const docMatch = text.match(
      /\b(latest|newest|recent)?\s*(resume|résumé|resumé|cv|cover\s+letter|transcript)\b/i
    );
    if (docMatch) {
      cleaned = docMatch[0].trim();
    }
  }

  return cleaned || text;
}
