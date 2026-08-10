import axios from "axios";
import type {
  AdminMe,
  OrderItem,
  Pagination,
  MarkPaidResp,
  AdminAuditLog,
  AdminOrdersFilter,
  ContentListResp,
  ContentListFilter,
  CreateContentInput,
  UpdateContentInput,
  CategoryItem,
  CreateCategoryInput,
  UpdateCategoryInput,
  BannerItem,
  CreateBannerInput,
  UpdateBannerInput,
  HomepageVersionItem,
  PutHomepageDraftInput,
  PublishHomepageInput,
  PublishedHomepageResp,
  ContentItem,
  ApiHomeResp,
  EntitlementItem,
  AdminEntitlementsFilter,
  CancelOrderResp,
  RefundOrderResp,
  ResendInviteResp,
  GrantEntitlementInput,
  GrantEntitlementResp,
  AdminUserItem,
  AdminUserDetail,
  AdminUsersFilter,
  SupportTicketItem,
  SupportTicketDetail,
  SupportTicketsFilter,
  CreateTicketInput,
  ChannelListFilter,
  ChannelListResp,
  ChannelRefreshResp,
  ChannelAddResp,
  ChannelRevealResp,
} from "./types";

const http = axios.create({
  baseURL: "/api",
  timeout: 15_000,
  withCredentials: true,
});

http.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401 && !err.config?._ignoreUnauth) {
      if (typeof window !== "undefined") {
        const already = window.location.pathname.startsWith("/login");
        if (!already) {
          window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname + window.location.search);
        }
      }
    }
    return Promise.reject(err);
  },
);

export default http;

function errMsg(err: unknown, fallback: string): string {
  try {
    const any = err as any;
    return any?.response?.data?.message || any?.response?.data?.error || any?.message || fallback;
  } catch {
    return fallback;
  }
}

export { errMsg };

export async function adminLogin(
  email: string,
  password: string,
): Promise<{ ok: true; admin: AdminMe }> {
  const res = await http.post("/admin/login", { email, password });
  return res.data;
}

export async function adminLogout(): Promise<void> {
  try {
    await http.post("/admin/logout");
  } catch {
    // ignore
  }
}

export async function adminMe(): Promise<AdminMe> {
  const res = await http.get("/admin/me", { timeout: 5000 });
  return res.data;
}

export type AdminOrdersFilter2 = AdminOrdersFilter;

export async function listAdminOrders(q: AdminOrdersFilter): Promise<Pagination<OrderItem>> {
  const params: Record<string, any> = {
    page: q.page,
    pageSize: q.pageSize,
  };
  if (q.status) params.status = q.status;
  if (q.orderNo) params.orderNo = q.orderNo;
  if (q.telegramUserId) params.telegramUserId = q.telegramUserId;
  const res = await http.get("/admin/orders", { params });
  return res.data;
}

export async function getAdminOrder(orderNo: string): Promise<OrderItem> {
  const res = await http.get(`/admin/orders/${encodeURIComponent(orderNo)}`);
  return res.data;
}

export async function adminMarkOrderPaid(
  orderNo: string,
  reason: string,
): Promise<MarkPaidResp> {
  const res = await http.post(`/admin/orders/${encodeURIComponent(orderNo)}/mark-paid`, {
    reason,
  });
  return res.data;
}

export async function getAdminOrderAuditLogs(orderNo: string): Promise<{ items: AdminAuditLog[] }> {
  const res = await http.get(`/admin/orders/${encodeURIComponent(orderNo)}/audit-logs`);
  return res.data;
}

// ==========================================================================
// CMS: Contents
// ==========================================================================
export async function listAdminContents(q: ContentListFilter = {}): Promise<ContentListResp> {
  const res = await http.get("/admin/contents", { params: q });
  return res.data;
}

export async function getAdminContent(id: string): Promise<ContentItem> {
  const res = await http.get(`/admin/contents/${encodeURIComponent(id)}`);
  return res.data;
}

export async function createAdminContent(input: CreateContentInput): Promise<{ ok: true; id: string }> {
  const res = await http.post("/admin/contents", input);
  return res.data;
}

export async function updateAdminContent(id: string, input: UpdateContentInput): Promise<{ ok: true; id: string }> {
  const res = await http.patch(`/admin/contents/${encodeURIComponent(id)}`, input);
  return res.data;
}

export async function setAdminContentCategories(id: string, categoryIds: string[], reason?: string): Promise<{ ok: true; categoryIds: string[] }> {
  const res = await http.put(`/admin/contents/${encodeURIComponent(id)}/categories`, { categoryIds, reason });
  return res.data;
}

export async function submitContentForReview(id: string, reason?: string): Promise<{ ok: true; status: string }> {
  const res = await http.post(`/admin/contents/${encodeURIComponent(id)}/submit_for_review`, { reason });
  return res.data;
}

export async function publishAdminContent(id: string, reason?: string): Promise<{ ok: true; status: string }> {
  const res = await http.post(`/admin/contents/${encodeURIComponent(id)}/publish`, { reason });
  return res.data;
}

export async function unpublishAdminContent(id: string, reason?: string): Promise<{ ok: true; status: string }> {
  const res = await http.post(`/admin/contents/${encodeURIComponent(id)}/unpublish`, { reason });
  return res.data;
}

// ==========================================================================
// CMS: Categories
// ==========================================================================
export async function listAdminCategories(): Promise<{ data: CategoryItem[] }> {
  const res = await http.get("/admin/categories");
  return res.data;
}

export async function createAdminCategory(input: CreateCategoryInput): Promise<{ ok: true; id: string }> {
  const res = await http.post("/admin/categories", input);
  return res.data;
}

export async function updateAdminCategory(id: string, input: UpdateCategoryInput): Promise<{ ok: true; id: string }> {
  const res = await http.patch(`/admin/categories/${encodeURIComponent(id)}`, input);
  return res.data;
}

export async function deleteAdminCategory(id: string, reason?: string): Promise<{ ok: true }> {
  const res = await http.delete(`/admin/categories/${encodeURIComponent(id)}`, { params: reason ? { reason } : {} });
  return res.data;
}

// ==========================================================================
// CMS: Banners
// ==========================================================================
export async function listAdminBanners(): Promise<{ data: BannerItem[] }> {
  const res = await http.get("/admin/banners");
  return res.data;
}

export async function createAdminBanner(input: CreateBannerInput): Promise<{ ok: true; id: string }> {
  const res = await http.post("/admin/banners", input);
  return res.data;
}

export async function updateAdminBanner(id: string, input: UpdateBannerInput): Promise<{ ok: true; id: string }> {
  const res = await http.patch(`/admin/banners/${encodeURIComponent(id)}`, input);
  return res.data;
}

export async function deleteAdminBanner(id: string, reason?: string): Promise<{ ok: true }> {
  const res = await http.delete(`/admin/banners/${encodeURIComponent(id)}`, { params: reason ? { reason } : {} });
  return res.data;
}

// ==========================================================================
// CMS: Homepage Draft + Publish + Public Home
// ==========================================================================
export async function getAdminHomepageDraft(): Promise<{ draft: HomepageVersionItem | null }> {
  const res = await http.get("/admin/homepage/draft");
  return res.data;
}

export async function getAdminHomepagePublished(): Promise<PublishedHomepageResp> {
  const res = await http.get("/admin/homepage/published");
  return res.data;
}

export async function putAdminHomepageDraft(input: PutHomepageDraftInput): Promise<{ ok: true; id: string }> {
  const res = await http.put("/admin/homepage/draft", input);
  return res.data;
}

export async function publishAdminHomepage(input: PublishHomepageInput): Promise<{ ok: true; id: string; publishedAt: string }> {
  const res = await http.post("/admin/homepage/publish", input);
  return res.data;
}

export async function getPublicApiHome(): Promise<ApiHomeResp> {
  const res = await http.get("/home");
  return res.data;
}

// ==========================================================================
// Sprint 2: Orders cancel / refund
// ==========================================================================
export async function adminCancelOrder(
  orderNo: string,
  reason: string,
): Promise<CancelOrderResp> {
  const res = await http.post(`/admin/orders/${encodeURIComponent(orderNo)}/cancel`, { reason });
  return res.data;
}

export async function adminRefundOrder(
  orderNo: string,
  reason: string,
): Promise<RefundOrderResp> {
  const res = await http.post(`/admin/orders/${encodeURIComponent(orderNo)}/refund`, { reason });
  return res.data;
}

// ==========================================================================
// Sprint 2: Entitlements
// ==========================================================================
export async function listAdminEntitlements(q: AdminEntitlementsFilter): Promise<Pagination<EntitlementItem>> {
  const params: Record<string, any> = {};
  for (const k of Object.keys(q) as (keyof AdminEntitlementsFilter)[]) {
    if (q[k] !== undefined && q[k] !== null && q[k] !== "") params[k] = q[k];
  }
  const res = await http.get("/admin/entitlements", { params });
  return res.data;
}

export async function getAdminEntitlement(id: string): Promise<EntitlementItem> {
  const res = await http.get(`/admin/entitlements/${encodeURIComponent(id)}`);
  return res.data;
}

export async function adminResendEntitlementInvite(
  entitlementId: string,
  reason: string,
  opts?: { ttlSeconds?: number; memberLimit?: number },
): Promise<ResendInviteResp> {
  const body: any = { reason, ...(opts || {}) };
  const res = await http.post(
    `/admin/entitlements/${encodeURIComponent(entitlementId)}/resend-invite`,
    body,
  );
  return res.data;
}

export async function adminGrantEntitlement(input: GrantEntitlementInput): Promise<GrantEntitlementResp> {
  const res = await http.post("/admin/entitlements/grant", input);
  return res.data;
}

// ==========================================================================
// Sprint 2: Admin Users
// ==========================================================================
export async function listAdminUsers(q: AdminUsersFilter): Promise<Pagination<AdminUserItem>> {
  const params: Record<string, any> = {};
  for (const k of Object.keys(q) as (keyof AdminUsersFilter)[]) {
    if (q[k] !== undefined && q[k] !== null && q[k] !== "") params[k] = q[k];
  }
  const res = await http.get("/admin/users", { params });
  return res.data;
}

export async function getAdminUser(id: string): Promise<AdminUserDetail> {
  const res = await http.get(`/admin/users/${encodeURIComponent(id)}`);
  return res.data;
}

// ==========================================================================
// Sprint 2: Support Tickets
// ==========================================================================
export async function listAdminTickets(q: SupportTicketsFilter): Promise<Pagination<SupportTicketItem>> {
  const params: Record<string, any> = {};
  for (const k of Object.keys(q) as (keyof SupportTicketsFilter)[]) {
    if (q[k] !== undefined && q[k] !== null && q[k] !== "") params[k] = q[k];
  }
  const res = await http.get("/admin/tickets", { params });
  return res.data;
}

export async function createAdminTicket(input: CreateTicketInput): Promise<SupportTicketItem> {
  const res = await http.post("/admin/tickets", input);
  return res.data;
}

export async function getAdminTicket(id: string): Promise<SupportTicketDetail> {
  const res = await http.get(`/admin/tickets/${encodeURIComponent(id)}`);
  return res.data;
}

export async function adminAssignTicketSelf(ticketId: string, reason?: string): Promise<{ ok: true; assignedToId: string; status: string }> {
  const res = await http.post(`/admin/tickets/${encodeURIComponent(ticketId)}/assign-self`, { reason });
  return res.data;
}

export async function adminAddTicketNote(
  ticketId: string,
  note: string,
  opts?: { isPublic?: boolean; actionRef?: string },
): Promise<{ ok: true; eventId: string; isPublic: boolean }> {
  const body: any = { note, ...(opts || {}) };
  const res = await http.post(`/admin/tickets/${encodeURIComponent(ticketId)}/notes`, body);
  return res.data;
}

export async function adminResolveTicket(
  ticketId: string,
  reason?: string,
): Promise<{ ok: true; status: string; resolvedAt: string | null }> {
  const res = await http.post(`/admin/tickets/${encodeURIComponent(ticketId)}/resolve`, { reason });
  return res.data;
}

export async function adminCloseTicket(
  ticketId: string,
  reason?: string,
): Promise<{ ok: true; status: string; closedAt: string | null }> {
  const res = await http.post(`/admin/tickets/${encodeURIComponent(ticketId)}/close`, { reason });
  return res.data;
}

// ==========================================================================
// Sprint 3: Admin Managed Channels
// ==========================================================================
export async function listAdminChannels(q: ChannelListFilter = {}): Promise<ChannelListResp> {
  const params: Record<string, any> = {};
  for (const k of Object.keys(q) as (keyof ChannelListFilter)[]) {
    if (q[k] !== undefined && q[k] !== null && q[k] !== "") params[k] = q[k];
  }
  const res = await http.get("/admin/channels", { params });
  return res.data;
}

export async function refreshAdminChannels(opts: { reason: string; force?: boolean }): Promise<ChannelRefreshResp> {
  const res = await http.post("/admin/channels/refresh", opts, { timeout: 300_000 });
  return res.data;
}

export async function addAdminChannel(opts: { chatId: string; reason: string }): Promise<ChannelAddResp> {
  const res = await http.post("/admin/channels", opts);
  return res.data;
}

export async function revealAdminChannelId(chatId: string, reason: string): Promise<ChannelRevealResp> {
  const res = await http.post(
    `/admin/channels/${encodeURIComponent(chatId)}/reveal-id`,
    { reason },
  );
  return res.data;
}
