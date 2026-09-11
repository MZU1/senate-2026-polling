import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Plain static build -- no SSR, no API routes here. The map talks to the separately-deployed
// polling API (see ../api/server.ts) over plain fetch(), configured via VITE_POLLING_API_BASE
// at build time (see .env.production.example in this folder).
export default defineConfig({
  plugins: [react()],
});
