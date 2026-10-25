import { defineConfig } from "vite";
import { flue, flueWorkerConfig } from "@flue/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root, envDir: false,
  plugins: [flue({ target: "cloudflare", agents: "agent-runtime/profiles.ts", providers: [], tracing: false }),
    cloudflare({ configPath: `${root}wrangler.jsonc`, config: flueWorkerConfig(), persistState: false })],
  build: { outDir: fileURLToPath(new URL("../dist/assistant", import.meta.url)), emptyOutDir: true },
});
