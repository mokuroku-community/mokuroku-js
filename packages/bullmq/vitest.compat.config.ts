import { defineConfig, mergeConfig } from "vitest/config";

import config from "./vitest.unit.config.js";
const runtimeFile = process.env.BULLMQ_RUNTIME_FILE;
if (!runtimeFile) throw new Error("BULLMQ_RUNTIME_FILE is required for compatibility tests");
export default mergeConfig(config, defineConfig({ resolve: { alias: { bullmq: runtimeFile } } }));
