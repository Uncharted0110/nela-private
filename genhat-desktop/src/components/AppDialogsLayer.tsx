import { useEffect } from "react";
import { 
  refreshModels,
  handleDownloadModel,
  handleCancelDownload,
  handleUninstall,
  downloadMissingOptionalModels,
} from "../app/modelActions";
import { useUIStore } from "../stores/uiStore";
import { useModelStore } from "../stores/modelStore";
import { useDownloadStore } from "../stores/downloadStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAuthStore } from "../stores/authStore";
import AppModal from "./AppModal";
import HuggingFaceModal from "./HuggingFaceModal";
import ModelsSettingsModal from "./ModelsSettingsModal";
import StartupModal from "./StartupModal";
import ToursModal from "./ToursModal";
import ProfileModal from "./ProfileModal";
import CloudSettingsModal from "./CloudSettingsModal";
import PremiumUpgradeModal from "./PremiumUpgradeModal";
import RagSourcePickerModal from "./RagSourcePickerModal";
import FileIndexerSetupModal from "./FileIndexerSetupModal";
import FileIndexerChatModal from "./FileIndexerChatModal";
interface AppDialogsLayerProps {
  showStartupModal: boolean;
  onContinueWorkspace: () => void;
  canContinueWorkspace: boolean;
  continueWorkspaceName: string | null;
  onNewProject: () => void;
  onImportProject: () => void;
  onStartTour: () => void;
}

export default function AppDialogsLayer({
  showStartupModal,
  onContinueWorkspace,
  canContinueWorkspace,
  continueWorkspaceName,
  onNewProject,
  onImportProject,
  onStartTour,
}: AppDialogsLayerProps) {
  // Subscribe to stores
  const workspaceBusy = useWorkspaceStore(s => s.workspaceBusy);
  const activeWorkspace = useWorkspaceStore(s => s.activeWorkspace);
  
  const appModal = useUIStore(s => s.appModal);
  const handleModalConfirm = useUIStore(s => s.handleModalConfirm);
  const handleModalCancel = useUIStore(s => s.handleModalCancel);
  const settingsOpen = useUIStore(s => s.settingsOpen);
  const setSettingsOpen = useUIStore(s => s.setSettingsOpen);
  const hfModalOpen = useUIStore(s => s.hfModalOpen);
  const setHfModalOpen = useUIStore(s => s.setHfModalOpen);
  const hfModalPreset = useUIStore(s => s.hfModalPreset);
  const toursOpen = useUIStore(s => s.toursOpen);
  const setToursOpen = useUIStore(s => s.setToursOpen);
  const profileOpen = useUIStore(s => s.profileOpen);
  const setProfileOpen = useUIStore(s => s.setProfileOpen);
  const cloudSettingsOpen = useUIStore(s => s.cloudSettingsOpen);
  const setCloudSettingsOpen = useUIStore(s => s.setCloudSettingsOpen);
  const confirmAction = useUIStore(s => s.confirmAction);
  const hydrateAuth = useAuthStore(s => s.hydrate);

  useEffect(() => {
    void hydrateAuth();
  }, [hydrateAuth]);
  
  const registeredModels = useModelStore(s => s.registeredModels);
  const modelCatalog = useModelStore(s => s.modelCatalog);
  
  const downloads = useDownloadStore(s => s.downloads);
  return (
    <>
      <FileIndexerSetupModal />
      <FileIndexerChatModal />

      {showStartupModal && (
        <StartupModal
          onContinueWorkspace={onContinueWorkspace}
          canContinueWorkspace={canContinueWorkspace}
          continueWorkspaceName={continueWorkspaceName}
          onNewProject={onNewProject}
          onImportProject={onImportProject}
          onStartTour={onStartTour}
          busy={workspaceBusy}
        />
      )}

      <AppModal
        isOpen={appModal.open}
        kind={appModal.kind}
        title={appModal.title}
        message={appModal.message}
        confirmLabel={appModal.confirmLabel}
        cancelLabel={appModal.cancelLabel}
        showCancel={appModal.showCancel}
        onConfirm={handleModalConfirm}
        onCancel={handleModalCancel}
      />

      <ModelsSettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        models={registeredModels}
        modelCatalog={modelCatalog}
        onModelsUpdated={refreshModels}
        downloads={downloads}
        onDownload={handleDownloadModel}
        onCancelDownload={handleCancelDownload}
        onUninstall={handleUninstall}
        onDownloadMissingOptional={downloadMissingOptionalModels}
        onConfirm={confirmAction}
        workspaceId={activeWorkspace?.id}
      />

      <HuggingFaceModal
        isOpen={hfModalOpen}
        onClose={() => setHfModalOpen(false)}
        onModelImported={refreshModels}
        defaultFolder={hfModalPreset.folder}
        defaultImportProfile={hfModalPreset.profile}
      />

      <ToursModal isOpen={toursOpen} onClose={() => setToursOpen(false)} />

      <ProfileModal isOpen={profileOpen} onClose={() => setProfileOpen(false)} />

      <CloudSettingsModal
        isOpen={cloudSettingsOpen}
        onClose={() => setCloudSettingsOpen(false)}
      />

      <PremiumUpgradeModal />

      <RagSourcePickerModal />
    </>
  );
}
