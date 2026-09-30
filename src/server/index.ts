import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { widenPath } from "../core/env.ts";
import { stopLegacyService } from "../core/store.ts";
import { VERSION } from "../shared/version.ts";
import { ICON, registerTools } from "./tools.ts";

widenPath();
void stopLegacyService().catch(() => false);

const html = await readFile(new URL("./app.html", import.meta.url), "utf8");

const server = new McpServer({ name: "coordinator", title: "Project Coordinator", version: VERSION, icons: [ICON] } as any, {
  instructions:
    "Project Coordinator gives this conversation a coordinator role for long-running work. Use the $coordinator skill to coordinate a project. Call project_context at the start of each coordinator turn.",
});

registerTools(server, html);

await server.connect(new StdioServerTransport());
