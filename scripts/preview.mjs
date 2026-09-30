import http from "node:http";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const port = Number(process.env.PORT || 4321);
const client = new Client({ name: "coordinator-preview", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], env: process.env, stderr: "inherit" }));

const host = "127.0.0.1";
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const MAX_BODY = 2 * 1024 * 1024;

function sameOrigin(request) {
  if (!allowedHosts.has(request.headers.host ?? "")) return false;
  const origin = request.headers.origin;
  return !origin || allowedHosts.has(origin.replace(/^http:\/\//, ""));
}

http
  .createServer(async (request, response) => {
    try {
      if (!sameOrigin(request)) {
        response.statusCode = 403;
        response.end("Forbidden");
        return;
      }
      if (request.method === "POST" && request.url === "/call") {
        if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
          response.statusCode = 415;
          response.end("Expected JSON");
          return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY) {
            response.statusCode = 413;
            response.end("Too large");
            return;
          }
          chunks.push(chunk);
        }
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
  .listen(port, host, () => console.log(`preview on http://localhost:${port}/?mode=home  (panel: ?mode=panel)`));
