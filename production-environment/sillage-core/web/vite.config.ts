import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root,
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  css: {
    postcss: root,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4000",
      "/health": "http://127.0.0.1:4000",
    },
  },
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
  },
});
