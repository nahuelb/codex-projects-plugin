import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.PROJECTS_COORDINATOR_HOME = await mkdtemp(path.join(os.tmpdir(), "pc-tools-"));

const { registerTools } = await import("../src/server/tools.ts");

async function connect() {
  const server = new McpServer({ name: "coordinator-test", version: "0.0.0" });
  registerTools(server, "<html></html>");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "tools-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

test("every tool sets all three annotation hints and has a description", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.ok(tools.length > 20);
  for (const tool of tools) {
    for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) {
      assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} ${hint}`);
    }
    assert.ok(!(tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint), `${tool.name} is read-only and destructive`);
    assert.ok(tool.description?.trim(), `${tool.name} description`);
  }
  await client.close();
});

test("model-facing results keep internal fields out of structured content", async () => {
  const client = await connect();
  const created = await client.callTool({ name: "project_create", arguments: { name: "Tool Contract" } });
  const project = (created.structuredContent as { project: Record<string, unknown> }).project;
  assert.equal(project.slug, "tool-contract");
  for (const key of ["createdAt", "updatedAt", "coordinatorThreadId"]) assert.ok(!(key in project), key);
  const home = await client.callTool({ name: "coordinator_home", arguments: {} });
  assert.ok(!("snapshot" in (home.structuredContent as object)));
  assert.ok((home._meta as { snapshot?: unknown })?.snapshot);
  await client.close();
});
