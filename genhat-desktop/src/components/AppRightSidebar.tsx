import { getActiveRuntimeParamTarget, handleApplyRuntimeParams } from "../app/modelActions";
import { ingestFile, ingestDir, deleteRagDoc, deleteAllRagDocs, openDocViewer } from "../app/ragUiActions";
import { useAdvancedMode } from "../hooks/useAdvancedMode";
import { useSessionStore } from "../stores/sessionStore";
import { useChatModeStore } from "../stores/chatModeStore";
import { useUIStore } from "../stores/uiStore";
import ActiveModelParamsDock from "./ActiveModelParamsDock";
import KnowledgeBaseSidebar from "./KnowledgeBaseSidebar";

export default function AppRightSidebar() {
  const { advanced } = useAdvancedMode();
  
  // Subscribe to stores
  const sessions = useSessionStore(s => s.sessions);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;
  
  const ragDocs = useChatModeStore(s => s.ragDocs);
  const ragIngesting = useChatModeStore(s => s.ragIngesting);
  const enrichmentStatus = useChatModeStore(s => s.enrichmentStatus);
  
  const docPanelOpen = useUIStore(s => s.docPanelOpen);
  const setDocPanelOpen = useUIStore(s => s.setDocPanelOpen);
  const paramsDockOpen = useUIStore(s => s.paramsDockOpen);
  const setParamsDockOpen = useUIStore(s => s.setParamsDockOpen);
  
  // Derived state
  const activeRuntimeParamTarget = getActiveRuntimeParamTarget();
  const showParamsDock = advanced && !!activeRuntimeParamTarget && paramsDockOpen;
  const showRightSidebar = showParamsDock || docPanelOpen;

  if (!showRightSidebar) return null;

  return (
    <aside
      className={`kb-sidebar overflow-hidden bg-void-800 flex shrink-0 ${
        showParamsDock && docPanelOpen ? "w-160 min-w-160" : "w-[320px] min-w-[320px]"
      } border-l border-glass-border`}
    >
      {advanced && showParamsDock && activeRuntimeParamTarget && (
        <div className="w-[320px] min-w-[320px] h-full">
          <ActiveModelParamsDock
            target={activeRuntimeParamTarget}
            onApply={handleApplyRuntimeParams}
            onClose={() => setParamsDockOpen(false)}
          />
        </div>
      )}

      <KnowledgeBaseSidebar
        docPanelOpen={docPanelOpen}
        ragIngesting={ragIngesting}
        enrichmentStatus={enrichmentStatus}
        ragDocs={ragDocs}
        activeSession={activeSession}
        onClosePanel={() => setDocPanelOpen(false)}
        onIngestFile={() => void ingestFile()}
        onIngestDir={() => void ingestDir()}
        onOpenDocViewer={openDocViewer}
        onDeleteRagDoc={(docId) => void deleteRagDoc(docId)}
        onDeleteAllRagDocs={() => void deleteAllRagDocs()}
      />
    </aside>
  );
}
