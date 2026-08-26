import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/echarts") || id.includes("echarts-for-react")) {
            return "echarts";
          }
          if (id.includes("node_modules/pdfjs-dist")) {
            return "pdfjs";
          }
          if (id.includes("node_modules/@xyflow")) {
            return "xyflow";
          }
          if (id.includes("node_modules/docx-preview") || id.includes("node_modules/docx")) {
            return "docx";
          }
          if (id.includes("node_modules/katex")) {
            return "katex";
          }
        },
      },
    },
  },
})
