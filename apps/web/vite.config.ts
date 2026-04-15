import { fileURLToPath } from "node:url";

import vinext from "vinext";
import { defineConfig } from "vite";

const emptyModule = fileURLToPath(new URL("./empty-module.mjs", import.meta.url));

export default defineConfig({
  plugins: [vinext()],
  resolve: {
    alias: {
      "pg-native": emptyModule,
    },
  },
  define: {
    __dirname: "import.meta.dirname",
    __filename: "import.meta.filename",
  },
  ssr: {
    external: true,
  },
});
