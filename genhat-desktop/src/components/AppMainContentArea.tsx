import type {
  ChatMode,
  ChatSession,
  IngestionStatus,
  MindMapGraph,
} from "../types";
import PodcastTab from "./PodcastTab";
import ChatWindow from "./ChatWindow";
import MindMapOverlay from "./MindMapOverlay";
import PdfViewer from "./PdfViewer";
import DocumentViewer from "./DocumentViewer";
import PlaygroundMode from "./PlaygroundMode";
import ArtifactSidePanel from "./ArtifactSidePanel";
import { useSessionStore } from "../stores/sessionStore";
import { handlePreviewArtifactEdit } from "../app/sessionSendActions";


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
  generalElapsedTime?: number;
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
  generalElapsedTime = 0,
  generalGenerationTime = null,
}: AppMainContentAreaProps) {
  const updateSession = useSessionStore((s) => s.updateSession);
  const hasArtifactBody = Boolean(
    activeSession?.streamingArtifactHtml || activeSession?.streamingArtifactCsv
  );
  const showArtifactPanel = Boolean(
    activeSession &&
      activeSession.artifactPanelOpen === true &&
      (activeSession.artifactStreamActive ||
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
        <PlaygroundMode onNavigateBack={onExitPlayground} />
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
            generalElapsedTime={generalElapsedTime}
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
            html={activeSession.streamingArtifactHtml}
            csv={activeSession.streamingArtifactCsv}
            savedPath={activeSession.artifactPath ?? null}
            streamActive={
              Boolean(activeSession.artifactStreamActive) &&
              activeSession.artifactStage !== "LivePreview" &&
              !activeSession.artifactPath
            }
            onClose={closeArtifactPanel}
            onPreviewEdit={(text, path, onStatus) =>
              handlePreviewArtifactEdit(text, path, onStatus)
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
        <PdfViewer
          pdfData={pdfViewerData.data}
          title={pdfViewerData.title}
          onClose={onClosePdfViewer}
        />
      )}

      {docViewerFile && (
        <DocumentViewer
          key={docViewerFile.filePath}
          filePath={docViewerFile.filePath}
          title={docViewerFile.title}
          onClose={onCloseDocViewer}
        />
      )}
    </>
  );
}
