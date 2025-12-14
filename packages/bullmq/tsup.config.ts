import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  external: ["@mokurokujs/core"],
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "esnext",
  splitting: false,
  treeshake: true,
});
