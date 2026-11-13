#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";

async function main() {
  const config = loadConfig();

  const server = new McpServer({
    name: "nhplug-mcp",
    version: "0.1.0",
  });

  registerTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout 은 MCP 프로토콜 전용이므로 로그는 stderr 로만 출력
  console.error(
    `[nhplug-mcp] 시작됨 · baseUrl=${config.baseUrl} · 조회 전용(주문 실행 없음)`
  );
}

main().catch((err) => {
  console.error("[nhplug-mcp] 치명적 오류:", err);
  process.exit(1);
});
