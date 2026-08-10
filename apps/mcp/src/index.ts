#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createClient } from "./client.ts";
import { createMcpServer } from "./server.ts";

/**
 * tsuzuri's MCP server, over stdio.
 *
 * stdio because that is how a host launches a local server, and because the
 * daemon has no authentication yet -- exposing this over HTTP would put an
 * unauthenticated write surface on the network, which is a decision for the
 * phase that also brings auth.
 *
 * Note that stdout belongs to the protocol. Anything logged has to go to
 * stderr, or it corrupts the JSON-RPC stream.
 */

const endpoint = process.env.TSUZURI_ENDPOINT ?? "http://127.0.0.1:8787";

const server = createMcpServer(createClient({ endpoint }));
await server.connect(new StdioServerTransport());

console.error(`tsuzuri MCP server ready, talking to ${endpoint}`);
