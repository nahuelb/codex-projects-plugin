import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const version = `${pkg.version}+${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
const define = { __BUILD_VERSION__: JSON.stringify(version) };

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const app = await build({
  entryPoints: ["src/app/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
  define,
  logLevel: "warning",
});
const script = app.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = await readFile("src/app/styles.css", "utf8");
const template = await readFile("src/app/index.html", "utf8");
const html = template.replace("/* APP_STYLES */", () => css).replace("<!-- APP_SCRIPT -->", () => `<script>${script}</script>`);
await writeFile("dist/app.html", html);

const node = { bundle: true, platform: "node", format: "esm", target: "node22", define, logLevel: "warning", banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } };
await build({ ...node, entryPoints: ["src/server/index.ts"], outfile: "dist/server.js" });

console.log(`built ${version}: dist/app.html (${Math.round(html.length / 1024)} KB), dist/server.js`);
