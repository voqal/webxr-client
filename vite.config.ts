import { defineConfig } from "vite";
import ssl from "@vitejs/plugin-basic-ssl";

// https://vitejs.dev/config/
export default defineConfig({
  server: { host: true, https: true },
  plugins: [ssl()],
  build: {
    rollupOptions: {
      input: {
        main: "index.html"
      },
    },
  },
});
