/// <reference types="node" />
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

// `base` must match the GitHub Pages sub-path (https://<user>.github.io/xerxes/).
// Override with BASE_PATH env if you deploy to a custom domain / different repo name.
const base = process.env.BASE_PATH ?? "/xerxes/";

export default defineConfig({
  base,
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(5, 16).replace("T", " ")),
  },
  plugins: [preact(), tailwindcss()],
});
