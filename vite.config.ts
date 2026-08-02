import { defineConfig } from "vite";

// Served from a custom domain (see public/CNAME), so the app lives at the root.
export default defineConfig({
  base: "/",
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
  },
});
