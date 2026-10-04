import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {
    // A sandboxed preload must be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: { plugins: [svelte()] },
});
