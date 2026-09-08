// @ts-check
import { defineConfig } from "astro/config";

// Groove Galaxy is a GitHub Pages *project* site living beside the personal
// site (a user site at nelson-j.ch), so it is served from a sub-path.
// `site` + `base` feed canonical links and every asset URL, so they must
// track whatever domain actually serves the build.
export default defineConfig({
  site: "https://nelson-jnrnd.github.io",
  base: "/groove-galaxy",
  trailingSlash: "ignore",
  build: { inlineStylesheets: "auto" },
});
