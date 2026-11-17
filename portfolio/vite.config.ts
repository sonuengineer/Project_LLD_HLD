import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built site works from any folder (or file server) without a fixed URL prefix.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    rollupOptions: {
      output: { manualChunks: { react: ["react", "react-dom"], charts: ["recharts"], highlight: ["highlight.js/lib/core"] } },
    },
  },
});
