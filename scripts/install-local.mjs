import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const name = "codex-projects-plugin";
const marker = ".codex-projects-plugin-install";
const home = os.homedir();
const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
const target = path.join(home, "plugins", name);

if (!existsSync("dist/server.js") || !existsSync("dist/app.html")) throw new Error("Run npm run build first.");

const source = await realpath(process.cwd());
const resolvedTarget = existsSync(target) ? await realpath(target) : path.resolve(target);
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
if (overlaps(source, resolvedTarget)) throw new Error(`Refusing to install into ${target}: it overlaps this checkout. Clone the repository somewhere else.`);
if (existsSync(target) && !existsSync(path.join(target, marker))) {
  throw new Error(`Refusing to replace ${target}: it was not created by this installer. Move it away and try again.`);
}

await mkdir(path.dirname(target), { recursive: true });
const staging = await mkdtemp(path.join(path.dirname(target), `.${name}-staging-`));
let backup;
try {
  for (const entry of [".codex-plugin", ".mcp.json", "skills", "assets", "dist", "README.md", "LICENSE"]) {
    if (existsSync(entry)) await cp(entry, path.join(staging, entry), { recursive: true });
  }
  const manifestFile = path.join(staging, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.version = `${manifest.version.split("+")[0]}+local.${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(staging, "package.json"), `${JSON.stringify({ name, private: true, type: "module", engines: { node: ">=22" } }, null, 2)}\n`);
  await writeFile(path.join(staging, marker), `${manifest.version}\n`);
  if (existsSync(target)) {
    backup = await mkdtemp(path.join(path.dirname(target), `.${name}-previous-`));
    await rename(target, path.join(backup, name));
  }
  await rename(staging, target);
} catch (error) {
  if (backup && !existsSync(target) && existsSync(path.join(backup, name))) await rename(path.join(backup, name), target);
  await rm(staging, { recursive: true, force: true });
  throw error;
}
if (backup) await rm(backup, { recursive: true, force: true });
const version = JSON.parse(await readFile(path.join(target, ".codex-plugin", "plugin.json"), "utf8")).version;

const marketplace = existsSync(marketplaceFile)
  ? JSON.parse(await readFile(marketplaceFile, "utf8"))
  : { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
marketplace.plugins = (marketplace.plugins ?? []).filter((plugin) => plugin.name !== name);
marketplace.plugins.push({
  name,
  source: { source: "local", path: `./plugins/${name}` },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
});
await mkdir(path.dirname(marketplaceFile), { recursive: true });
await writeFile(marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`);

console.log(`Version ${version}.`);
console.log(`Copied the plugin to ${target} and listed it in ${marketplaceFile}.`);
console.log(`Next: codex plugin add ${name}@${marketplace.name ?? "personal"}   (then restart the Codex app)`);
