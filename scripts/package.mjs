import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const SECRET_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{20,}/, /sk-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/];

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);
const checkOnly = process.argv.includes("--check");

const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
const face = manifest.interface ?? {};
const openai = manifest.extensions?.["com.openai"] ?? {};

function limit(label, value, max, required = true) {
  if (value == null || value === "") {
    if (required) fail(`${label} is required.`);
    return;
  }
  if (typeof value !== "string") return fail(`${label} must be a string.`);
  if (value.length > max) fail(`${label} is ${value.length} characters; the limit is ${max}.`);
}

function https(label, value, required = true) {
  if (!value) return required ? fail(`${label} is required.`) : undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") fail(`${label} must use HTTPS.`);
    if (url.username || url.password) fail(`${label} must not contain credentials.`);
    if (value.length > 1024) fail(`${label} is longer than 1024 characters.`);
  } catch {
    fail(`${label} is not a valid URL.`);
  }
}

function luminance(hex) {
  const channel = (index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function color(label, value, background) {
  if (!value) return;
  if (!/^#[0-9A-Fa-f]{6}$/.test(value)) return fail(`${label} must be #RRGGBB.`);
  const ratio = contrast(value, background);
  if (ratio < 2) fail(`${label} ${value} has contrast ${ratio.toFixed(2)} against ${background}; the minimum is 2.`);
}

async function imageSize(file) {
  const buffer = await readFile(file);
  if (file.endsWith(".png")) {
    if (buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG file");
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (file.endsWith(".svg")) {
    const svg = buffer.toString("utf8");
    const width = Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1]);
    const height = Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1]);
    if (width && height) return { width, height };
    const box = /viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/.exec(svg);
    if (box) return { width: Number(box[1]), height: Number(box[2]) };
    throw new Error("SVG has no numeric size or viewBox");
  }
  throw new Error("use PNG or SVG");
}

async function image(label, relative, { square, required }) {
  if (!relative) return required ? fail(`${label} is required.`) : undefined;
  if (!relative.startsWith("./")) fail(`${label} must be a ./ relative path.`);
  if (!existsSync(relative)) return fail(`${label} points to a missing file: ${relative}`);
  const info = await stat(relative);
  if (info.size > MAX_IMAGE_BYTES) fail(`${label} is ${(info.size / 1048576).toFixed(1)} MiB; the limit is 5 MiB.`);
  try {
    const { width, height } = await imageSize(relative);
    if (square && width !== height) fail(`${label} must be square; it is ${width}×${height}.`);
    if (Math.min(width, height) < 48) fail(`${label} must be at least 48×48; it is ${width}×${height}.`);
    if (Math.max(width, height) > 4096) fail(`${label} must be at most 4096 pixels on each side; it is ${width}×${height}.`);
  } catch (error) {
    fail(`${label}: ${error.message}`);
  }
}

async function frontmatter(file) {
  const text = await readFile(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(match[1])?.[1]?.trim();
  return { name: field("name"), description: field("description"), body: match[2].trim() };
}

async function listTools() {
  const home = await mkdtemp(path.join(os.tmpdir(), "coordinator-package-"));
  const client = new Client({ name: "coordinator-package-check", version: "0.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], env: { ...process.env, PROJECTS_COORDINATOR_HOME: home }, stderr: "ignore" }));
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

for (const file of ["dist/server.js", "dist/daemon.js", "dist/app.html"]) {
  if (!existsSync(file)) fail(`${file} is missing. Run npm run build first.`);
}

if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name ?? "") || manifest.name.length > 64) fail("name must be lowercase letters, digits, and single hyphens, at most 64 characters.");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) fail("version must be a semantic version such as 1.0.0.");
limit("description", manifest.description, 4000);
limit("author.name", manifest.author?.name, 120);
https("author.url", manifest.author?.url, false);
https("homepage", manifest.homepage, false);

limit("interface.displayName", face.displayName, 30);
limit("interface.shortDescription", face.shortDescription, 30);
limit("interface.longDescription", face.longDescription, 4000);
limit("interface.developerName", face.developerName, 80);
limit("interface.category", face.category, 80);
if (!Array.isArray(face.capabilities) || !face.capabilities.length) fail("interface.capabilities is required.");
else if (face.capabilities.length > 20 || face.capabilities.some((item) => typeof item !== "string" || item.length > 120)) fail("interface.capabilities allows at most 20 items of at most 120 characters.");
for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) https(`interface.${key}`, face[key]);
const prompts = face.defaultPrompt == null ? [] : [].concat(face.defaultPrompt);
if (prompts.length > 3) fail("interface.defaultPrompt allows at most three prompts.");
for (const prompt of prompts) {
  if (prompt.length > 128) fail(`defaultPrompt "${prompt}" is longer than 128 characters.`);
  if (/(^|\s)@\w/.test(prompt)) fail(`defaultPrompt "${prompt}" must not contain @mentions.`);
}
color("interface.brandColor", face.brandColor, "#FFFFFF");
color("interface.brandColorDark", face.brandColorDark, "#212121");
await image("interface.logo", face.logo, { square: true, required: true });
await image("interface.logoDark", face.logoDark, { square: true, required: false });
await image("interface.composerIcon", face.composerIcon, { square: true, required: true });
await image("interface.composerIconDark", face.composerIconDark, { square: true, required: false });
for (const [index, shot] of (face.screenshots ?? []).entries()) await image(`interface.screenshots[${index}]`, shot, { square: false, required: true });

const mcp = JSON.parse(await readFile(".mcp.json", "utf8"));
const servers = Object.entries(mcp.mcpServers ?? {});
if (!servers.length) fail(".mcp.json must declare mcpServers.");
if (servers.some(([name]) => !name.trim())) fail("Every MCP server needs a name.");
if (servers.some(([, server]) => !server.url)) warn("The MCP server runs locally (stdio). Public submission expects a remote HTTPS server; see docs/submission.md.");

const skillNames = new Set();
for (const entry of await readdir("skills", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join("skills", entry.name, "SKILL.md");
  if (!existsSync(file)) {
    fail(`${file} is missing.`);
    continue;
  }
  const skill = await frontmatter(file);
  if (!skill) fail(`${file} must start with YAML front matter.`);
  else {
    if (!skill.name) fail(`${file} needs a name.`);
    if (!skill.description) fail(`${file} needs a description.`);
    if (!skill.body) fail(`${file} needs instructions.`);
    if (skillNames.has(skill.name)) fail(`Skill name ${skill.name} is used twice.`);
    skillNames.add(skill.name);
  }
}
if (openai.onboardingSkill && !existsSync(openai.onboardingSkill)) fail(`onboardingSkill points to a missing file: ${openai.onboardingSkill}`);

const tools = errors.some((message) => message.startsWith("dist/")) ? [] : await listTools();
const toolNames = new Set(tools.map((tool) => tool.name));
for (const tool of tools) {
  const hints = tool.annotations ?? {};
  for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
    if (typeof hints[hint] !== "boolean") fail(`Tool ${tool.name} must set ${hint} to true or false.`);
  }
  if (hints.readOnlyHint === true && hints.destructiveHint === true) fail(`Tool ${tool.name} cannot be read-only and destructive.`);
  if (!tool.description?.trim()) fail(`Tool ${tool.name} needs a description.`);
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) fail(`Tool name ${tool.name} should be lowercase snake_case.`);
}

const cases = openai.review?.test_cases;
const positive = cases?.positive ?? [];
const negative = cases?.negative ?? [];
if (positive.length !== 5) fail(`Review needs exactly 5 positive test cases; the manifest has ${positive.length}.`);
if (negative.length !== 3) fail(`Review needs exactly 3 negative test cases; the manifest has ${negative.length}.`);
for (const [index, item] of positive.entries()) {
  for (const key of ["description", "prompt", "tools_triggered", "expected_behavior"]) if (!item[key]?.trim()) fail(`Positive case ${index + 1} needs ${key}.`);
  for (const name of (item.tools_triggered ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    if (tools.length && !toolNames.has(name)) fail(`Positive case ${index + 1} names an unknown tool: ${name}.`);
  }
}
for (const [index, item] of negative.entries()) for (const key of ["description", "prompt"]) if (!item[key]?.trim()) fail(`Negative case ${index + 1} needs ${key}.`);
if (!openai.review?.demo_recording_url) warn("review.demo_recording_url is empty. The review needs a video walkthrough URL.");
else https("review.demo_recording_url", openai.review.demo_recording_url);
if (!openai.publication?.release_notes) warn("publication.release_notes is empty.");

const packaged = [".codex-plugin", ".mcp.json", "skills", "dist/server.js", "dist/daemon.js", "dist/app.html", "README.md", "LICENSE"];
for (const asset of [face.logo, face.logoDark, face.composerIcon, face.composerIconDark, ...(face.screenshots ?? [])]) if (asset) packaged.push(asset.replace(/^\.\//, ""));

async function walk(entry) {
  const info = await stat(entry);
  if (!info.isDirectory()) return [entry];
  const files = [];
  for (const child of await readdir(entry)) files.push(...(await walk(path.join(entry, child))));
  return files;
}

const files = [...new Set((await Promise.all(packaged.filter((entry) => existsSync(entry)).map(walk))).flat())];
for (const file of files) {
  if (/\.(png|jpe?g|webp)$/.test(file)) continue;
  const text = await readFile(file, "utf8");
  for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) fail(`${file} looks like it contains a secret (${pattern}).`);
}
if (files.length + 1 > MAX_ENTRIES) fail(`The package has ${files.length + 1} files; the limit is ${MAX_ENTRIES}.`);

for (const message of warnings) console.log(`warning: ${message}`);
if (errors.length) {
  for (const message of errors) console.error(`error: ${message}`);
  console.error(`\n${errors.length} problem(s) found.`);
  process.exit(1);
}
console.log(`Checks passed: ${tools.length} tools, ${skillNames.size} skills, ${positive.length} positive and ${negative.length} negative review cases.`);
if (checkOnly) process.exit(0);

const outDir = path.resolve("release");
const zipFile = path.join(outDir, `${manifest.name}-${manifest.version}.zip`);
const staging = await mkdtemp(path.join(os.tmpdir(), "coordinator-zip-"));
try {
  for (const file of files) {
    await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
    await cp(file, path.join(staging, file));
  }
  await writeFile(path.join(staging, "package.json"), `${JSON.stringify({ name: manifest.name, private: true, type: "module", engines: { node: ">=22.18" } }, null, 2)}\n`);
  await mkdir(outDir, { recursive: true });
  await rm(zipFile, { force: true });
  execFileSync("zip", ["-r", "-X", "-q", zipFile, "."], { cwd: staging });
} finally {
  await rm(staging, { recursive: true, force: true });
}
const size = (await stat(zipFile)).size;
if (size > MAX_ZIP_BYTES) {
  console.error(`error: ${zipFile} is ${(size / 1048576).toFixed(1)} MB; the limit is 100 MB.`);
  process.exit(1);
}
console.log(`Wrote ${path.relative(process.cwd(), zipFile)} (${(size / 1048576).toFixed(2)} MB, ${files.length + 1} files).`);
