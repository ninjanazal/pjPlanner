#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PlannerApi } from "./api.js";
import { registerTools } from "./tools.js";

const apiKey = process.env.PJPLANNER_API_KEY;
const api = new PlannerApi(process.env.PJPLANNER_URL ?? "http://localhost:3030", apiKey, fetch, process.env.PJPLANNER_PROJECT);
const server = new McpServer({ name: "pjplanner", version: "1.0.0" });
registerTools(server, api, { write: Boolean(apiKey) });
await server.connect(new StdioServerTransport());
