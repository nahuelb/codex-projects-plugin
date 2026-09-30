import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const name = "codex-projects-plugin";
const legacyNames = ["projects-coordinator"];
const home = os.homedir();
const marketplaceFile = path.join(home, ".agents", "plugins", "marketplace.json");
const target = path.join(home, "plugins", name);

if (!existsSync("dist/server.js") || !existsSync("dist/app.html")) throw new Error("Run npm run build first.");

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const entry of [".codex-plugin", ".mcp.json", "skills", "assets", "dist", "README.md", "LICENSE"]) {
  if (existsSync(entry)) await cp(entry, path.join(target, entry), { recursive: true });
}
const manifestFile = path.join(target, ".codex-plugin", "plugin.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
manifest.version = `${manifest.version.split("+")[0]}+local.${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(target, "package.json"), `${JSON.stringify({ name, private: true, type: "module", engines: { node: ">=22" } }, null, 2)}\n`);

const marketplace = existsSync(marketplaceFile)
  ? JSON.parse(await readFile(marketplaceFile, "utf8"))
  : { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
marketplace.plugins = (marketplace.plugins ?? []).filter((plugin) => plugin.name !== name && !legacyNames.includes(plugin.name));
marketplace.plugins.push({
  name,
  source: { source: "local", path: `./plugins/${name}` },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
});
await mkdir(path.dirname(marketplaceFile), { recursive: true });
await writeFile(marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`);

console.log(`Version ${manifest.version}.`);
console.log(`Copied the plugin to ${target} and listed it in ${marketplaceFile}.`);
console.log(`Next: codex plugin add ${name}@${marketplace.name ?? "personal"}   (then restart the Codex app)`);
