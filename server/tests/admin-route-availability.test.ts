import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";

import adminRoutes from "../src/routes/admin.js";
import orderRoutes from "../src/routes/orders.js";
import adminCmsRoutes, { adminPackageRoutes } from "../src/routes/adminCms.js";
import adminUsersAndSupportRoutes from "../src/routes/adminUsersAndSupport.js";
import adminChannelsRoutes from "../src/routes/adminChannels.js";
import adminDashboardRoutes from "../src/routes/adminDashboard.js";
import adminFinanceRoutes from "../src/routes/adminFinance.js";
import analyticsAndPreferenceRoutes from "../src/routes/analyticsPreferences.js";
import trafficEntryRoutes from "../src/routes/trafficEntries.js";
import campaignRoutes from "../src/routes/campaigns.js";
import adminArticleRoutes from "../src/routes/adminArticles.js";

async function createAdminRouteApp() {
  const app = Fastify();
  await app.register(cookie);
  await app.register(session, { secret: "test-session-secret-is-at-least-thirty-two-characters", cookie: { secure: false } });
  // Every checked route stops at requireAdmin before it can use Prisma. A tiny
  // decoration makes the registration contract identical to the production app
  // without requiring an external database for this anonymous-route test.
  app.decorate("prisma", {} as any);
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
  return app;
}

test("every management page has its primary API route registered and protected", async () => {
  const app = await createAdminRouteApp();
  const routes = [
    "/api/admin/dashboard/summary",
    "/api/admin/analytics/overview",
    "/api/admin/analytics/google-integration",
    "/api/admin/traffic-entries",
    "/api/admin/campaigns",
    "/api/admin/finance/overview",
    "/api/admin/finance/trends",
    "/api/admin/finance/address-pool",
    "/api/admin/finance/reconciliation",
    "/api/admin/orders",
    "/api/admin/entitlements",
    "/api/admin/payment-addresses",
    "/api/admin/payment-addresses/monitor-status",
    "/api/admin/users",
    "/api/admin/tickets",
    "/api/admin/contents",
    "/api/admin/articles",
    "/api/admin/packages",
    "/api/admin/categories",
    "/api/admin/banners",
    "/api/admin/homepage/draft",
    "/api/admin/channels",
    "/api/admin/platform-metadata",
  ];
  try {
    for (const url of routes) {
      const response = await app.inject({ method: "GET", url });
      assert.notEqual(response.statusCode, 404, `${url} must be registered`);
      assert.ok([401, 403].includes(response.statusCode), `${url} must be protected, got ${response.statusCode}: ${response.body}`);
    }
  } finally {
    await app.close();
  }
});
