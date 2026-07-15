import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  bundle: true,
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: "dist"
});
