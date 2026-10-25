import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/assistant-flue-runtime.test.ts"], environment: "node", testTimeout: 90000, hookTimeout: 90000, fileParallelism: false } });
