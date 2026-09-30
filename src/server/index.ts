import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { widenPath } from "../core/env.ts";
import { VERSION } from "../shared/version.ts";
import { ICON, registerTools } from "./tools.ts";

widenPath();

const html = await readFile(new URL("./app.html", import.meta.url), "utf8");

const server = new McpServer({ name: "projects", title: "Projects", version: VERSION, icons: [ICON] } as any, {
  instructions:
    "Projects gives this conversation a coordinator role for long-running work. Use the $projects skill to coordinate a project. Call project_context at the start of each coordinator turn.",
});

registerTools(server, html);

await server.connect(new StdioServerTransport());
