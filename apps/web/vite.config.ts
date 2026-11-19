import { defineConfig } from "vite";
import { resolve } from "node:path";

const pages = ["index", "link", "attest", "tx", "check", "fix-window", "fix-authz", "fix-feegrant", "fix-approval", "fix-key", "fix-session"];

export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
  // In development, the bot's API runs on :8787.
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
