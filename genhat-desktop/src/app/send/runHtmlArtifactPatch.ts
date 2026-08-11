import { Api } from "../../api";
import type { PipelineStageKind } from "../../components/ProgressSlate";
import { MAX_PATCH_SOURCE_CHARS, truncateForPatchEdit } from "../artifactEdit";
import { streamChatByMode, willRouteToCloud } from "./cloudOrLocalStream";
import type { GenerationOptions, SendHandlerContext } from "./types";
import { friendlyErrorFromUnknown } from "../friendlyError";

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
  const useCloud = willRouteToCloud();

  let patchText = "";
  try {
    await new Promise<void>((resolve, reject) => {
      streamChatByMode({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        intent: "artifact_plan",
        containsFileContext: false,
        modelId: ctx.selectedModel || undefined,
        signal: ctrl.signal,
        disableThinking: true,
        generationOptions: {
          ...generationOptions,
          maxTokens: 16_384,
          temperature: 0.1,
        },
        onChunk: (chunk) => {
          patchText += chunk;
        },
        onThinking: () => {},
        onFinish: () => resolve(),
        onError: (err) => reject(err),
      });
    });
  } catch (err: unknown) {
    ctx.updateSession(sid, { loading: false });
    updateEditMsg("Error", null, friendlyErrorFromUnknown(err));
    return;
  }

  updateEditMsg("WritingCode");
  try {
    let cleanPatch = patchText.trim();
    if (cleanPatch.startsWith("```")) {
      const lines = cleanPatch.split("\n");
      if (lines[0]?.startsWith("```")) lines.shift();
      if (lines[lines.length - 1]?.trim() === "```") lines.pop();
      cleanPatch = lines.join("\n").trim();
    }

    if (!cleanPatch) {
      throw new Error(
        useCloud
          ? "The model returned an empty patch."
          : "The local model returned an empty patch. Switch to Cloud mode or load a local model, then try again."
      );
    }

    const newPath = await Api.applyDiffPatch(artifactPath, cleanPatch);

    import("@tauri-apps/api/event").then(({ emit }) => {
      emit("artifact-patch", { patch: cleanPatch, path: newPath });
    });

    ctx.updateSession(sid, {
      loading: false,
      artifactPath: newPath,
      artifactStage: "LivePreview",
      artifactPanelOpen: true,
      artifactStreamActive: true,
      streamingArtifactHtml: undefined,
      streamingArtifactCsv: undefined,
    });
    const filename = newPath.split(/[/\\]/).pop();
    const sourceName = artifactPath.split(/[/\\]/).pop();
    updateEditMsg(
      "LivePreview",
      newPath,
      `Saved an updated copy as **${filename}** (original **${sourceName}** unchanged).`
    );
  } catch (execErr: unknown) {
    const message =
      execErr instanceof Error ? execErr.message : String(execErr);
    ctx.updateSession(sid, { loading: false });
    updateEditMsg("Error", null, friendlyErrorFromUnknown(message));
  }
}
