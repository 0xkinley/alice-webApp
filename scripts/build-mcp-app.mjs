import { build } from "esbuild";

await build({
  entryPoints: ["apps/mcp/ui/workspace-app.ts"],
  outfile: "apps/mcp/dist/workspace-app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
});
