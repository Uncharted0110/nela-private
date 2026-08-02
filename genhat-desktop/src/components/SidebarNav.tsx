import type { ThemeName } from "../hooks/useTheme";
import {
  MessageSquare,
  Volume2,
  Share2,
  Workflow,
  FolderOpen,
  Save,
  Settings,
  HelpCircle,
  Sun,
  Moon,
  User,
  Crown,
} from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import { useCloudStore } from "../stores/cloudStore";
import { convertFileSrc } from "@tauri-apps/api/core";

interface SidebarNavProps {
  selected: "chats" | "audio" | "mindmaps" | "playground" | null;
  onSelect: (section: "chats" | "audio" | "mindmaps" | "playground") => void;
  onImportProject: () => void;
  onExportProject: () => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  onOpenTours: () => void;
  workspaceBusy?: boolean;
  canExport?: boolean;
  theme?: ThemeName;
  onToggleTheme?: () => void;
}

const SidebarNav: React.FC<SidebarNavProps> = ({
  selected,
  onSelect,
  onImportProject,
  onExportProject,
  onOpenSettings,
  onOpenProfile,
  onOpenTours,
  workspaceBusy = false,
  canExport = false,
  theme = "neon",
  onToggleTheme,
}) => {
  const profile = useAuthStore((s) => s.profile);
  const entitlement = useCloudStore((s) => s.entitlement);
  let avatarUrl: string | null = null;
  if (profile?.avatar) {
    const v = profile.avatar.value;
    if (
      profile.avatar.kind === "upload" &&
      !v.startsWith("data:") &&
      !v.startsWith("http")
    ) {
      try {
        avatarUrl = convertFileSrc(v);
      } catch {
        avatarUrl = null;
      }
    } else {
      avatarUrl = v;
    }
  }

  const profileInitial =
    profile?.name?.trim()?.charAt(0)?.toUpperCase() ||
    profile?.email?.trim()?.charAt(0)?.toUpperCase() ||
    null;
  const isPremium =
    profile?.isPremium === true ||
    profile?.displayPlan === "premium" ||
    entitlement?.isPremium === true ||
    entitlement?.displayPlan === "premium" ||
    profile?.plan === "starter" ||
    profile?.plan === "pro";

  return (
    <nav
      className="relative flex flex-col gap-2 py-4 w-14 min-w-14 bg-void-800/80 backdrop-blur-xl items-center"
      data-tour="sidebar-nav"
    >
      <button
        className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-colors ${selected === "chats" ? "bg-neon-subtle text-neon" : "text-txt-secondary hover:text-neon"}`}
        title="Chats"
        onClick={() => onSelect("chats")}
        data-tour="sidebar-chats"
      >
        <MessageSquare size={30} />
      </button>

      <button
        className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-colors ${selected === "audio" ? "bg-neon-subtle text-neon" : "text-txt-secondary hover:text-neon"}`}
        title="Audio Files"
        onClick={() => onSelect("audio")}
        data-tour="sidebar-audio"
      >
        <Volume2 size={30} />
      </button>
      <button
        className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-colors ${selected === "mindmaps" ? "bg-neon-subtle text-neon" : "text-txt-secondary hover:text-neon"}`}
        title="Mindmaps"
        onClick={() => onSelect("mindmaps")}
        data-tour="sidebar-mindmaps"
      >
        <Share2 size={30} />
      </button>
      <button
        className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-colors ${selected === "playground" ? "bg-neon-subtle text-neon" : "text-txt-secondary hover:text-neon"}`}
        title="Playground"
        onClick={() => onSelect("playground")}
        data-tour="sidebar-playground"
      >
        <Workflow size={30} />
      </button>

      <div className="mt-auto flex flex-col items-center gap-1.5 pb-1">
        <button
          className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-colors text-txt-secondary hover:text-neon"
          title={theme === "neon" ? "Switch to Professional (light) theme" : "Switch to Classic (dark) theme"}
          aria-label={theme === "neon" ? "Switch to Professional theme" : "Switch to Classic theme"}
          onClick={onToggleTheme}
        >
          {theme === "neon" ? <Sun size={22} /> : <Moon size={22} />}
        </button>
        <button
          className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-colors text-txt-secondary hover:text-neon"
          title="Help · Tours"
          onClick={onOpenTours}
          data-tour="sidebar-help-tours"
        >
          <HelpCircle size={22} />
        </button>
        <button
          className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-colors text-txt-secondary hover:text-neon"
          title="Settings"
          onClick={onOpenSettings}
          data-tour="sidebar-settings"
        >
          <Settings size={22} />
        </button>
        <button
          className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-colors text-txt-secondary hover:text-neon disabled:opacity-45 disabled:cursor-not-allowed"
          title="Import project (.nela)"
          onClick={() => onImportProject()}
          disabled={workspaceBusy}
        >
          <FolderOpen size={22} />
        </button>
        <button
          className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg transition-colors text-txt-secondary hover:text-neon disabled:opacity-45 disabled:cursor-not-allowed"
          title="Export project (.nela)"
          onClick={() => onExportProject()}
          disabled={workspaceBusy || !canExport}
        >
          <Save size={22} />
        </button>

        <button
          type="button"
          className="mt-1 relative flex items-center justify-center w-9 h-9 rounded-full border border-glass-border bg-void-700 text-txt-secondary hover:text-neon hover:border-neon/40 transition-colors overflow-visible shrink-0"
          title={
            profile
              ? isPremium
                ? `Profile · ${profile.name} · Premium`
                : `Profile · ${profile.name}`
              : "Profile"
          }
          onClick={onOpenProfile}
          data-tour="sidebar-profile"
          aria-label={profile ? `Profile · ${profile.name}` : "Open profile"}
        >
          <span className="flex items-center justify-center w-full h-full rounded-full overflow-hidden">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : profileInitial ? (
              <span className="text-[0.85rem] font-semibold leading-none">{profileInitial}</span>
            ) : (
              <User size={18} />
            )}
          </span>
          {isPremium ? (
            <span
              className="absolute -top-0.5 -right-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-[#1a1408] border border-void-900"
              aria-hidden
            >
              <Crown size={9} strokeWidth={2.5} />
            </span>
          ) : null}
        </button>
      </div>
    </nav>
  );
};

export default SidebarNav;
