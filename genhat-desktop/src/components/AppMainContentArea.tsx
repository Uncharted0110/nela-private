import type {
  ChatMode,
  ChatSession,
  IngestionStatus,
  MindMapGraph,
} from "../types";
import PodcastTab from "./PodcastTab";
import ChatWindow from "./ChatWindow";
import MindMapOverlay from "./MindMapOverlay";
import ArtifactSidePanel from "./ArtifactSidePanel";
import { lazy, Suspense } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useArtifactStreamStore } from "../stores/artifactStreamStore";
import { handlePreviewArtifactEdit } from "../app/sessionSendActions";

const PdfViewer = lazy(() => import("./PdfViewer"));
const DocumentViewer = lazy(() => import("./DocumentViewer"));
const PlaygroundMode = lazy(() => import("./PlaygroundMode"));


interface ModeOption {
  mode: ChatMode;
  label: string;
}

interface AppMainContentAreaProps {
  chatMode: ChatMode;
  ragDocs: IngestionStatus[];
  ragEnabled: boolean;
  modeOptions: ModeOption[];
  onSelectMode: (mode: ChatMode) => void;
  onToggleRagEnabled: (enabled: boolean) => void;
  webEnabled?: boolean;
  onToggleWebEnabled?: (enabled: boolean) => void;
  fileIndexerEnabled?: boolean;
  onToggleFileIndexerEnabled?: (enabled: boolean) => void;
  activeSession: ChatSession | null;
  activeWorkspace: { id: string } | null;
  onSend: (text: string) => void;
  onRetry?: (assistantMsgIndex: number) => void;
  onCancel: () => void;
  placeholder: string;
  ragIngesting: boolean;
  enrichmentStatus: string | null;
  onIngestFile: () => void;
  onIngestDir: () => void;
  onAttachDirectDocuments: () => void;
  directDocumentPaths: string[];
  onRemoveDirectDocument: (path: string) => void;
  onClearDirectDocuments: () => void;
  onSelectVisionImage: () => void;
  visionImagePath: string | null;
  visionImagePreview: string | null;
  onClearVisionImage: () => void;
  docPanelOpen: boolean;
  onToggleDocPanel: () => void;
  modeSwitchNotice: string | null;
  onSaveAudioToSidebar: (msgIdx: number) => void;
  streamingThinking: string;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
  activeMindmapOverlay: {
    sessionId: string;
    mindmapId: string | null;
    isGenerating?: boolean;
    query?: string;
  } | null;
  activeMindmapGraph: MindMapGraph | null;
  onCloseMindmapOverlay: () => void;
  pdfLoading: boolean;
  pdfViewerData: {
    data: string;
    title: string;
  } | null;
  onClosePdfViewer: () => void;
  docViewerFile: {
    filePath: string;
    title: string;
  } | null;
  onCloseDocViewer: () => void;
  onExitPlayground?: () => void;
  generalGenerating?: boolean;
  generalGenerationTime?: number | null;
}

export default function AppMainContentArea({
  chatMode,
  ragDocs,
  ragEnabled,
  modeOptions,
  onSelectMode,
  onToggleRagEnabled,
  webEnabled,
  onToggleWebEnabled,
  fileIndexerEnabled,
  onToggleFileIndexerEnabled,
  activeSession,
  activeWorkspace,
  onSend,
  onRetry,
  onCancel,
  placeholder,
  ragIngesting,
  enrichmentStatus,
  onIngestFile,
  onIngestDir,
  onAttachDirectDocuments,
  directDocumentPaths,
  onRemoveDirectDocument,
  onClearDirectDocuments,
  onSelectVisionImage,
  visionImagePath,
  visionImagePreview,
  onClearVisionImage,
  docPanelOpen,
  onToggleDocPanel,
  modeSwitchNotice,
  onSaveAudioToSidebar,
  streamingThinking,
  thinkingEnabled,
  onToggleThinking,
  activeMindmapOverlay,
  activeMindmapGraph,
  onCloseMindmapOverlay,
  pdfLoading,
  pdfViewerData,
  onClosePdfViewer,
  docViewerFile,
  onCloseDocViewer,
  onExitPlayground,
  generalGenerating = false,
  generalGenerationTime = null,
}: AppMainContentAreaProps) {
  const updateSession = useSessionStore((s) => s.updateSession);
  const liveStreamHtml = useArtifactStreamStore((s) =>
    s.active && s.type === "text/html" ? s.html : ""
  );
  const liveStreamCsv = useArtifactStreamStore((s) =>
    s.active && s.type === "text/csv" ? s.csv : ""
  );
  const liveStreamActive = useArtifactStreamStore((s) => s.active);
  const panelHtml =
    liveStreamHtml || activeSession?.streamingArtifactHtml || "";
  const panelCsv =
    liveStreamCsv || activeSession?.streamingArtifactCsv || "";
  const hasArtifactBody = Boolean(panelHtml || panelCsv);
  const showArtifactPanel = Boolean(
    activeSession &&
      activeSession.artifactPanelOpen === true &&
      (activeSession.artifactStreamActive ||
        liveStreamActive ||
        hasArtifactBody ||
        (activeSession.artifactStage === "LivePreview" &&
          activeSession.artifactPath))
  );

  const closeArtifactPanel = () => {
    if (!activeSession) return;
    // Keep streamed HTML/CSV so reopening the chip restores the preview.
    updateSession(activeSession.id, {
      artifactPanelOpen: false,
    });
  };

  return (
    <>
      {chatMode === "playground" ? (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center text-txt-muted text-sm">
              Loading playground…
            </div>
          }
        >
          <PlaygroundMode onNavigateBack={onExitPlayground} />
        </Suspense>
      ) : chatMode === "podcast" ? (
        <PodcastTab
          hasDocuments={ragDocs.length > 0}
          modeOptions={modeOptions}
          currentMode={chatMode}
          onSelectMode={onSelectMode}
        />
      ) : !activeSession ? (
        <div className="flex-1 flex items-center justify-center text-txt-muted text-sm">
          {activeWorkspace
            ? "Open a chat from the left sidebar or create a new chat."
            : "No workspace selected. Create a workspace from the left sidebar."}
        </div>
      ) : (
        <div className="flex-1 flex min-w-0 h-full relative overflow-hidden">
          <div className="flex-1 flex min-w-0 h-full relative overflow-hidden">
          <ChatWindow
            key={activeSession.id}
            messages={activeSession.messages}
            streamingContent={activeSession.streamingContent}
            isLoading={activeSession.loading}
            onSend={onSend}
            onRetry={onRetry}
            onCancel={onCancel}
            cancelled={activeSession.cancelled}
            audioSrc={activeSession.audioOutput}
            audioOutputs={activeSession.audioOutputs}
            placeholder={placeholder}
            mediaAssets={activeSession.mediaAssets}
            ragDocs={ragDocs}
            ragIngesting={ragIngesting}
            enrichmentStatus={enrichmentStatus}
            onIngestFile={onIngestFile}
            onIngestDir={onIngestDir}
            onAttachDirectDocuments={onAttachDirectDocuments}
            directDocumentPaths={directDocumentPaths}
            onRemoveDirectDocument={onRemoveDirectDocument}
            onClearDirectDocuments={onClearDirectDocuments}
            onSelectVisionImage={onSelectVisionImage}
            visionImagePath={visionImagePath}
            visionImagePreview={visionImagePreview}
            onClearVisionImage={onClearVisionImage}
            onToggleDocPanel={onToggleDocPanel}
            chatMode={chatMode}
            ragEnabled={ragEnabled}
            onToggleRagEnabled={onToggleRagEnabled}
            webEnabled={webEnabled}
            onToggleWebEnabled={onToggleWebEnabled}
            fileIndexerEnabled={fileIndexerEnabled}
            onToggleFileIndexerEnabled={onToggleFileIndexerEnabled}
            showRagControls={chatMode === "text" || chatMode === "mindmap"}
            docPanelOpen={docPanelOpen}
            modeOptions={modeOptions}
            currentMode={chatMode}
            onSelectMode={onSelectMode}
            modeSwitchNotice={modeSwitchNotice}
            saveAudioToSidebar={onSaveAudioToSidebar}
            session={activeSession}
            streamingThinking={streamingThinking}
            thinkingEnabled={thinkingEnabled}
            onToggleThinking={onToggleThinking}
            generalGenerating={generalGenerating}
            generalGenerationTime={generalGenerationTime}
          />
          </div>
          <ArtifactSidePanel
            key={`${activeSession.id}-artifact-panel`}
            active={showArtifactPanel}
            title={activeSession.streamingArtifactTitle}
            type={
              activeSession.streamingArtifactType ??
              (activeSession.artifactPath &&
              /\.xlsx?$/i.test(activeSession.artifactPath)
                ? "text/csv"
                : "text/html")
            }
            html={panelHtml || undefined}
            csv={panelCsv || undefined}
            savedPath={activeSession.artifactPath ?? null}
            streamActive={
              (Boolean(activeSession.artifactStreamActive) || liveStreamActive) &&
              activeSession.artifactStage !== "LivePreview" &&
              !activeSession.artifactPath
            }
            onClose={closeArtifactPanel}
            onPreviewEdit={(text, path, onStatus, editContext) =>
              handlePreviewArtifactEdit(text, path, onStatus, editContext)
            }
          />
        </div>
      )}

      {activeMindmapOverlay && (activeMindmapGraph || activeMindmapOverlay.isGenerating) && (
        <MindMapOverlay
          graph={activeMindmapGraph}
          isGenerating={!!activeMindmapOverlay.isGenerating}
          query={activeMindmapOverlay.query}
          onClose={onCloseMindmapOverlay}
        />
      )}

      {pdfLoading && (
        <div className="absolute inset-0 z-[55] bg-void-900/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3 text-txt-muted text-sm">
          <div className="pdf-spinner" />
          <span>Loading PDF...</span>
        </div>
      )}

      {pdfViewerData && (
        <Suspense fallback={null}>
          <PdfViewer
            pdfData={pdfViewerData.data}
            title={pdfViewerData.title}
            onClose={onClosePdfViewer}
          />
        </Suspense>
      )}

      {docViewerFile && (
        <Suspense fallback={null}>
          <DocumentViewer
            key={docViewerFile.filePath}
            filePath={docViewerFile.filePath}
            title={docViewerFile.title}
            onClose={onCloseDocViewer}
          />
        </Suspense>
      )}
    </>
  );
}
