import type { TourDefinition } from "./hooks/useTour";

const switchModeFromBindings = (mode: string) => (bindings: Record<string, unknown>) => {
  const switchMode = bindings.switchMode;
  if (typeof switchMode === "function") {
    (switchMode as (nextMode: string) => void)(mode);
  }
};

const openDocPanelFromBindings = () => (bindings: Record<string, unknown>) => {
  const openDocPanel = bindings.openDocPanel;
  if (typeof openDocPanel === "function") {
    (openDocPanel as () => void)();
  }
};

const closeProfileFromBindings = () => (bindings: Record<string, unknown>) => {
  const closeProfile = bindings.closeProfile;
  if (typeof closeProfile === "function") {
    (closeProfile as () => void)();
  }
};

const prepareTextChatTour = (bindings: Record<string, unknown>) => {
  switchModeFromBindings("text")(bindings);
  closeProfileFromBindings()(bindings);
};

export const TOURS: TourDefinition[] = [
  {
    id: "getting-started",
    name: "Getting Started",
    description:
      "Private vs Cloud, profile setup, Fast · Smart · Deep tiers, workspaces, chat, documents, and Help Center.",
    version: 4,
    steps: [
      {
        id: "welcome",
        title: "Welcome to NELA",
        body: (
          <span>
            This quick tour highlights the essentials — Private vs Cloud, your profile, intelligence
            tiers, and everyday chat workflows. Use <strong>Next</strong> to continue or{" "}
            <strong>Skip</strong> anytime.
          </span>
        ),
        target: '[data-tour="sidebar-nav"]',
        centerTooltip: true,
        spotlight: false,
      },
      {
        id: "private-cloud",
        title: "Private or Cloud",
        body: (
          <span>
            <strong>Private</strong> keeps inference on this device. <strong>Cloud</strong> routes
            prompts through NELA Cloud for stronger models — sign in from your profile when you
            switch.
          </span>
        ),
        target: '[data-tour="privacy-indicator"]',
        placement: "bottom",
        onBeforeStep: prepareTextChatTour,
      },
      {
        id: "profile",
        title: "Profile & sign-in",
        body: (
          <span>
            Open your profile to sign in, link NELA Cloud, manage billing, and finish Cloud setup.
            Cloud mode may prompt you here automatically until setup is complete.
          </span>
        ),
        target: '[data-tour="sidebar-profile"]',
        placement: "right",
        onBeforeStep: closeProfileFromBindings(),
      },
      {
        id: "intelligence",
        title: "Fast · Smart · Deep",
        body: (
          <span>
            Choose how the model thinks: <strong>Fast</strong> for quick replies,{" "}
            <strong>Smart</strong> for balanced quality, <strong>Deep</strong> for harder reasoning.
            In Private mode you can also pick a specific local model.
          </span>
        ),
        target: '[data-tour="intelligence-mode"]',
        placement: "bottom",
        onBeforeStep: prepareTextChatTour,
      },
      {
        id: "workspaces",
        title: "Organize with workspaces",
        body: (
          <span>
            Each workspace keeps its own chats and document library separate — ideal for different
            clients, courses, or projects.
          </span>
        ),
        target: '[data-tour="workspace-selector"]',
        placement: "bottom",
        onBeforeStep: prepareTextChatTour,
      },
      {
        id: "sidebar",
        title: "Sidebar shortcuts",
        body: (
          <span>
            Jump between <strong>Chats</strong>, saved <strong>Audio</strong>,{" "}
            <strong>Mindmaps</strong>, and the <strong>Playground</strong> pipeline builder from
            the left rail.
          </span>
        ),
        target: '[data-tour="sidebar-chats"]',
        placement: "right",
        onBeforeStep: prepareTextChatTour,
      },
      {
        id: "chat-tabs",
        title: "Multiple conversations",
        body: (
          <span>
            Open several chats at once with tabs. Drag to reorder, close when done, or start a fresh
            thread with the <strong>+</strong> tab.
          </span>
        ),
        target: '[data-tour="chat-tabs"]',
        placement: "bottom",
        onBeforeStep: prepareTextChatTour,
      },
      {
        id: "attach",
        title: "Add documents",
        body: (
          <span>
            Use <strong>+</strong> to attach files or folders to your library (indexed locally in
            Private mode). In Cloud mode, chat attachments are sent with that conversation.
          </span>
        ),
        target: '[data-tour="attach-button"]',
        placement: "top",
        onBeforeStep: prepareTextChatTour,
      },
      {
        id: "chat-input",
        title: "Ask in plain language",
        body: (
          <span>
            Type a question and press Enter. NELA answers using your documents when relevant and
            shows sources you can verify.
          </span>
        ),
        target: '[data-tour="chat-input"]',
        placement: "top",
        onBeforeStep: prepareTextChatTour,
      },
      {
        id: "tools",
        title: "Tools & toggles",
        body: (
          <span>
            The wrench menu toggles <strong>Library search</strong>, <strong>Web search</strong>,{" "}
            <strong>File indexer</strong>, and extended thinking — tune what the model can use per
            message.
          </span>
        ),
        target: '[data-tour="tools-button"]',
        placement: "top",
        onBeforeStep: prepareTextChatTour,
      },
      {
        id: "sources",
        title: "Document library",
        body: (
          <span>
            Uploaded files appear here. Watch ingestion status, open previews, and confirm which
            sources grounded each answer.
          </span>
        ),
        target: '[data-tour="kb-sidebar"]',
        placement: "left",
        onBeforeStep: (bindings) => {
          prepareTextChatTour(bindings);
          openDocPanelFromBindings()(bindings);
        },
      },
      {
        id: "settings",
        title: "Models & settings",
        body: (
          <span>
            Download optional local models, adjust runtime parameters, and configure advanced
            options from Settings.
          </span>
        ),
        target: '[data-tour="sidebar-settings"]',
        placement: "right",
        onBeforeStep: prepareTextChatTour,
      },
      {
        id: "help",
        title: "Help Center anytime",
        body: (
          <span>
            Re-run this tour or read the full guide from the <strong>Help</strong> button. Tours
            stay available whenever you need a refresher.
          </span>
        ),
        target: '[data-tour="sidebar-help-tours"]',
        placement: "right",
        onBeforeStep: prepareTextChatTour,
      },
    ],
  },
  {
    id: "models",
    name: "Models & Downloads",
    description: "Switch models and manage downloads from Settings.",
    version: 1,
    steps: [
      {
        id: "model-selector",
        title: "Switch models",
        body: <span>Use this selector to switch between installed models for the current mode.</span>,
        target: '[data-tour="model-selector-llm"]',
        placement: "bottom",
      },
      {
        id: "settings",
        title: "Manage models",
        body: <span>Open Settings to manage model downloads, optional models, and runtime parameters.</span>,
        target: '[data-tour="sidebar-settings"]',
        placement: "right",
      },
    ],
  },
  {
    id: "mindmaps",
    name: "Mindmaps",
    description: "Generate and revisit visual mindmaps from a topic.",
    version: 1,
    steps: [
      {
        id: "mindmap-model-selector",
        title: "Select a model",
        body: <span>Choose a suitable model for generating mindmaps from the model selector.</span>,
        target: '[data-tour="model-selector-llm"]',
        placement: "bottom",
        onBeforeStep: switchModeFromBindings("mindmap"),
      },
      {
        id: "mindmap-query",
        title: "Enter your topic",
        body: <span>Type the topic or idea you want to convert into a mindmap here and press Enter.</span>,
        target: '[data-tour="chat-input"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("mindmap"),
      },
      {
        id: "sidebar-mindmaps",
        title: "Saved Mindmaps",
        body: <span>Your generated mindmaps are stored here. You can browse and reopen previous graphs anytime.</span>,
        target: '[data-tour="sidebar-mindmaps"]',
        placement: "right",
        onBeforeStep: switchModeFromBindings("mindmap"),
      },
    ],
  },
  {
    id: "podcast",
    name: "Podcast Studio",
    description: "Turn documents into a two-speaker podcast script and audio.",
    version: 1,
    steps: [
      {
        id: "podcast-header",
        title: "Podcast workspace",
        body: <span>Podcast mode turns your ingested documents into a conversational two-speaker script and audio output.</span>,
        target: '[data-tour="podcast-header"]',
        placement: "bottom",
        onBeforeStep: switchModeFromBindings("podcast"),
      },
      {
        id: "podcast-speakers",
        title: "Speaker setup",
        body: <span>Set each speaker name and voice here, and choose dialogue turns to control episode length.</span>,
        target: '[data-tour="podcast-speakers"]',
        placement: "bottom",
        onBeforeStep: switchModeFromBindings("podcast"),
      },
      {
        id: "podcast-query",
        title: "Topic prompt",
        body: <span>Describe the topic you want the podcast to cover. Nela will ground the conversation in your ingested documents.</span>,
        target: '[data-tour="podcast-query"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("podcast"),
      },
      {
        id: "podcast-generate",
        title: "Generate episode",
        body: <span>Click Generate Podcast to create the script and audio segments. You can then play the full podcast or individual lines.</span>,
        target: '[data-tour="podcast-generate"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("podcast"),
      },
    ],
  },
  {
    id: "documents",
    name: "Documents (RAG)",
    description: "Build a local knowledge base and query your files.",
    version: 1,
    steps: [
      {
        id: "rag-attach",
        title: "Upload documents",
        body: <span>Use the + button to add files or folders and build your local knowledge base.</span>,
        target: '[data-tour="attach-button"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("text"),
      },
      {
        id: "rag-sidebar",
        title: "View knowledge base",
        body: <span>Your uploaded documents are shown here in the right sidebar. You can manage them or see the processing status.</span>,
        target: '[data-tour="kb-sidebar"]',
        placement: "left",
        onBeforeStep: (bindings) => {
          switchModeFromBindings("text")(bindings);
          openDocPanelFromBindings()(bindings);
        },
      },
      {
        id: "rag-query",
        title: "Query your documents",
        body: <span>Type a question about your documents here. The model will automatically search your knowledge base to form an answer.</span>,
        target: '[data-tour="chat-input"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("text"),
      },
    ],
  },
  {
    id: "audio-tts",
    name: "Audio Generation",
    description: "Convert text to speech and manage saved clips.",
    version: 1,
    steps: [
      {
        id: "audio-tts-input",
        title: "Enter text",
        body: <span>Type the text you want to convert into spoken audio here and press Enter.</span>,
        target: '[data-tour="chat-input"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("audio"),
      },
      {
        id: "sidebar-audio-saved",
        title: "Saved Audio",
        body: <span>Your generated audio clips will be saved in the Audio section on the left sidebar. You can manage or replay them anytime.</span>,
        target: '[data-tour="sidebar-audio"]',
        placement: "right",
        onBeforeStep: switchModeFromBindings("audio"),
      },
    ],
  },
];
