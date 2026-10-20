import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  base: "./",
  // собранное приложение раздаёт сам бот (tradetrust/bot/api.py)
  build: { outDir: "../tradetrust/bot/web", emptyOutDir: true, chunkSizeWarningLimit: 800 },
  test: { environment: "jsdom", css: false },
});
