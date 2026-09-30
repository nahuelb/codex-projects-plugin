import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}. Set CHROME_BIN.`);

const icons = [
  { svg: "assets/logo.svg", png: "assets/logo.png", size: 512 },
  { svg: "assets/logo-dark.svg", png: "assets/logo-dark.png", size: 512 },
];

for (const icon of icons) {
  if (!existsSync(icon.svg)) continue;
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--default-background-color=00000000",
    "--force-device-scale-factor=1",
    `--window-size=${icon.size},${icon.size}`,
    `--screenshot=${path.resolve(icon.png)}`,
    `file://${path.resolve(icon.svg)}`,
  ], { stdio: "ignore" });
  console.log(`Rendered ${icon.png}`);
}
