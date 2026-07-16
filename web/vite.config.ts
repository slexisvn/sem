import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  base: process.env.VITE_BASE_PATH ?? "/",

  plugins: [react()],

  server: {
    port: 5173,
    open: true,
  },

  optimizeDeps: {
    include: ["@slexisvn/query-engine"],
  },
});
