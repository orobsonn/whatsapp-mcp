import { defineConfig } from "vite";
import { flue, flueWorkerConfig } from "@flue/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateAssistantInstallConfig } from "./installation";
const root = fileURLToPath(new URL(".", import.meta.url));
const supplied = process.env.ASSISTANT_INSTALL_CONFIG;
const configPath = supplied ? resolve(supplied) : `${root}wrangler.jsonc`;
if (supplied) validateAssistantInstallConfig(JSON.parse(readFileSync(configPath, "utf8")), resolve(root, ".."));
export default defineConfig({
  root, envDir: false,
  plugins: [flue({ target: "cloudflare", agents: "agent-runtime/profiles.ts", providers: [], tracing: false }),
    cloudflare({ configPath, config: flueWorkerConfig(), persistState: false })],
  build: { outDir: fileURLToPath(new URL("../dist/assistant", import.meta.url)), emptyOutDir: true },
});
