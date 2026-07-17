import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import { MAX_PATCH_SOURCE_CHARS, truncateForPatchEdit } from "../artifactEdit";
import type { GenerationOptions, SendHandlerContext } from "./types";

export async function runHtmlArtifactPatch(
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
  const rawContent = await Api.readFileText(artifactPath);
  const currentContent = truncateForPatchEdit(rawContent, MAX_PATCH_SOURCE_CHARS);

  const systemPrompt = `You are a professional assistant that modifies HTML artifacts (pages and slide decks).
Generate a valid, minimal unified git-style diff (patch) to apply the user's modifications.
Do NOT output anything else — no markdown fences, no explanations. Start with raw unified diff hunk lines ("@@").

Original HTML (may be truncated in the middle for large files):
\`\`\`html
${currentContent}
\`\`\``;

  const userPrompt = `Generate a unified diff patch to: "${text}"`;

  let patchText = "";
  await Api.streamChat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    (chunk) => {
      patchText += chunk;
    },
    () => {},
    async () => {
      updateEditMsg("WritingCode");
      try {
        let cleanPatch = patchText.trim();
        if (cleanPatch.startsWith("```")) {
          const lines = cleanPatch.split("\n");
          if (lines[0].startsWith("```")) lines.shift();
          if (lines[lines.length - 1] === "```") lines.pop();
          cleanPatch = lines.join("\n").trim();
        }

        await Api.applyDiffPatch(artifactPath, cleanPatch);

        import("@tauri-apps/api/event").then(({ emit }) => {
          emit("artifact-patch", { patch: cleanPatch, path: artifactPath });
        });

        ctx.updateSession(sid, { loading: false });
        const filename = artifactPath.split(/[/\\]/).pop();
        updateEditMsg(
          "LivePreview",
          artifactPath,
          `Updated **${filename}** with your changes.`
        );
      } catch (execErr: unknown) {
        const message = execErr instanceof Error ? execErr.message : String(execErr);
        ctx.updateSession(sid, { loading: false });
        updateEditMsg("Error", null, `Failed to apply HTML patch: ${message}`);
      }
    },
    (err) => {
      ctx.updateSession(sid, { loading: false });
      updateEditMsg("Error", null, `Failed to generate HTML patch: ${err}`);
    },
    undefined,
    ctx.selectedModel || undefined,
    ctrl.signal,
    true,
    {
      ...generationOptions,
      maxTokens: 2048,
      temperature: 0.1,
    }
  );
}