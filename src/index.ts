import { config, mcpUrl } from "./config.js";
import { migrate, sweep } from "./db.js";
import { createApp } from "./app.js";

async function main() {
  await migrate();
  setInterval(() => sweep().catch(console.error), 60 * 60 * 1000).unref();
  createApp().listen(config.port, () => console.log(`google-multi-account-mcp listening on ${config.port}, MCP at ${mcpUrl.href}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
