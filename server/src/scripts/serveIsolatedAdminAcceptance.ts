/**
 * Local-only management-console acceptance server.
 *
 * It deliberately uses the guarded *_test database plus mocked Telegram
 * environment from the test harness. Never point this at a non-test database.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import fastifyStatic from "@fastify/static";

import adminRoutes from "../routes/admin.js";
import orderRoutes from "../routes/orders.js";
import adminCmsRoutes, { adminPackageRoutes } from "../routes/adminCms.js";
import adminUsersAndSupportRoutes from "../routes/adminUsersAndSupport.js";
import adminChannelsRoutes from "../routes/adminChannels.js";
import adminDashboardRoutes from "../routes/adminDashboard.js";
import adminFinanceRoutes from "../routes/adminFinance.js";
import analyticsAndPreferenceRoutes from "../routes/analyticsPreferences.js";
import trafficEntryRoutes from "../routes/trafficEntries.js";
import campaignRoutes from "../routes/campaigns.js";
import adminArticleRoutes from "../routes/adminArticles.js";

const port = Number(process.env.ADMIN_ACCEPTANCE_PORT || "4174");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ADMIN_ACCEPTANCE_PORT must be a local TCP port");

// Keep the test-only harness out of the production TypeScript compilation
// boundary. The dynamic path is resolved only when this local command runs.
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const harnessPath = path.resolve(scriptDirectory, "../../tests/_testHarness.ts");
const testHarness: any = await import(pathToFileURL(harnessPath).href);
const harness = await testHarness.setupTestHarness();
await testHarness.seedTestData(harness.prisma);

const app = Fastify({ logger: false });
await app.register(cookie);
await app.register(session, {
  secret: "local-admin-acceptance-session-secret-at-least-32-characters",
  cookie: { secure: false, sameSite: "lax" },
});
app.decorate("prisma", harness.prisma);
app.decorateRequest("userId", null);
app.decorateRequest("telegramUserId", null);

await app.register(adminRoutes, { prefix: "/api" });
await app.register(orderRoutes, { prefix: "/api" });
await app.register(adminCmsRoutes, { prefix: "/api" });
await app.register(adminPackageRoutes, { prefix: "/api" });
await app.register(adminUsersAndSupportRoutes, { prefix: "/api" });
await app.register(adminChannelsRoutes, { prefix: "/api" });
await app.register(adminDashboardRoutes, { prefix: "/api" });
await app.register(adminFinanceRoutes, { prefix: "/api" });
await app.register(analyticsAndPreferenceRoutes, { prefix: "/api" });
await app.register(trafficEntryRoutes, { prefix: "/api" });
await app.register(campaignRoutes, { prefix: "/api" });
await app.register(adminArticleRoutes, { prefix: "/api" });

const adminDist = path.resolve(scriptDirectory, "../../../admin/dist");
await app.register(fastifyStatic, { root: adminDist, prefix: "/admin/" });
app.get("/admin", async (_req, reply) => reply.redirect("/admin/"));
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith("/admin/")) return reply.type("text/html").sendFile("index.html");
  return reply.code(404).send({ error: "not_found" });
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await testHarness.teardownTestHarness(harness.prisma);
}
process.on("SIGINT", () => { void close().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { void close().finally(() => process.exit(0)); });

await app.listen({ host: "127.0.0.1", port });
console.log(`local isolated admin acceptance ready at http://127.0.0.1:${port}/admin/login`);
