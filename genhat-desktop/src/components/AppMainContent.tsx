import type { ChatSession } from "../types";
import { MODE_CONFIG } from "../app/constants";
import {
  switchWorkspaceById,
  createNewWorkspace,
  deleteWorkspaceById,
  renameWorkspaceById,
} from "../app/workspaceBridge";
import {
  handleDownloadModel,
  handleCancelDownload,
  handleUninstall,
  handleIntelligenceModeSelect,
  handleModelChangeFromPicker,
  handleChooseSpecificModel,
  handleBackToIntelligenceTiers,
  handleApplyRuntimeParams,
  getActiveRuntimeParamTarget,
  intelligenceDisplayMode,
} from "../app/modelActions";
import {
  selectImage,
  attachDirectDocuments,
  ingestFile,
  ingestDir,
} from "../app/ragUiActions";
import {
  handleCancel,
  handleSend,
  handleModeSwitch,
  getPlaceholder,
} from "../app/sessionSendActions";
import { useAdvancedMode } from "../hooks/useAdvancedMode";
import { useNetworkActivity } from "../hooks/useNetworkActivity";
import { useSessionStore } from "../stores/sessionStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useChatModeStore } from "../stores/chatModeStore";
import { useModelStore } from "../stores/modelStore";
import { useUIStore } from "../stores/uiStore";
import { useDownloadStore } from "../stores/downloadStore";
import { useCloudStore } from "../stores/cloudStore";
import { useDocGraphStore } from "../stores/docGraphStore";
import ChatTabBar from "./ChatTabBar";
import AppMainTopBar from "./AppMainTopBar";
import AppMainModeControls from "./AppMainModeControls";
import AppMainContentArea from "./AppMainContentArea";

interface AppMainContentProps {
  networkActive?: boolean;
}

export default function AppMainContent({ networkActive: networkActiveProp }: AppMainContentProps = {}) {
  // ── Hooks ──────────────────────────────────────────────────────────────────
  const networkActivityHook = useNetworkActivity();
  const networkActive = networkActiveProp ?? networkActivityHook;
  const { advanced } = useAdvancedMode();

  // ── Store subscriptions ───────────────────────────────────────────────────
  const sessions = useSessionStore(s => s.sessions);
  const openSessionIds = useSessionStore(s => s.openSessionIds);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const streamingThinking = useSessionStore(s => s.streamingThinking);
  const updateSession = useSessionStore(s => s.updateSession);
  const addNewSession = useSessionStore(s => s.addNewSession);
  const closeViewerTab = useSessionStore(s => s.closeViewerTab);
  const reorderViewerTabs = useSessionStore(s => s.reorderViewerTabs);
  const setActiveSessionId = useSessionStore(s => s.setActiveSessionId);

  const workspaces = useWorkspaceStore(s => s.workspaces);
  const activeWorkspace = useWorkspaceStore(s => s.activeWorkspace);
  const workspaceBusy = useWorkspaceStore(s => s.workspaceBusy);

  const chatMode = useChatModeStore(s => s.chatMode);
  const thinkingEnabled = useChatModeStore(s => s.thinkingEnabled);
  const setThinkingEnabled = useChatModeStore(s => s.setThinkingEnabled);
  const ragEnabled = useChatModeStore(s => s.ragEnabled);
  const setRagEnabled = useChatModeStore(s => s.setRagEnabled);
  const ragDocs = useChatModeStore(s => s.ragDocs);
  const ragIngesting = useChatModeStore(s => s.ragIngesting);
  const enrichmentStatus = useChatModeStore(s => s.enrichmentStatus);
  const webEnabled = useChatModeStore(s => s.webEnabled);
  const setWebEnabled = useChatModeStore(s => s.setWebEnabled);
  const fileIndexerEnabled = useChatModeStore(s => s.fileIndexerEnabled);
  const setFileIndexerEnabled = useChatModeStore(s => s.setFileIndexerEnabled);
  const imagePath = useChatModeStore(s => s.imagePath);
  const imagePreview = useChatModeStore(s => s.imagePreview);
  const directDocumentPaths = useChatModeStore(s => s.directDocumentPaths);
  const removeDirectDocument = useChatModeStore(s => s.removeDirectDocument);
  const clearDirectDocuments = useChatModeStore(s => s.clearDirectDocuments);
  const mindmapsBySession = useChatModeStore(s => s.mindmapsBySession);
  const activeMindmapOverlay = useChatModeStore(s => s.activeMindmapOverlay);
  const setActiveMindmapOverlay = useChatModeStore(s => s.setActiveMindmapOverlay);
  const clearImage = useChatModeStore(s => s.clearImage);
  const generalElapsedTime = useChatModeStore(s => s.generalElapsedTime);
  const generalGenerationTime = useChatModeStore(s => s.generalGenerationTime);
  const generalGenerating = useChatModeStore(s => s.generalGenerating);

  const models = useModelStore(s => s.models);
  const selectedModel = useModelStore(s => s.selectedModel);
  const intelligenceMode = useModelStore(s => s.intelligenceMode);
  const useSpecificModelPicker = useModelStore(s => s.useSpecificModelPicker);
  const modelLoadingStatus = useModelStore(s => s.modelLoadingStatus);
  const modelSwitching = useModelStore(s => s.modelSwitching);
  const ttsEngines = useModelStore(s => s.ttsEngines);
  const selectedTtsEngine = useModelStore(s => s.selectedTtsEngine);
  const setSelectedTtsEngine = useModelStore(s => s.setSelectedTtsEngine);
  const visionModels = useModelStore(s => s.visionModels);
  const selectedVisionModel = useModelStore(s => s.selectedVisionModel);
  const setSelectedVisionModel = useModelStore(s => s.setSelectedVisionModel);

  const preferredMode = useCloudStore(s => s.preferredMode);
  // Cloud: show the stored tier (OpenRouter picks the model). Private: derive from loaded GGUF.
  const displayIntelligenceMode =
    preferredMode !== "local" ? intelligenceMode : intelligenceDisplayMode();

  const setHfModalPreset = useUIStore(s => s.setHfModalPreset);
  const setHfModalOpen = useUIStore(s => s.setHfModalOpen);
  const docPanelOpen = useUIStore(s => s.docPanelOpen);
  const setDocPanelOpen = useUIStore(s => s.setDocPanelOpen);
  const confirmAction = useUIStore(s => s.confirmAction);
  const modeSwitchNotice = useUIStore(s => s.modeSwitchNotice);
  const pdfViewerData = useUIStore(s => s.pdfViewerData);
  const pdfLoading = useUIStore(s => s.pdfLoading);
  const docViewerFile = useUIStore(s => s.docViewerFile);
  const closePdfViewer = useUIStore(s => s.closePdfViewer);
  const closeDocViewer = useUIStore(s => s.closeDocViewer);

  const downloads = useDownloadStore(s => s.downloads);

  // ── Derived state ─────────────────────────────────────────────────────────
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const effectiveRagEnabled = advanced ? ragEnabled : true;
  const effectiveThinkingEnabled = advanced ? thinkingEnabled : false;

  const openViewerSessions = openSessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is ChatSession => !!s);

  const activeMindmapGraph = activeMindmapOverlay
    ? (mindmapsBySession[activeMindmapOverlay.sessionId] ?? []).find(
        (map) => map.id === activeMindmapOverlay.mindmapId
      ) ?? null
    : null;

  const currentModeConfig = MODE_CONFIG.find((m) => m.mode === chatMode)!;
  const modeOptions = MODE_CONFIG.map(({ mode, label }) => ({ mode, label }));

  // ── Action handlers ───────────────────────────────────────────────────────
  const handleAddModel = () => {
    setHfModalPreset({ folder: "LLM", profile: "llm" });
    setHfModalOpen(true);
  };

  const handleAddVisionModel = () => {
    setHfModalPreset({ folder: "LiquidAI-VLM", profile: "vlm" });
    setHfModalOpen(true);
  };

  const handleRagToggle = (enabled: boolean) => {
    setRagEnabled(enabled);
    if (enabled) {
      clearDirectDocuments();
    }
  };

  const handleWebToggle = (enabled: boolean) => {
    setWebEnabled(enabled);
  };

  const handleFileIndexerToggle = (enabled: boolean) => {
    setFileIndexerEnabled(enabled);
    const { stats, openIndex } = useDocGraphStore.getState();
    if (enabled && (stats?.nodes ?? 0) === 0) {
      openIndex();
    }
  };

  const handleExitPlayground = () => {
    handleModeSwitch("text");
  };

  // Handler to save audio to sidebar (set audioSaved=true)
  const handleSaveAudioToSidebar = (msgIdx: number) => {
    if (!activeSession) return;
    updateSession(activeSession.id, (prev) => ({
      messages: prev.messages.map((m, i) => i === msgIdx ? { ...m, audioSaved: true } : m)
    }));
  };
  return (
    <main className="flex-1 flex flex-col bg-void-900 min-w-0 relative">
      {chatMode !== "podcast" && (
        <ChatTabBar
          sessions={openViewerSessions}
          activeSessionId={activeSessionId}
          onSelectSession={setActiveSessionId}
          onNewSession={() => addNewSession(!!activeWorkspace)}
          onCloseSession={closeViewerTab}
          onReorderSessions={reorderViewerTabs}
        />
      )}

      <AppMainTopBar
        currentModeConfig={currentModeConfig}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        onSelectWorkspace={(id) => void switchWorkspaceById(id)}
        onCreateWorkspace={() => void createNewWorkspace()}
        onDeleteWorkspace={(id) => void deleteWorkspaceById(id)}
        onRenameWorkspace={renameWorkspaceById}
        workspaceBusy={workspaceBusy}
        modelLoadingStatus={modelLoadingStatus}
        networkActive={networkActive}
        modeControls={(
          <AppMainModeControls
            chatMode={chatMode}
            models={models}
            selectedModel={selectedModel}
            modelSwitching={modelSwitching.active}
            modelSwitchingLabel={modelSwitching.targetLabel}
            onModelChange={(path) => void handleModelChangeFromPicker(path)}
            onAddModel={handleAddModel}
            onDownloadModel={handleDownloadModel}
            onCancelDownload={handleCancelDownload}
            onUninstallModel={handleUninstall}
            onConfirmAction={confirmAction}
            downloads={downloads}
            ttsEngines={ttsEngines}
            selectedTtsEngine={selectedTtsEngine}
            onSelectTtsEngine={setSelectedTtsEngine}
            visionModels={visionModels}
            selectedVisionModel={selectedVisionModel}
            onSelectVisionModel={setSelectedVisionModel}
            onAddVisionModel={handleAddVisionModel}
            activeRuntimeParamTarget={getActiveRuntimeParamTarget()}
            onApplyRuntimeParams={handleApplyRuntimeParams}
            intelligenceMode={displayIntelligenceMode}
            useSpecificModelPicker={useSpecificModelPicker}
            onSelectIntelligenceMode={(mode) => void handleIntelligenceModeSelect(mode)}
            onChooseSpecificModel={handleChooseSpecificModel}
            onBackToIntelligenceTiers={() => void handleBackToIntelligenceTiers()}
          />
        )}
      />

      <AppMainContentArea
        chatMode={chatMode}
        ragDocs={ragDocs}
        ragEnabled={effectiveRagEnabled}
        modeOptions={modeOptions}
        onSelectMode={handleModeSwitch}
        onToggleRagEnabled={handleRagToggle}
        webEnabled={webEnabled}
        onToggleWebEnabled={handleWebToggle}
        fileIndexerEnabled={fileIndexerEnabled}
        onToggleFileIndexerEnabled={handleFileIndexerToggle}
        activeSession={activeSession}
        activeWorkspace={activeWorkspace}
        onSend={(text) => void handleSend(text)}
        onCancel={handleCancel}
        placeholder={getPlaceholder()}
        ragIngesting={ragIngesting}
        enrichmentStatus={enrichmentStatus}
        onIngestFile={() => void ingestFile()}
        onIngestDir={() => void ingestDir()}
        onAttachDirectDocuments={() => void attachDirectDocuments()}
        directDocumentPaths={directDocumentPaths}
        onRemoveDirectDocument={removeDirectDocument}
        onClearDirectDocuments={clearDirectDocuments}
        onSelectVisionImage={() => void selectImage()}
        visionImagePath={imagePath}
        visionImagePreview={imagePreview}
        onClearVisionImage={clearImage}
        docPanelOpen={docPanelOpen}
        onToggleDocPanel={() => setDocPanelOpen(!docPanelOpen)}
        modeSwitchNotice={modeSwitchNotice}
        onSaveAudioToSidebar={handleSaveAudioToSidebar}
        streamingThinking={streamingThinking}
        thinkingEnabled={effectiveThinkingEnabled}
        onToggleThinking={() => setThinkingEnabled(!thinkingEnabled)}
        activeMindmapOverlay={activeMindmapOverlay}
        activeMindmapGraph={activeMindmapGraph}
        onCloseMindmapOverlay={() => setActiveMindmapOverlay(null)}
        pdfLoading={pdfLoading}
        pdfViewerData={pdfViewerData}
        onClosePdfViewer={closePdfViewer}
        docViewerFile={docViewerFile}
        onCloseDocViewer={closeDocViewer}
        onExitPlayground={handleExitPlayground}
        generalGenerating={generalGenerating}
        generalElapsedTime={generalElapsedTime}
        generalGenerationTime={generalGenerationTime}
      />
    </main>
  );
}
