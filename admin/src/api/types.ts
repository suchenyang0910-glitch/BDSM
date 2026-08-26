export type AdminRole = "super_admin" | "operator" | "customer_service" | "finance" | "auditor" | "editor";

export type AdminMe = {
  id: string;
  email: string;
  displayName?: string;
  role: AdminRole;
};

export type AdminAnalyticsOverview = {
  period: { preset: "7d" | "30d"; from: string; to: string };
  totals: { eventCount: number; sessions: number; contentOpened: number; paymentsConfirmed: number };
  funnel: Array<{ eventName: string; value: number; conversionFromStart: number }>;
  platforms: Array<{ platform: string; eventCount: number }>;
  trend: Array<{ date: string; sessions: number; contentOpened: number; paymentsConfirmed: number }>;
  preferences: Array<{ preferenceType: string; valueKey: string; selectedUsers: number }>;
  privacy: string;
};

export type OrderStatus = "pending" | "processing" | "paid" | "failed" | "refunded" | "cancelled" | "expired";

export type TicketStatus = "open" | "in_progress" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketCategory = "payment" | "entitlement" | "access" | "refund" | "other";
export type TicketEventType =
  | "created"
  | "assigned"
  | "note_internal"
  | "note_public"
  | "status_changed"
  | "resolved"
  | "closed"
  | "action_taken";

export type ProductType = "single" | "package" | "membership";

export type ResourceType = "content" | "package" | "membership_channel";

export type EntitlementStatus = "active" | "revoked" | "expired";

export type ProductBrief = {
  id: string;
  type: ProductType;
  title: string;
  priceMinor: string | null;
  currency: string;
  durationDays: number | null;
};

export type UserStatus = "active" | "suspended" | "deleted";

export type UserBrief = {
  id: string;
  telegramUserId: string | null;
  username: string | null;
  displayName: string;
  photoUrl: string | null;
  status: UserStatus;
  avatarUrl?: string | null;
};

export type Entitlement = {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  status: EntitlementStatus;
  startsAt: string;
  expiresAt: string | null;
};

export type OrderItem = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  product: ProductBrief;
  amountMinor: string;
  currency: string;
  paymentProvider: string;
  providerOrderId: string | null;
  paidAt: string | null;
  createdAt: string;
  user: UserBrief;
  entitlements: Entitlement[];
};

export type Pagination<T> = {
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};

export type AdminOrdersFilter = {
  page?: number;
  pageSize?: number;
  status?: OrderStatus;
  orderNo?: string;
  telegramUserId?: string;
};

export type MarkPaidResp = {
  orderNo: string;
  status: OrderStatus;
  paidAt: string | null;
  idempotent: boolean;
  entitlements: Array<{
    id: string;
    resourceType: ResourceType;
    resourceId: string;
    status: EntitlementStatus;
    expiresAt: string | null;
  }>;
};

export type AdminAuditLog = {
  id: string;
  action: string;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  admin: {
    id: string;
    email: string;
    displayName: string;
    role: AdminRole;
  } | null;
};

export type ContentStatus = "draft" | "in_review" | "scheduled" | "published" | "archived";
export type BannerStatus = "draft" | "active" | "inactive" | "scheduled" | "archived";
export type BannerTargetType = "content" | "category" | "package" | "membership" | "external";
export type HomepageVersionStatus = "draft" | "published" | "archived";

export type CategoryBrief = {
  id: string;
  name: string;
  slug: string;
  displayOrder?: number;
};

export type ProductInContent = {
  id: string;
  title: string;
  priceMinor?: string;
  currency?: string;
};

export type PackageInContent = {
  id: string;
  title: string;
};

export type PackageStatus = "draft" | "published" | "offline";

export type AdminPackageItem = {
  id: string;
  title: string;
  coverUrl: string | null;
  status: PackageStatus;
  productId: string | null;
  productTitle?: string | null;
  productActive: boolean;
  productStatus?: "active" | "inactive";
  priceMinor?: string | null;
  currency?: string | null;
  channelConfigured: boolean;
  contentsCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateAdminPackageInput = {
  title: string;
  coverUrl?: string | null;
  status?: PackageStatus;
  productTitle: string;
  priceMinor: string;
  currency?: string;
  productStatus?: "active" | "inactive";
  reason?: string;
};

export type UpdateAdminPackageInput = Partial<CreateAdminPackageInput>;

export type EditorBrief = {
  id: string;
  email: string;
  displayName?: string;
};

export type EffectiveSeo = {
  title: string | null;
  description: string | null;
  keywords: string[];
  geoKeywords: string[];
  source: {
    title: "content" | "platform" | "none";
    description: "content" | "platform" | "none";
    keywords: "content" | "platform" | "none";
    geoKeywords: "content" | "platform" | "none";
  };
};

export type PlatformMetadata = {
  id: string;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string[];
  geoKeywords: string[];
  updatedAt: string | null;
  updatedBy: string | null;
};

export type ContentItem = {
  id: string;
  title: string;
  coverUrl: string | null;
  /** 受控 VOD 封面预览入口；不包含对象存储地址。 */
  coverPreviewPath?: string | null;
  thumbnailUrl: string | null;
  description: string | null;
  tags: string[];
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string[];
  geoKeywords?: string[];
  effectiveSeo?: EffectiveSeo;
  previewUrl: string | null;
  previewEnabled?: boolean;
  previewDurationSeconds?: number;
  durationSeconds: number | null;
  accessType: "public" | "single" | "membership" | "package";
  status: ContentStatus;
  isRecommended: boolean;
  isFeatured: boolean;
  isNewArrival: boolean;
  featuredSort: number | null;
  sortOrder: number;
  recommendStartsAt: string | null;
  recommendEndsAt: string | null;
  scheduledAt: string | null;
  freeChannelCode: string | null;
  channelId: string | null;
  packageId: string | null;
  productId: string | null;
  fullVideoAssetId?: string | null;
  fullVideoAssetIds?: string[];
  publishedAt: string | null;
  telegramMessageId: string | null;
  telegramSentAt: string | null;
  telegramChatFingerprint: string | null;
  lastEditorId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  categories: CategoryBrief[];
  product?: ProductInContent | null;
  package?: PackageInContent | null;
  lastEditor?: EditorBrief | null;
};

export type ContentListResp = {
  total: number;
  page: number;
  limit: number;
  data: ContentItem[];
};

export type ContentListFilter = {
  page?: number;
  limit?: number;
  status?: ContentStatus;
  categoryId?: string;
  q?: string;
  accessType?: string;
};

export type CreateContentInput = {
  title: string;
  coverUrl?: string | null;
  thumbnailUrl?: string | null;
  description?: string | null;
  tags?: string[];
  previewUrl?: string | null;
  previewEnabled?: boolean;
  previewDurationSeconds?: 30 | 60 | 90;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string[];
  geoKeywords?: string[];
  durationSeconds?: number | null;
  accessType?: "public" | "single" | "membership" | "package";
  isRecommended?: boolean;
  isFeatured?: boolean;
  isNewArrival?: boolean;
  featuredSort?: number | null;
  sortOrder?: number;
  recommendStartsAt?: string | null;
  recommendEndsAt?: string | null;
  scheduledAt?: string | null;
  freeChannelCode?: string | null;
  packageId?: string | null;
  productId?: string | null;
  fullVideoAssetId?: string | null;
  fullVideoAssetIds?: string[];
  categoryIds?: string[];
  reason?: string;
};

export type UpdateContentInput = Partial<CreateContentInput> & {
  reason?: string;
};

export type FreeChannelOption = {
  code: string;
  label: string;
  description: string;
};

export type PublishVideoInput = {
  videoFileId: string;
  thumbnailFileId?: string | null;
  caption?: string | null;
  supportsStreaming?: boolean;
  parseMode?: "MarkdownV2" | "HTML" | "Markdown";
  reason?: string;
};

export type RegisterTelegramPublishInput = {
  telegramMessageId: string | number;
  telegramChatFingerprint?: string | null;
  freeChannelCode?: string | null;
  videoFileIdRemark?: string | null;
  caption?: string | null;
  reason?: string;
};

export type PublishVideoResult = {
  ok: boolean;
  registerMode?: "manual";
  messageId?: number | string;
  sentAt?: string;
  channelLabel?: string;
  freeChannelCode?: string | null;
  chatMasked?: string;
  chatFingerprint?: string;
  waitedMs?: number;
  videoFileIdRemark?: string | null;
  errorMessage?: string;
};

export type RegisterTelegramPublishResult = PublishVideoResult;

export type StartTelegramPublishInput = {
  channelKinds: Array<"public_free_preview" | "membership_full" | "package_full">;
  telegramTags?: string[];
  reason?: string;
};

export type StartTelegramPublishResp = {
  ok: true;
  jobs: Array<{
    id: string;
    channelKind: string;
    status: string;
    jobToken: string;
    mediaAssetId: string | null;
    videoAssetId: string | null;
    targetFreeChannelCode: string | null;
    createdAt: string;
  }>;
  normalizedTelegramTags: string[];
};

export type PaymentAddressStatus = "pending_approval" | "available" | "assigned" | "retired";

export type PaymentAddressItem = {
  id: string;
  network: string;
  addressMasked: string;
  status: PaymentAddressStatus;
  approvedAt?: string | null;
  activationReadyAt?: string | null;
  autoCreditFrozenAt?: string | null;
  autoCreditFreezeReason?: string | null;
  assignedOrderId: string | null;
  assignedAt: string | null;
  releaseAt: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  createdAt: string;
};

export type PaymentAddressListFilter = {
  page?: number;
  pageSize?: number;
  status?: PaymentAddressStatus;
  network?: string;
  addressKeyword?: string;
};

export type PaymentAddressListResp = Pagination<PaymentAddressItem> & {
  summary: {
    countsByStatusNetwork: Array<{
      status: PaymentAddressStatus;
      network: string;
      count: number;
    }>;
  };
};

export type PaymentAddressCreateInput = {
  address: string;
  network?: "tron_trc20";
};

export type PaymentAddressCreateResp = {
  ok: true;
  id: string;
  addressMasked: string;
  status: PaymentAddressStatus;
};

export type PaymentAddressApproveResp = {
  ok: true;
  idempotent: boolean;
  id: string;
  status: PaymentAddressStatus;
  activationReadyAt: string | null;
};

export type PaymentAddressRevealResp = {
  ok: true;
  id: string;
  network: string;
  address: string;
  addressMasked: string;
  status: PaymentAddressStatus;
  warning: string;
};

export type PaymentAddressRetireInput = {
  reason: string;
  forceReleaseAssigned?: boolean;
  forceCancelActiveOrder?: boolean;
};

export type PaymentAddressRetireResp = {
  ok: true;
  idempotent: boolean;
  id: string;
  status: PaymentAddressStatus;
  retiredAt: string | null;
  releasedAssigned: boolean;
  cancelledActiveOrderNo: string | null;
};

export type PaymentAddressReleaseExpiredResp = {
  ok: true;
  released: number;
  errors: number;
};

export type UsdtMonitorStatusResp = {
  ok: true;
  counts: {
    pendingApproval?: number;
    available: number;
    assigned: number;
    retired: number;
  };
  availableLow: boolean;
  monitor: {
    workerName: string;
    status: "normal" | "delayed" | "unavailable";
    lastCycleAt: string | null;
    lastSuccessAt: string | null;
    lastBlockNumber: string | null;
    lastScannedAddressCount: number;
    lastDiscoveredTxCount: number;
    lastConfirmedCount: number;
    lastRejectedCount: number;
    consecutiveFailures: number;
    lastErrorClass: string | null;
    lastProviderStatus: string | null;
  };
};

export type CategoryItem = {
  id: string;
  name: string;
  slug: string;
  iconUrl: string | null;
  sortOrder: number;
  status: "active" | "inactive" | "archived";
  createdAt: string;
  updatedAt: string;
  contentCount: number;
};

export type CreateCategoryInput = {
  name: string;
  slug: string;
  iconUrl?: string | null;
  sortOrder?: number;
  status?: "active" | "inactive" | "archived";
  reason?: string;
};

export type UpdateCategoryInput = Partial<CreateCategoryInput> & { reason?: string };

export type BannerItem = {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  actionLabel: string;
  slot: string;
  targetType: BannerTargetType;
  targetId: string | null;
  externalUrl: string | null;
  status: BannerStatus;
  sortOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateBannerInput = {
  title: string;
  description?: string | null;
  /** 只能选择后台素材库里已校验完成的封面图片。 */
  imageAssetId: string;
  actionLabel?: string;
  slot?: string;
  targetType?: BannerTargetType;
  targetId?: string | null;
  externalUrl?: string | null;
  status?: BannerStatus;
  sortOrder?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  categoryId?: string | null;
  reason?: string;
};

export type UpdateBannerInput = Partial<CreateBannerInput> & { reason?: string };

export type BannerImageAsset = {
  id: string;
  originalFilename: string;
  imageUrl: string;
  contentLength: string | null;
  widthPixels: number | null;
  heightPixels: number | null;
  createdAt: string;
  updatedAt: string;
};

export type HomepageConfig = {
  bannerIds: string[];
  recommendContentIds: string[];
  featuredContentIds: string[];
  categoryOrderIds: string[];
};

export type HomepageVersionItem = {
  id: string;
  versionLabel: string | null;
  status: HomepageVersionStatus;
  config: HomepageConfig;
  publishedAt: string | null;
  publishedBy: string | null;
  note: string | null;
  publishedNote: string | null;
  createdAt: string;
  updatedAt: string;
  publisher?: { id: string; displayName: string; email: string } | null;
};

export type PutHomepageDraftInput = {
  versionLabel?: string | null;
  note?: string | null;
  config: HomepageConfig;
  reason?: string;
};

export type PublishHomepageInput = {
  id: string;
  versionLabel?: string | null;
  publishedNote?: string | null;
  reason?: string;
};

export type PublishedHomepageResp = {
  published: HomepageVersionItem | null;
  recent: HomepageVersionItem[];
};

export type ApiHomeBanner = {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  targetType: "content" | "category" | "package" | "membership" | "external" | null;
  targetId: string | null;
  externalUrl?: string;
  imageUrl: string | null;
};

export type ApiHomeContent = {
  id: string;
  title: string;
  coverUrl: string | null;
  description: string;
  duration: string | null;
  durationSeconds: number | null;
  accessType: string;
  access: "public" | "member";
  isFeatured: boolean;
  isRecommended: boolean;
  tag: string;
  tags: string[];
  categoryId: string;
  categoryName?: string;
  packageId?: string | null;
  packageTitle?: string | null;
  productId?: string | null;
  previewUrl?: string | null;
  priceMinor?: string;
  priceCurrency?: string;
  publishedAt?: string;
  unlocked?: boolean;
};

export type ApiHomeCategory = {
  id: string;
  name: string;
  slug: string;
  iconUrl: string | null;
  _system?: boolean;
  sortOrder: number;
  publishedContentCount?: number;
};

export type ApiHomeResp = {
  unlocked: boolean;
  versionId: string | null;
  versionLabel: string | null;
  publishedAt: string | null;
  brandHint?: string;
  banners: ApiHomeBanner[];
  categories: ApiHomeCategory[];
  contents: ApiHomeContent[];
  featuredContent?: ApiHomeContent | null;
  latestContents?: ApiHomeContent[];
  themeCategories?: ApiHomeCategory[];
  meta: {
    generatedAt: string;
    entitlementCount: number;
    hasMembership: boolean;
  };
};

// ==========================================================================
// Sprint 2: Entitlements + Users + Support Tickets
// ==========================================================================

export type EntitlementSourceOrder = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  amountMinor: string | null;
  currency?: string;
  product?: any;
  paidAt?: string | null;
};

export type EntitlementInvite = {
  id: string;
  inviteLink?: string;
  expiresAt: string | null;
  usedAt?: string | null;
  deliveryMethod?: string;
  deliveryError?: string | null;
};

export type EntitlementRemovalStatus =
  | "none"
  | "grace_period"
  | "removed"
  | "removal_failed"
  | "renewed_during_grace";

export type EntitlementItem = {
  id: string;
  userId: string;
  resourceType: ResourceType;
  resourceId: string;
  status: EntitlementStatus;
  startsAt: string;
  expiresAt: string | null;
  graceEndsAt: string | null;
  expiryReminderAt: string | null;
  preGraceReminderAt: string | null;
  expiryReminderCount: number;
  removalStatus: EntitlementRemovalStatus;
  removalAttemptedAt: string | null;
  removedAt: string | null;
  lastRemovalErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  sourceOrder: EntitlementSourceOrder | null;
  user: UserBrief | null;
  channelInvite: EntitlementInvite | null;
};

export type AdminEntitlementsFilter = {
  page?: number;
  pageSize?: number;
  status?: EntitlementStatus;
  resourceType?: ResourceType;
  removalStatus?: EntitlementRemovalStatus;
  userId?: string;
  telegramUserId?: string;
  orderNo?: string;
  resourceId?: string;
};

export type CancelOrderResp = {
  orderNo: string;
  status: OrderStatus;
  idempotent: boolean;
};

export type RefundOrderResp = {
  orderNo: string;
  status: OrderStatus;
  idempotent: boolean;
  revokedEntitlements: EntitlementItem[];
  channelKicks: { entitlementId: string; success: boolean; error?: string }[];
  userNotified: boolean;
  notifyError?: string;
};

export type ResendInviteResp = {
  ok: true;
  entitlementId: string;
  invite: EntitlementInvite;
};

export type RetryEntitlementRemovalResp = {
  ok: boolean;
  action: string;
  errorCode: string | null;
  entitlement: EntitlementItem | null;
};

export type GrantEntitlementInput = {
  userId: string;
  resourceType: ResourceType;
  resourceId: string;
  reason: string;
  durationDays?: number;
  sourceOrderId?: string;
  ticketId?: string;
};

export type GrantEntitlementResp = {
  ok: true;
  entitlement: EntitlementItem;
  ticketEvent: string | null;
  telegramInvite: EntitlementInvite | { error: string } | null;
};

export type AdminUserItem = {
  id: string;
  displayName: string;
  username: string | null;
  telegramUserId: string | null;
  photoUrl: string | null;
  avatarUrl?: string | null;
  status: UserStatus;
  createdAt: string;
  ordersCount: number;
  lastOrderAt: string | null;
  entitlementsCount: number;
  activeEntitlementsCount: number;
  hasActiveEntitlement: boolean;
  ticketsCount: number;
  supportTicketsCount: number;
  openTicketsCount: number;
  lastActiveAt: string | null;
  email: string | null;
  languageCode: string | null;
  timezone: number | null;
  recentEntitlements: Array<{
    id: string;
    resourceType: ResourceType;
    resourceId: string;
    status: EntitlementStatus;
    expiresAt: string | null;
    revokedAt?: string | null;
  }>;
};

export type AdminUserDetail = AdminUserItem & {
  counts: { orders: number; entitlements: number; tickets: number; telegramInvites: number };
  recentOrders: Array<{
    id: string;
    orderNo: string;
    status: OrderStatus;
    amountMinor: string | null;
    currency: string;
    product: { id: string; type: ProductType; title: string } | null;
    paidAt: string | null;
    createdAt: string;
    entitlementsCount: number;
    paymentMethod?: string | null;
  }>;
  entitlements: EntitlementItem[];
  tickets: Array<{
    id: string;
    ticketNo: string;
    title: string;
    status: TicketStatus;
    priority: TicketPriority;
    category: TicketCategory;
    createdAt: string;
    assignedToId?: string | null;
    assignedToName?: string | null;
  }>;
  recentEntitlements: Array<{
    id: string;
    resourceType: ResourceType;
    resourceId: string;
    status: EntitlementStatus;
    expiresAt: string | null;
    revokedAt?: string | null;
    sourceOrderNo?: string | null;
    startsAt: string;
  }>;
  recentSupportTickets: Array<{
    id: string;
    ticketNo: string;
    title: string | null;
    category: TicketCategory;
    priority: TicketPriority;
    status: TicketStatus;
    assignedToId?: string | null;
    assignedToName?: string | null;
    createdAt: string;
  }>;
};

export type AdminUsersFilter = {
  page?: number;
  pageSize?: number;
  q?: string;
  telegramUserId?: string;
  status?: UserStatus;
  hasActiveEntitlement?: boolean;
};

export type SupportTicketItem = {
  id: string;
  ticketNo: string;
  userId: string;
  title: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  description: string | null;
  telegramUserId: string | null;
  orderId: string | null;
  entitlementId: string | null;
  assignedToId: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: UserBrief | null;
  sourceOrder: { id: string; orderNo: string; status: OrderStatus } | null;
  sourceOrderNo?: string | null;
  relatedEntitlementId?: string | null;
  entitlement: { id: string; resourceType: ResourceType; resourceId: string; status: EntitlementStatus } | null;
  assignedTo: { id: string; email: string; displayName: string; role: AdminRole } | null;
  assignedToName?: string | null;
  assignedAt?: string | null;
  eventsCount?: number;
  lastEventAt?: string | null;
};

export type TicketEventItem = {
  id: string;
  ticketId: string;
  type: TicketEventType;
  authorType: "user" | "admin" | "system";
  authorUserId: string | null;
  authorAdminId: string | null;
  authorId?: string | null;
  note: string | null;
  content?: string | null;
  actionRef: string | null;
  oldStatus: TicketStatus | null;
  newStatus: TicketStatus | null;
  createdAt: string;
  metadata?: Record<string, any> | null;
  authorUser?: UserBrief | null;
  authorAdmin?: { id: string; email: string; displayName: string; role: AdminRole } | null;
  authorAdminName?: string | null;
  authorUserName?: string | null;
  authorUserAvatar?: string | null;
};

export type SupportTicketDetail = SupportTicketItem & {
  events: TicketEventItem[];
  sourceOrderStatus?: OrderStatus | null;
  relatedEntitlementStatus?: EntitlementStatus | null;
};

export type SupportTicketsFilter = {
  page?: number;
  pageSize?: number;
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  assignedToId?: string;
  unassignedOnly?: boolean;
  mine?: boolean;
  userId?: string;
  telegramUserId?: string;
  orderNo?: string;
  entitlementId?: string;
  q?: string;
};

export type CreateTicketInput = {
  userId: string;
  title: string;
  category: TicketCategory;
  priority?: TicketPriority;
  description?: string;
  orderId?: string;
  entitlementId?: string;
  telegramUserId?: string;
  initialNotePublic?: string;
  initialPublicNote?: string;
};

export type ChannelSource = "auto_scan" | "manual_add";
export type ManagedChannelPurpose = "none" | "free_preview" | "membership_main" | "package_channel";
export type ChannelDiscoveryLinkType = "public_username" | "private_invite" | "unknown";
export type ChannelDiscoveryStatus =
  | "pending_public_check"
  | "awaiting_bot_admin"
  | "discovered"
  | "bound"
  | "conflict"
  | "failed";

export type ChannelItem = {
  chatId: string;
  chatIdHmac: string;
  chatIdMasked: string;
  type: string;
  title: string | null;
  username: string | null;
  memberCount: number | null;
  avatarFileId: string | null;
  isPrivate: boolean;
  source: ChannelSource;
  purpose: ManagedChannelPurpose;
  packageId: string | null;
  packageTitle: string | null;
  publicUrl: string | null;
  botIsAdmin: boolean;
  botCanPostMessages: boolean;
  botCanInviteUsers: boolean;
  botCanRestrictMembers: boolean;
  lastDiscoveryUpdateType: string | null;
  discoveryErrorCode: string | null;
  lastEventAt: string | null;
  refreshedAt: string | null;
  createdAt: string;
};

export type ChannelDiscoveryRequestItem = {
  id: string;
  submittedLink: string;
  normalizedLink: string | null;
  linkType: ChannelDiscoveryLinkType;
  status: ChannelDiscoveryStatus;
  requestedPurpose: ManagedChannelPurpose;
  packageId: string | null;
  packageTitle: string | null;
  resolvedChannelHmac: string | null;
  resolvedChannelMasked: string | null;
  resolvedChannelTitle: string | null;
  waitingSince: string | null;
  discoveredAt: string | null;
  boundAt: string | null;
  lastErrorCode: string | null;
  lastErrorNote: string | null;
  submittedByAdmin: {
    id: string;
    displayName?: string;
    email: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type ChannelListFilter = {
  page?: number;
  pageSize?: number;
  purpose?: ManagedChannelPurpose;
  status?: ChannelDiscoveryStatus;
  search?: string;
};

export type ChannelListResp = {
  items: ChannelItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
};

export type ChannelDiscoveryListResp = {
  items: ChannelDiscoveryRequestItem[];
};

export type SubmitChannelDiscoveryInput = {
  channelLink: string;
  purpose?: ManagedChannelPurpose;
  packageId?: string | null;
  reason: string;
};

export type SubmitChannelDiscoveryResp = {
  ok: true;
  mode: "public_verified" | "awaiting_bot_admin";
  request: ChannelDiscoveryRequestItem;
  channel?: ChannelItem;
};

export type BindChannelPurposeInput = {
  purpose: ManagedChannelPurpose;
  packageId?: string | null;
  reason: string;
};

export type BindChannelPurposeResp = {
  ok: true;
  channel: ChannelItem;
};

export type ChannelRefreshSummary = {
  scannedFromUpdates: number;
  processed: number;
  refreshed: number;
  failed: number;
  fromCache: number;
};

export type ChannelRefreshRow = {
  chatId: string;
  chatIdMasked: string;
  title: string | null;
  memberCount: number | null;
  status: "refreshed";
};

export type ChannelRefreshError = {
  chatId: string;
  chatIdMasked: string;
  tgCode: number | null;
  errorClass: string;
};

export type ChannelRefreshResp = {
  ok: true;
  summary: ChannelRefreshSummary;
  refreshed: ChannelItem[];
  errors: ChannelRefreshError[];
};

export type AdminDashboardGmvByMethod = Record<
  string,
  {
    amountDisplay: string;
    amountMinor: string;
    count: number;
    currency: string;
  }
>;

export type AdminDashboardCards = {
  payingUsers: {
    value: number;
    unit: string;
    description: string;
  };
  monthlyGmv: {
    byMethod: AdminDashboardGmvByMethod;
    totalPaidOrders: number;
    description: string;
  };
  membershipRenewal: {
    expiringMembershipUsers: number;
    renewedWithin7dUsers: number;
    ratePercent: number;
    description: string;
  };
  packagePurchase: {
    packagePaidOrders: number;
    allPaidOrders: number;
    ratePercent: number;
    description: string;
  };
  inviteDelivery: {
    inviteCreated: number;
    paidOrders: number;
    successRatePercent: number;
    description: string;
  };
  supportAndRefund: {
    refundedPaidOrders: number;
    openTickets: number;
    ratioPercent: number;
    description: string;
  };
};

export type AdminDashboardPeriod = {
  startsAt: string;
  endsAt: string;
  asOf: string;
  label: string;
};

export type AdminDashboardStage2Readiness = {
  stablePaidMembershipThreshold: number;
  monthlyGmvUsdtThreshold: number;
  note: string;
};

export type AdminDashboardSummary = {
  period: AdminDashboardPeriod;
  cards: AdminDashboardCards;
  stage2Readiness: AdminDashboardStage2Readiness;
};
