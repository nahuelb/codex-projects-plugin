import http from "node:http";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const port = Number(process.env.PORT || 4321);
const client = new Client({ name: "coordinator-preview", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], env: process.env, stderr: "inherit" }));

http
  .createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/call") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const { name, arguments: args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await client.callTool({ name, arguments: args ?? {} });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
        return;
      }
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(await readFile("dist/app.html", "utf8"));
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ isError: true, content: [{ type: "text", text: String(error?.message ?? error) }] }));
    }
  })
  .listen(port, () => console.log(`preview on http://localhost:${port}/?mode=home  (panel: ?mode=panel)`));
