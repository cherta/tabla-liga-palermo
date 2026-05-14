import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://cherta.github.io",
  base: process.env.NODE_ENV === "production" ? "/tabla-liga-palermo" : "",
  output: "static",
});
