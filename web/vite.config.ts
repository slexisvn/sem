import { defineConfig, type Plugin } from "vite";
import type { Plugin as EsbuildPlugin } from "esbuild";
import react from "@vitejs/plugin-react";

const optionalImportRE =
  /(?:^|[/\\])(?:distributed|parallel)[/\\].*\.js(?:\?.*)?$/;

function optionalQueryEngineVitePlugin(): Plugin {
  return {
    name: "optional-query-engine-modules",
    enforce: "pre",

    resolveId(id) {
      if (optionalImportRE.test(id)) {
        return {
          id,
          external: true,
        };
      }
    },
  };
}

function optionalQueryEngineEsbuildPlugin(): EsbuildPlugin {
  return {
    name: "optional-query-engine-modules-esbuild",

    setup(build) {
      build.onResolve(
        {
          filter: /(?:distributed|parallel)[\\/].*\.js$/,
        },
        (args) => ({
          path: args.path,
          external: true,
        }),
      );
    },
  };
}

export default defineConfig({
  root: __dirname,
  base: process.env.VITE_BASE_PATH ?? "/",

  plugins: [
    react(),
    optionalQueryEngineVitePlugin(),
  ],

  server: {
    port: 5173,
    open: true,
  },

  optimizeDeps: {
    include: ["@slexisvn/query-engine"],

    esbuildOptions: {
      plugins: [
        optionalQueryEngineEsbuildPlugin(),
      ],
    },
  },
});
