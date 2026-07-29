import {
  saveWorkspaceFile,
  openWorkspaceFromFile,
  createNewWorkspace,
  switchWorkspaceById,
} from "./app/workspaceBridge";
import { downloadMissingOptionalModels } from "./app/modelActions";
import { handleModeSwitch } from "./app/sessionSendActions";
import ChatHistorySidebar from "./components/ChatHistorySidebar";
import SidebarNav from "./components/SidebarNav";
import AudioSidebar from "./components/AudioSidebar";
import MindmapsSidebar from "./components/MindmapsSidebar";
import PlaygroundSidebar from "./components/PlaygroundSidebar";
import StartupModelToast from "./components/StartupModelToast";
import AppMainContent from "./components/AppMainContent";
import AppDialogsLayer from "./components/AppDialogsLayer";
import AppRightSidebar from "./components/AppRightSidebar";
import { useTheme } from "./hooks/useTheme";
import { useAppLifecycle } from "./hooks/app/useAppLifecycle";
import { useTour } from "./hooks/useTour";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useUIStore } from "./stores/uiStore";
import { useDownloadStore } from "./stores/downloadStore";
import { useChatModeStore } from "./stores/chatModeStore";
import "./App.css";

function App() {
  const { theme, setTheme } = useTheme();
  useAppLifecycle();
  const { startTour } = useTour();

  const toggleTheme = () => setTheme(theme === "neon" ? "professional" : "neon");

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace);
  const startupContinueWorkspace = useWorkspaceStore((s) => s.startupContinueWorkspace);
  const workspaceBusy = useWorkspaceStore((s) => s.workspaceBusy);

  const sidebarSection = useUIStore((s) => s.sidebarSection);
  const setSidebarSection = useUIStore((s) => s.setSidebarSection);
  const suppressStartupModal = useUIStore((s) => s.suppressStartupModal);
  const setSuppressStartupModal = useUIStore((s) => s.setSuppressStartupModal);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const setProfileOpen = useUIStore((s) => s.setProfileOpen);
  const setToursOpen = useUIStore((s) => s.setToursOpen);

  const chatMode = useChatModeStore((s) => s.chatMode);
  const downloadOptionalOnStart = useDownloadStore((s) => s.downloadOptionalOnStart);

  const handleSidebarNav = (section: "chats" | "audio" | "mindmaps" | "playground") => {
    setSidebarSection(section === sidebarSection ? null : section);
    if (section === "playground") {
      handleModeSwitch("playground");
    } else if (chatMode === "playground") {
      handleModeSwitch("text");
    }
  };

  const handleStartupAction = async (action: () => Promise<void>) => {
    await action();
    if (downloadOptionalOnStart) {
      await downloadMissingOptionalModels();
    }
  };

  const canContinueStartupWorkspace = !!(
    startupContinueWorkspace &&
    workspaces.some((workspace) => workspace.id === startupContinueWorkspace.id)
  );

  const continueExistingWorkspace = () => {
    if (!startupContinueWorkspace || !canContinueStartupWorkspace) return;
    void handleStartupAction(() => switchWorkspaceById(startupContinueWorkspace.id));
  };

  const createWorkspaceFromStartup = () => {
    void handleStartupAction(createNewWorkspace);
  };

  const importWorkspaceFromStartup = () => {
    void handleStartupAction(openWorkspaceFromFile);
  };

  const startTourFromStartup = () => {
    setSuppressStartupModal(true);
    startTour("getting-started", {
      source: "startup",
      onExit: () => setSuppressStartupModal(false),
      onComplete: () => setSuppressStartupModal(false),
    });
  };

  const showStartupModal = !activeWorkspace && !suppressStartupModal;

  return (
    <div className="relative w-full h-full overflow-hidden">
      <AppDialogsLayer
        showStartupModal={showStartupModal}
        onContinueWorkspace={continueExistingWorkspace}
        canContinueWorkspace={canContinueStartupWorkspace}
        continueWorkspaceName={startupContinueWorkspace?.name ?? null}
        onNewProject={createWorkspaceFromStartup}
        onImportProject={importWorkspaceFromStartup}
        onStartTour={startTourFromStartup}
      />

      <div className="flex h-full w-full relative z-10">
        <SidebarNav
          selected={sidebarSection}
          onSelect={handleSidebarNav}
          onImportProject={() => void openWorkspaceFromFile()}
          onExportProject={() => void saveWorkspaceFile()}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenProfile={() => setProfileOpen(true)}
          onOpenTours={() => setToursOpen(true)}
          workspaceBusy={workspaceBusy}
          canExport={!!activeWorkspace}
          theme={theme}
          onToggleTheme={toggleTheme}
        />

        {sidebarSection === null && (
          <div className="w-1 min-w-1 h-full bg-neon rounded-full mx-1 shadow-[0_0_16px_#00d4ff88] transition-all duration-200 opacity-100" />
        )}

        {sidebarSection !== null && (
          <>
            {sidebarSection === "chats" && <ChatHistorySidebar />}
            {sidebarSection === "audio" && <AudioSidebar />}
            {sidebarSection === "mindmaps" && <MindmapsSidebar />}
            {sidebarSection === "playground" && (
              <PlaygroundSidebar
                onOpen={() => {
                  handleModeSwitch("playground");
                  setSidebarSection(null);
                }}
              />
            )}
            <div className="w-1 min-w-1 h-full bg-neon/40 rounded-full mx-1 shadow-[0_0_8px_#00d4ff33] transition-all duration-200 opacity-60" />
          </>
        )}

        <AppMainContent />
        <StartupModelToast />
        <AppRightSidebar />
      </div>
    </div>
  );
}

export default App;
