import { build } from "esbuild";

for (const name of ["workspace-app", "save-app"]) {
  await build({
    entryPoints: [`apps/mcp/ui/${name}.ts`],
    outfile: `apps/mcp/dist/${name}.js`,
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["development", "browser"],
    target: ["es2022"],
    minify: true,
    legalComments: "none",
  });
}
