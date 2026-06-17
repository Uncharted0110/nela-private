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

export const TOURS: TourDefinition[] = [
  {
    id: "getting-started",
    name: "Getting Started (Overview)",
    version: 2,
    steps: [
      {
        id: "privacy",
        title: "Your data stays here",
        body: (
          <span>
            Everything you do in NELA happens on this computer. Your documents and chats are never uploaded.
          </span>
        ),
        target: '[data-tour="privacy-indicator"]',
        placement: "bottom",
      },
      {
        id: "workspaces",
        title: "Create a private space",
        body: (
          <span>
            Workspaces keep each project&apos;s documents and chats separate and organized.
          </span>
        ),
        target: '[data-tour="workspace-selector"]',
        placement: "bottom",
      },
      {
        id: "attach",
        title: "Add your documents",
        body: (
          <span>
            Add PDFs, Word files, and more. NELA reads them on this device so you can ask questions about them.
          </span>
        ),
        target: '[data-tour="attach-button"]',
        placement: "top",
      },
      {
        id: "chat-input",
        title: "Ask in plain language",
        body: (
          <span>
            Type a question and press Enter. NELA answers using your documents and shows you its sources.
          </span>
        ),
        target: '[data-tour="chat-input"]',
        placement: "top",
      },
      {
        id: "sources",
        title: "Check the sources",
        body: (
          <span>
            Every answer lists the documents it came from, so you can verify it.
          </span>
        ),
        target: '[data-tour="kb-sidebar"]',
        placement: "left",
        onBeforeStep: openDocPanelFromBindings(),
      },
    ],
  },
  {
    id: "models",
    name: "Models & Downloads",
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
    version: 1,
    steps: [
      {
        id: "mindmap-mode-switch",
        title: "Switch to Mindmap mode",
        body: <span>In the input bar, open the mode selector and choose <strong>Mindmaps</strong> to enter Mindmap mode.</span>,
        target: '[data-tour="mode-switch"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("text"),
      },
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
    version: 1,
    steps: [
      {
        id: "podcast-mode-switch",
        title: "Switch to Podcast mode",
        body: <span>In the input bar, open the mode selector and choose <strong>Podcast</strong> to enter Podcast Studio.</span>,
        target: '[data-tour="mode-switch"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("text"),
      },
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
    version: 1,
    steps: [
      {
        id: "rag-mode-switch",
        title: "Select chat mode",
        body: <span>In the input bar, ensure you have selected the <strong>Chat</strong> mode to query documents.</span>,
        target: '[data-tour="mode-switch"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("text"),
      },
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
    id: "audio-prompting",
    name: "Audio Prompting",
    version: 1,
    steps: [
      {
        id: "audio-mic-button",
        title: "Start dictation",
        body: <span>Click the microphone icon to start recording your voice query. Click it again to stop and transcribe.</span>,
        target: '[data-tour="mic-button"]',
        placement: "top",
      },
      {
        id: "audio-transcription-result",
        title: "Review transcription",
        body: <span>Your transcribed speech will appear here in the chat bar. You can edit it if needed or press Enter to send it to the model.</span>,
        target: '[data-tour="chat-input"]',
        placement: "top",
      },
    ],
  },
  {
    id: "audio-tts",
    name: "Audio Generation",
    version: 1,
    steps: [
      {
        id: "audio-tts-mode-switch",
        title: "Switch to Audio mode",
        body: <span>In the input bar, open the mode selector and choose <strong>Audio</strong> to enter Text-to-Speech mode.</span>,
        target: '[data-tour="mode-switch"]',
        placement: "top",
        onBeforeStep: switchModeFromBindings("text"),
      },
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
