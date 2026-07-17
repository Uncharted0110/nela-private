import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import {
  buildSpreadsheetEditSample,
  editedOutputName,
  MAX_EDIT_SPREADSHEET_ROWS,
} from "../artifactEdit";
import { parseArtifactPlanJson } from "../artifactPlanJson";
import { normalizeSpreadsheetPlan } from "../spreadsheetPlan";
import { spreadsheetFromParsed } from "../htmlChartData";
import { parseCSV } from "./csvParse";
import { repairNestedKeys } from "./repairNestedKeys";
import type { GenerationOptions, SendHandlerContext } from "./types";

export async function runSpreadsheetArtifactEdit(
  text: string,
  artifactPath: string,
  sid: string,
  ctx: SendHandlerContext,
  ctrl: AbortController,
  generationOptions: GenerationOptions,
  updateEditMsg: (
    stage: PipelineStageKind,
    path?: string | null,
    contentOverride?: string
  ) => void
): Promise<void> {
  updateEditMsg("SearchingDisk");

  let headers: string[] = [];
  let rows: string[][] = [];

  if (artifactPath.endsWith(".csv") || artifactPath.endsWith(".tsv")) {
    const fileContent = await Api.readFileText(artifactPath);
    const parsed = parseCSV(fileContent);
    headers = parsed.headers;
    rows = parsed.rows.slice(0, MAX_EDIT_SPREADSHEET_ROWS);
  } else {
    const parsed = await Api.parseSpreadsheetData(
      artifactPath,
      MAX_EDIT_SPREADSHEET_ROWS
    );
    const sheet = spreadsheetFromParsed(parsed.rows);
    if (sheet) {
      headers = sheet.headers;
      rows = sheet.rows;
    }
  }

  if (!headers.length) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg("Error", null, "Could not read spreadsheet data from the file.");
    return;
  }

  updateEditMsg("CrunchingMetrics");

  const grammar = await Api.getSchemaGrammar("spreadsheet_synthesis");
  const sampleContext = buildSpreadsheetEditSample(headers, rows);
  const outputName = editedOutputName(artifactPath);

  const systemPrompt = `You are a professional assistant that EDITS existing spreadsheets via a JSON plan.
Return ONLY a JSON object — no markdown fences or explanations.

EDIT MODE RULES:
- Preserve all existing data unless the user asks to remove or replace it.
- Prefer spreadsheet ops (SUM_COLUMN, ADD_COLUMN, FILTER_ROWS, SORT_ASC, SORT_DESC, etc.) over rewriting data.
- Use WRITE_DATA only when the user requests wholesale data replacement or cell edits that ops cannot express.
- When using WRITE_DATA, include the COMPLETE updated dataset (headers + all rows).
- Do NOT invent columns that are not in the source unless the user asks for them.

Schema: {"ops": [{"op": "SUM_COLUMN" | "AVERAGE_BY_GROUP" | "PIVOT" | "SORT_DESC" | "SORT_ASC" | "FILTER_ROWS" | "COUNT_BY_GROUP" | "ADD_COLUMN" | "RENAME_SHEET" | "WRITE_DATA", ...}]}`;

  const userPrompt = `Existing spreadsheet (file: ${artifactPath.split(/[/\\]/).pop()}):
${sampleContext}

User edit request: "${text}"

Produce a plan that applies the requested changes to this spreadsheet.`;

  let planJson = "";
  await Api.streamChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    (chunk) => {
      planJson += chunk;
    },
    () => {},
    async () => {
      updateEditMsg("WritingCode");
      try {
        let planObj = parseArtifactPlanJson(planJson, {
          userPrompt: text,
          schemaId: "spreadsheet_synthesis",
        });
        planObj = repairNestedKeys(planObj);
        planObj.headers = headers;
        planObj.source_rows = rows;
        planObj.output_name = outputName;

        const hasWriteData = Array.isArray(planObj.ops)
          && planObj.ops.some(
            (op: { op?: string }) => String(op?.op ?? "").toUpperCase() === "WRITE_DATA"
          );
        if (hasWriteData) {
          const writeOp = (planObj.ops as Array<{ op?: string; headers?: string[]; rows?: string[][] }>).find(
            (op) => String(op?.op ?? "").toUpperCase() === "WRITE_DATA"
          );
          if (writeOp?.headers?.length) {
            planObj.headers = writeOp.headers;
          }
          if (writeOp?.rows?.length) {
            planObj.source_rows = writeOp.rows;
          }
        }

        const result = await Api.generateSpreadsheet(
          normalizeSpreadsheetPlan(planObj, {
            prompt: text,
            hasSourceData: true,
          })
        );
        ctx.updateSession(sid, { loading: false });
        const filename = result.path.split(/[/\\]/).pop();
        updateEditMsg(
          "LivePreview",
          result.path,
          `Updated spreadsheet: **${filename}**\nPath: \`${result.path}\``
        );
      } catch (execErr: unknown) {
        const message = execErr instanceof Error ? execErr.message : String(execErr);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg("Error", null, `Failed to apply spreadsheet edits: ${message}`);
      }
    },
    (err) => {
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, `Failed to generate spreadsheet edit plan: ${err}`);
    },
    undefined,
    ctx.selectedModel || undefined,
    ctrl.signal,
    true,
    {
      ...generationOptions,
      maxTokens: 4096,
      temperature: 0.1,
      grammar,
    }
  );
}