import { build } from "esbuild";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
await mkdir("output/lambda/docs", { recursive: true });
await mkdir("output/lambda/mail-assets", { recursive: true });
await build({
  entryPoints: ["server/lambda.ts"],
  outfile: "output/lambda/index.js",
  platform: "node",
  target: "node24",
  format: "cjs",
  bundle: true,
  sourcemap: false,
  minify: true,
});
await copyFile("docs/openapi.json", "output/lambda/docs/openapi.json");
for (const image of ["logo.png", "reset-hero.png"]) await copyFile("server/mail-assets/" + image, "output/lambda/mail-assets/" + image);
await writeFile("output/lambda/package.json", JSON.stringify({ type: "commonjs" }));
console.log("Lambda HTTP handler packaged; no listener or Vite included.");
