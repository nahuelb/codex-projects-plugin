import os from "node:os";
import path from "node:path";

const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".cargo", "bin"), "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS"];

export function widenPath(): void {
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of EXTRA_BIN_DIRS) if (!current.includes(dir)) current.push(dir);
  process.env.PATH = current.join(path.delimiter);
}
