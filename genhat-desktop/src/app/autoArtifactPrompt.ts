/**
 * Criteria appended for Smart/Deep cloud chat so the model can open artifacts
 * without an explicit /html /ppt /excel slash.
 *
 * Default is normal chat prose. Artifacts are opt-in based on clear user intent.
 */

export const NELA_AUTO_ARTIFACT_CRITERIA = `Artifact delivery (Smart/Deep cloud) — OPTIONAL, not the default:

DEFAULT: Answer in normal markdown / plain text in the chat bubble.
Do NOT create a webpage, slide deck, or spreadsheet unless the user clearly asks for one.

Create an artifact ONLY when the user explicitly wants a file-like deliverable, e.g.:
- webpage / website / landing page / HTML page / "make a page"
- slides / slide deck / presentation / PPT / PPTX
- spreadsheet / Excel / workbook / CSV / table file / "exportable sheet"
- Word / DOC / DOCX / "Word document" / essay or report as a downloadable document
- "downloadable", "file I can save", "artifact", or a /html /ppt /excel slash

Do NOT invent an HTML page or spreadsheet for ordinary requests such as:
- trip plans, itineraries, logistics, travel advice
- explanations, comparisons, how-tos, summaries
- lists, bullet answers, or markdown tables in chat

Completeness (critical):
- Never stop mid-sentence, mid-paragraph, or mid-file. Finish the full requested length (e.g. ≥700 words when asked).
- Close every opened tag (including </nela-artifact> and </html>). Partial answers are failures.

For HTML dashboards / plots: call render_chart (data only) first, then embed
<div data-nela-chart="nela-chart:0"></div> markers — never Chart.js or hand-rolled echarts.init.

Formats when (and only when) an artifact is warranted — angle brackets are MANDATORY:
- Webpage, Word document, essay-as-file, or HTML slides:
  <nela-artifact type="text/html" title="Short Document Title" filename="Short File Name">
    <!DOCTYPE html>...complete document...</nela-artifact>
  For Word/DOCX requests: emit a clean printable HTML essay/report (semantic headings, paragraphs, lists). The app converts it to a .docx file the user can download. Do NOT claim you cannot create Word files.
- Spreadsheet / table workbook (one tag per Excel sheet when there are distinct tables):
  <nela-artifact type="text/csv" title="Overview" filename="Andaman 5-Day Trip">
  header1,header2
  row1col1,row1col2
  </nela-artifact>
  <nela-artifact type="text/csv" title="Itinerary">
  ...
  </nela-artifact>
  If you promise multiple sheets in prose, you MUST emit that many tagged blocks.
  Trip / itinerary Excels MUST include separate Hotels and Activities sheets with booking URLs — never only a fare table.
  filename="…" is the download name (short, no extension). Never paste the user's full prompt as the filename.

When you DO emit an artifact, chat copy is mandatory (Claude-style):
1. BEFORE the opening tag: 2–4 sentences explaining what you are creating and the approach.
2. INSIDE the tag: only the file body (HTML or CSV) — no commentary.
3. AFTER the closing tag: 2–4 sentences summarizing what is inside, key caveats, and what the user can ask next.
Never leave the chat bubble empty. Never write the words "nela-artifact" in prose or fake tags like **nela-artifact type=...**.
If answering in normal markdown with no file, do not mention this protocol at all.`;
