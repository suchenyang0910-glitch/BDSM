import React from "react";
import {
  Card,
  Typography,
  Tag,
  Space,
  Button,
  Table,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  message,
  Modal,
  DatePicker,
  Alert,
  Tooltip,
  Segmented,
  Upload,
  Progress,
  Checkbox,
  Tabs,
  Badge,
} from "antd";
import type { UploadProps } from "antd";
import {
  PlusOutlined,
  EditOutlined,
  SendOutlined,
  UpCircleOutlined,
  DownCircleOutlined,
  InfoCircleOutlined,
  UploadOutlined,
  ReloadOutlined,
  CloseCircleOutlined,
  CheckCircleTwoTone,
  ExclamationCircleTwoTone,
  ClockCircleOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import http, {
  listAdminContents,
  getAdminContent,
  createAdminContent,
  updateAdminContent,
  submitContentForReview,
  publishAdminContent,
  unpublishAdminContent,
  listAdminCategories,
  listAdminPackages,
  adminMe,
  listFreeChannels,
  startAdminTelegramPublish,
  errMsg,
} from "../api/client";
import type {
  ContentItem,
  ContentStatus,
  CategoryItem,
  AdminMe,
  AdminPackageItem,
  FreeChannelOption,
} from "../api/types";

const { Title, Text } = Typography;
const { TextArea } = Input;
const { Option } = Select;

// ================== 新增类型：素材 & 发布任务 ==================
export type MediaAssetKind = "cover_image" | "preview_video" | "full_video";
export type MediaAssetStatus = "pending_upload" | "uploading" | "ready" | "failed" | "deleted";

export type MediaAssetItem = {
  id: string;
  kind: MediaAssetKind;
  originalFilename: string;
  mimeType: string;
  contentLength: number;
  status: MediaAssetStatus;
  storagePublicUrl?: string | null;
  durationSeconds?: number | null;
  widthPixels?: number | null;
  heightPixels?: number | null;
  hasWatermark?: boolean | null;
  lastErrorClass?: string | null;
  lastErrorNote?: string | null;
  lastVerifiedAt?: string | null;
  createdAt?: string;
};

export type TelegramPublishJobStatus =
  | "queued" | "processing" | "sent" | "failed"
  | "retried_exhausted" | "cancelled" | "race_locked_by_another_worker";

export type TelegramPublishJobItem = {
  id: string;
  contentId: string;
  packageId?: string | null;
  channelKind: "public_free_preview" | "membership_full" | "package_full";
  targetFreeChannelCode?: string | null;
  targetChatMasked?: string | null;
  status: TelegramPublishJobStatus;
  attempt: number;
  maxAttempts: number;
  telegramMessageId?: string | null;
  telegramMethod?: string | null;
  lastErrorClass?: string | null;
  lastErrorNote?: string | null;
  lastAttemptedAt?: string | null;
  nextRetryAt?: string | null;
  sentAt?: string | null;
  cancelledAt?: string | null;
  createdAt: string;
  mediaAsset?: MediaAssetItem | null;
  admin?: { id: string; displayName?: string | null; email?: string } | null;
  cancelledByAdmin?: { id: string; displayName?: string | null; email?: string } | null;
};

export type ChannelMessageItem = {
  id: string;
  managedChannelId: string;
  channelLabel: string;
  channelPurpose: "free_preview" | "membership_main" | "package_channel" | "none";
  packageId?: string | null;
  mediaKind: "video" | "photo" | "document" | "text";
  postedAt?: string | null;
  associationStatus: "unlinked" | "linked" | string;
  contentId?: string | null;
  linkedAt?: string | null;
  messageIdMasked?: string | null;
};

// ================== 新增素材 & 发布 API 封装 ==================
type InitMediaUploadReq = {
  kind: MediaAssetKind;
  originalFilename: string;
  mimeType: string;
  contentLength: number;
  expectedChecksumSha256?: string | null;
};
type InitMediaUploadResp = {
  ok: true;
  mediaAsset: MediaAssetItem;
  uploadUrl: string;
  expectedHttpHeaders: Record<string, string>;
};
type CompleteMediaUploadReq = { ok: boolean; reportedLength?: number | null; etag?: string | null; errorNote?: string | null };
type StartTelegramPublishReq = { channelKinds: Array<"public_free_preview" | "membership_full" | "package_full">; telegramTags?: string[]; reason?: string };
type StartTelegramPublishResp = { ok: true; jobs: Array<{ id: string; channelKind: string; status: string; jobToken: string; mediaAssetId: string | null; targetFreeChannelCode: string | null; createdAt: string }>; normalizedTelegramTags?: string[] };

export async function initMediaUpload(req: InitMediaUploadReq): Promise<InitMediaUploadResp> {
  const res = await http.post("/admin/media/init-upload", req, { timeout: 20_000 });
  return res.data;
}
export async function completeMediaUpload(id: string, req: CompleteMediaUploadReq): Promise<{ ok: true; mediaAsset: MediaAssetItem }> {
  const res = await http.post(`/admin/media/${encodeURIComponent(id)}/complete`, req, { timeout: 30_000 });
  return res.data;
}
export async function getMediaAsset(id: string): Promise<{ ok: true; mediaAsset: MediaAssetItem }> {
  const res = await http.get(`/admin/media/${encodeURIComponent(id)}`);
  return res.data;
}
export async function startTelegramPublish(contentId: string, req: StartTelegramPublishReq): Promise<StartTelegramPublishResp> {
  return startAdminTelegramPublish(contentId, req as any);
}
export async function listTelegramPublishJobs(contentId: string): Promise<{ ok: true; items: TelegramPublishJobItem[] }> {
  const res = await http.get(`/admin/contents/${encodeURIComponent(contentId)}/publish-jobs`);
  return res.data;
}
export async function cancelTelegramPublishJob(jobId: string, reason?: string): Promise<{ ok: true; id: string; status: TelegramPublishJobStatus; cancelledAt?: string }> {
  const res = await http.post(`/admin/telegram-publish-jobs/${encodeURIComponent(jobId)}/cancel`, { reason: reason || "运营手动取消" });
  return res.data;
}
export async function listLinkableChannelMessages(contentId: string): Promise<{ contentId: string; accessType: string; currentLink: ChannelMessageItem | null; items: ChannelMessageItem[] }> {
  const res = await http.get(`/admin/contents/${encodeURIComponent(contentId)}/linkable-channel-messages`);
  return res.data;
}
export async function linkContentChannelMessage(contentId: string, channelMessageId: string, reason?: string): Promise<{ ok: true; contentId: string; messageKind: string; postedAt?: string | null; channelLabel: string; status: string; currentLink: ChannelMessageItem }> {
  const res = await http.post(`/admin/contents/${encodeURIComponent(contentId)}/link-channel-message`, { channelMessageId, reason });
  return res.data;
}
export async function unlinkContentChannelMessage(contentId: string, reason?: string): Promise<{ ok: true; contentId: string; status: string }> {
  const res = await http.post(`/admin/contents/${encodeURIComponent(contentId)}/unlink-channel-message`, { reason });
  return res.data;
}

const CHANNEL_KIND_LABEL: Record<TelegramPublishJobItem["channelKind"], { label: string; color: string }> = {
  public_free_preview: { label: "免费频道试看", color: "blue" },
  membership_full: { label: "会员主频道完整", color: "purple" },
  package_full: { label: "内容包独立频道完整", color: "geekblue" },
};

const PUBLISH_JOB_STATUS_TAG: Record<TelegramPublishJobStatus, { label: string; color: string }> = {
  queued: { label: "排队中", color: "default" },
  processing: { label: "发送中", color: "processing" },
  sent: { label: "已发送", color: "green" },
  failed: { label: "失败（可重试）", color: "orange" },
  retried_exhausted: { label: "重试耗尽", color: "red" },
  cancelled: { label: "已取消", color: "grey" },
  race_locked_by_another_worker: { label: "并发锁冲突（稍后重试）", color: "warning" },
};

const STATUS_TAG: Record<ContentStatus, { color: string; label: string }> = {
  draft: { color: "default", label: "草稿" },
  in_review: { color: "processing", label: "审核中" },
  scheduled: { color: "geekblue", label: "定时发布" },
  published: { color: "green", label: "已发布" },
  archived: { color: "grey", label: "归档" },
};

const ACCESS_TYPE_OPTIONS = [
  { value: "public", label: "公开免费" },
  { value: "membership", label: "会员专享" },
  { value: "package", label: "打包内含" },
];

type AccessTypeForSelect = "public" | "membership" | "package" | "single";
type OpsTagFilter = "recommended" | "featured" | "new" | undefined;

const ContentsPage: React.FC = () => {
  const [rows, setRows] = React.useState<ContentItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);
  const [statusFilter, setStatusFilter] = React.useState<ContentStatus | undefined>();
  const [accessTypeFilter, setAccessTypeFilter] = React.useState<string | undefined>();
  const [opsTagFilter, setOpsTagFilter] = React.useState<OpsTagFilter>();
  const [q, setQ] = React.useState("");

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ContentItem | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = React.useState(false);

  const [categories, setCategories] = React.useState<CategoryItem[]>([]);
  const [packages, setPackages] = React.useState<AdminPackageItem[]>([]);
  const [freeChannels, setFreeChannels] = React.useState<FreeChannelOption[]>([]);
  const [me, setMe] = React.useState<AdminMe | null>(null);
  const [publishingTg, setPublishingTg] = React.useState(false);

  // ================== 素材上传 state ==================
  const [coverAssetId, setCoverAssetId] = React.useState<string | null>(null);
  const [coverAsset, setCoverAsset] = React.useState<MediaAssetItem | null>(null);
  const [coverProgress, setCoverProgress] = React.useState<number>(0);
  const [coverUploading, setCoverUploading] = React.useState(false);

  const [previewAssetId, setPreviewAssetId] = React.useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = React.useState<MediaAssetItem | null>(null);
  const [previewProgress, setPreviewProgress] = React.useState<number>(0);
  const [previewUploading, setPreviewUploading] = React.useState(false);

  const [fullVideoAssetId, setFullVideoAssetId] = React.useState<string | null>(null);
  const [fullVideoAsset, setFullVideoAsset] = React.useState<MediaAssetItem | null>(null);
  const [fullVideoProgress, setFullVideoProgress] = React.useState<number>(0);
  const [fullVideoUploading, setFullVideoUploading] = React.useState(false);

  // ================== 发布任务 state ==================
  const [channelKinds, setChannelKinds] = React.useState<Array<TelegramPublishJobItem["channelKind"]>>([]);
  const [publishJobs, setPublishJobs] = React.useState<TelegramPublishJobItem[]>([]);
  const [publishJobsLoading, setPublishJobsLoading] = React.useState(false);
  const [startPublishing, setStartPublishing] = React.useState(false);
  const [publishJobsRefreshTimer, setPublishJobsRefreshTimer] = React.useState<number | null>(null);
  const [channelMessages, setChannelMessages] = React.useState<ChannelMessageItem[]>([]);
  const [currentChannelLink, setCurrentChannelLink] = React.useState<ChannelMessageItem | null>(null);
  const [channelMessagesLoading, setChannelMessagesLoading] = React.useState(false);
  const [linkingChannelMessageId, setLinkingChannelMessageId] = React.useState<string | null>(null);

  const fetchList = React.useCallback(async () => {
    setLoading(true);
    try {
      const resp = await listAdminContents({
        page,
        limit: pageSize,
        status: statusFilter,
        accessType: accessTypeFilter,
        q: q || undefined,
      });
      // 兼容历史内容：早期记录可能没有 categories/tags 字段，不能让一条旧数据导致整个列表页白屏。
      const normalizedRows = Array.isArray(resp.data)
        ? resp.data.map((row: ContentItem) => ({
            ...row,
            categories: Array.isArray(row.categories) ? row.categories : [],
            tags: Array.isArray(row.tags) ? row.tags : [],
          }))
        : [];
      setRows(normalizedRows);
      setTotal(resp.total);
    } catch (e) {
      message.error(errMsg(e, "加载内容列表失败"));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter, accessTypeFilter, q]);

  React.useEffect(() => {
    fetchList();
  }, [fetchList]);

  React.useEffect(() => {
    listAdminCategories().then((r) => setCategories(r.data)).catch(() => {});
    listAdminPackages().then((r) => setPackages(r.data)).catch(() => {});
    listFreeChannels().then((r) => setFreeChannels(Array.isArray(r.items) ? r.items : [])).catch(() => {});
    adminMe().then(setMe).catch(() => {});
  }, []);

  const accessTypeValue = Form.useWatch("accessType", form);
  const packageIdValue = Form.useWatch("packageId", form);
  const freeChannelCodeValue = Form.useWatch("freeChannelCode", form);

  const selectedPackage = React.useMemo(
    () => packages.find((p) => p.id === packageIdValue) || null,
    [packages, packageIdValue],
  );

  const publishablePackages = React.useMemo(
    () => packages.filter((p) => p.status === "published" && p.channelConfigured && p.productActive),
    [packages],
  );

  const canPublish = React.useMemo(() => {
    if (!me) return false;
    return ["super_admin", "editor"].includes(me.role);
  }, [me]);

  const canEdit = React.useMemo(() => {
    if (!me) return false;
    return ["super_admin", "operator", "editor"].includes(me.role);
  }, [me]);

  const displayRows = React.useMemo(() => {
    if (!opsTagFilter) return rows;
    return rows.filter((r) => {
      if (opsTagFilter === "recommended") return r.isRecommended;
      if (opsTagFilter === "featured") return r.isFeatured;
      if (opsTagFilter === "new") return r.isNewArrival;
      return true;
    });
  }, [rows, opsTagFilter]);

  const prePublishChecklist = React.useMemo(() => {
    const title: string | undefined = form.getFieldValue("title");
    const categoryIds: string[] | undefined = form.getFieldValue("categoryIds");
    const durationSeconds: number | undefined = form.getFieldValue("durationSeconds");
    const checks: Array<{ key: string; label: string; passed: boolean; detail?: string }> = [];
    checks.push({
      key: "title",
      label: "标题已填",
      passed: !!(title && title.trim().length > 0),
      detail: !title ? "请输入 1-200 字的标题" : undefined,
    });
    checks.push({
      key: "accessType",
      label: "访问类型合法",
      passed: accessTypeValue === "public" || accessTypeValue === "membership" || accessTypeValue === "package",
      detail: accessTypeValue === "single" ? "single（单篇购买）首期不支持，需改为 membership 或 package" : undefined,
    });
    checks.push({
      key: "categories",
      label: "已关联分类",
      passed: Array.isArray(categoryIds) && categoryIds.length > 0,
      detail: "建议至少关联 1 个分类，保证 Mini App 列表可见",
    });
    checks.push({
      key: "duration",
      label: "内容时长已填",
      passed: typeof durationSeconds === "number" && durationSeconds > 0,
      detail: "时长将在列表展示为「X分Y秒」",
    });
    if (accessTypeValue === "public") {
      const fccOk =
        typeof freeChannelCodeValue === "string" &&
        freeChannelCodeValue.length > 0 &&
        freeChannels.some((f) => f.code === freeChannelCodeValue);
      checks.push({
        key: "freeChannelCode",
        label: "公开内容已选择免费频道",
        passed: fccOk,
        detail: !freeChannelCodeValue
          ? "请选择免费频道白名单（由服务端受控，不可自填）"
          : !freeChannels.some((f) => f.code === freeChannelCodeValue)
            ? "所选 freeChannelCode 不在当前白名单中，请刷新或更换"
            : undefined,
      });
    }
    if (accessTypeValue === "package") {
      const pkgOk =
        !!selectedPackage &&
        selectedPackage.status === "published" &&
        selectedPackage.channelConfigured &&
        selectedPackage.productActive;
      checks.push({
        key: "pkg",
        label: "已绑定可交付内容包",
        passed: pkgOk,
        detail: !selectedPackage
          ? "请选择内容包；需满足：已发布 + 已配置受控频道 + 对应商品已启用"
          : `当前包 ${selectedPackage.title}：status=${selectedPackage.status} / channelConfigured=${selectedPackage.channelConfigured} / productActive=${selectedPackage.productActive}`,
      });
    }
    return checks;
  }, [accessTypeValue, selectedPackage, form, freeChannelCodeValue, freeChannels]);

  const prePublishAllPassed = React.useMemo(
    () => prePublishChecklist.every((c) => c.passed),
    [prePublishChecklist],
  );

  // 刷新内容发布任务列表
  const refreshPublishJobs = React.useCallback(async (contentId: string) => {
    try {
      setPublishJobsLoading(true);
      const r = await listTelegramPublishJobs(contentId);
      setPublishJobs(r.items || []);
    } catch (e) {
      // 失败不阻挡操作
      setPublishJobs([]);
    } finally {
      setPublishJobsLoading(false);
    }
  }, []);

  const refreshChannelMessages = React.useCallback(async (contentId: string) => {
    try {
      setChannelMessagesLoading(true);
      const r = await listLinkableChannelMessages(contentId);
      setCurrentChannelLink(r.currentLink || null);
      setChannelMessages(Array.isArray(r.items) ? r.items : []);
    } catch {
      setCurrentChannelLink(null);
      setChannelMessages([]);
    } finally {
      setChannelMessagesLoading(false);
    }
  }, []);

  // Drawer 打开后启动定时刷新 publish-jobs（后台异步发送任务 8s 轮询一次 UI）
  React.useEffect(() => {
    if (drawerOpen && editing?.id) {
      refreshPublishJobs(editing.id);
      refreshChannelMessages(editing.id);
      if (publishJobsRefreshTimer) window.clearInterval(publishJobsRefreshTimer);
      const timer = window.setInterval(() => {
        refreshPublishJobs(editing.id);
      }, 8000);
      setPublishJobsRefreshTimer(timer);
    } else {
      if (publishJobsRefreshTimer) {
        window.clearInterval(publishJobsRefreshTimer);
        setPublishJobsRefreshTimer(null);
      }
      setPublishJobs([]);
      setChannelMessages([]);
      setCurrentChannelLink(null);
    }
    return () => {
      if (publishJobsRefreshTimer) {
        window.clearInterval(publishJobsRefreshTimer);
      }
    };
  }, [drawerOpen, editing?.id, refreshPublishJobs, refreshChannelMessages]);

  const resetMediaState = React.useCallback(() => {
    setCoverAssetId(null); setCoverAsset(null); setCoverProgress(0); setCoverUploading(false);
    setPreviewAssetId(null); setPreviewAsset(null); setPreviewProgress(0); setPreviewUploading(false);
    setFullVideoAssetId(null); setFullVideoAsset(null); setFullVideoProgress(0); setFullVideoUploading(false);
  }, []);

  const openCreate = () => {
    setEditing(null);
    setChannelKinds([]);
    resetMediaState();
    form.resetFields();
    setCurrentChannelLink(null);
    setChannelMessages([]);
    form.setFieldsValue({
      accessType: "public" as AccessTypeForSelect,
      status: "draft",
      sortOrder: 0,
      isRecommended: false,
      isFeatured: false,
      isNewArrival: false,
      tags: [],
      seoKeywords: [],
      geoKeywords: [],
      telegramTags: [],
      categoryIds: [],
      freeChannelCode: freeChannels[0]?.code ?? null,
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: ContentItem) => {
    setEditing(row);
    resetMediaState();
    setChannelKinds([]);
    setCurrentChannelLink(null);
    setChannelMessages([]);
    // 默认勾选与 accessType 匹配的 channel kinds
    const defaultKinds: Array<TelegramPublishJobItem["channelKind"]> = [];
    if (row.accessType === "public") defaultKinds.push("public_free_preview");
    if (row.accessType === "membership") { defaultKinds.push("public_free_preview"); defaultKinds.push("membership_full"); }
    if (row.accessType === "package") { defaultKinds.push("public_free_preview"); defaultKinds.push("package_full"); }
    setChannelKinds(defaultKinds);
    form.setFieldsValue({
      title: row.title,
      description: row.description,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      seoKeywords: row.seoKeywords || [],
      geoKeywords: row.geoKeywords || [],
      coverUrl: row.coverUrl,
      thumbnailUrl: row.thumbnailUrl,
      previewUrl: row.previewUrl,
      durationSeconds: row.durationSeconds,
      accessType: row.accessType as AccessTypeForSelect,
      sortOrder: row.sortOrder,
      isRecommended: row.isRecommended,
      isFeatured: row.isFeatured,
      isNewArrival: row.isNewArrival,
      featuredSort: row.featuredSort,
      tags: row.tags,
      categoryIds: (Array.isArray(row.categories) ? row.categories : []).map((c) => c.id),
      recommendStartsAt: row.recommendStartsAt ? dayjs(row.recommendStartsAt) : null,
      recommendEndsAt: row.recommendEndsAt ? dayjs(row.recommendEndsAt) : null,
      scheduledAt: row.scheduledAt ? dayjs(row.scheduledAt) : null,
      productId: row.productId,
      packageId: row.packageId,
      freeChannelCode: row.freeChannelCode,
      telegramTags: [],
    });
    // 拉取素材 FK 关联（若服务端返回了 coverAsset/previewAsset/fullVideoAsset，后续 getAdminContent 可能补充；这里先简单只拿已存在 FK，若已建 assetId，则刷新状态）
    const rawAny = row as any;
    const caId = rawAny.coverAssetId || rawAny.cover_asset_id || null;
    const paId = rawAny.previewAssetId || rawAny.preview_asset_id || null;
    const faId = rawAny.fullVideoAssetId || rawAny.full_video_asset_id || null;
    if (caId) { setCoverAssetId(caId); getMediaAsset(caId).then(r => setCoverAsset(r.mediaAsset)).catch(() => {}); }
    if (paId) { setPreviewAssetId(paId); getMediaAsset(paId).then(r => setPreviewAsset(r.mediaAsset)).catch(() => {}); }
    if (faId) { setFullVideoAssetId(faId); getMediaAsset(faId).then(r => setFullVideoAsset(r.mediaAsset)).catch(() => {}); }
    setDrawerOpen(true);
  };

  // ================== 自定义：浏览器直传对象存储（不经过 Web 服务器） ==================
  const doDirectUpload = React.useCallback(async (
    file: File,
    kind: MediaAssetKind,
    setters: {
      setAssetId: (id: string | null) => void;
      setAsset: (a: MediaAssetItem | null) => void;
      setProgress: (n: number) => void;
      setUploading: (b: boolean) => void;
    },
    hardMaxBytes: number,
  ) => {
    if (!canEdit) {
      message.error("当前角色无 content:edit 权限，不能上传素材");
      return Upload.LIST_IGNORE;
    }
    if (file.size > hardMaxBytes) {
      const mb = hardMaxBytes >= 1024 * 1024 * 1024 ? `${(hardMaxBytes / 1024 / 1024 / 1024).toFixed(1)}GB` : `${Math.round(hardMaxBytes / 1024 / 1024)}MB`;
      message.error(`文件超过最大限制（${mb}）`);
      return Upload.LIST_IGNORE;
    }
    setters.setProgress(0);
    setters.setUploading(true);
    try {
      // Step 1: init-upload 拿预签名 PUT URL + 事务内写 mediaAsset
      const init = await initMediaUpload({
        kind,
        originalFilename: file.name,
        mimeType: file.type || "application/octet-stream",
        contentLength: file.size,
      });
      setters.setAssetId(init.mediaAsset.id);
      setters.setAsset(init.mediaAsset);
      // Step 2: XHR PUT 到对象存储（支持 onprogress）
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", init.uploadUrl, true);
        Object.entries(init.expectedHttpHeaders || {}).forEach(([k, v]) => {
          try { xhr.setRequestHeader(k, v); } catch {}
        });
        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable && evt.total > 0) {
            setters.setProgress(Math.min(99, Math.round((evt.loaded / evt.total) * 100)));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { resolve(); }
          else { reject(new Error(`HTTP ${xhr.status} ${xhr.statusText || ""}`)); }
        };
        xhr.onerror = () => reject(new Error("网络错误：上传到对象存储失败"));
        xhr.onabort = () => reject(new Error("上传已取消"));
        xhr.send(file);
      });
      setters.setProgress(100);
      // Step 3: 调 complete 让服务端 HeadObject 校验
      const comp = await completeMediaUpload(init.mediaAsset.id, { ok: true, reportedLength: file.size, etag: "" });
      setters.setAsset(comp.mediaAsset);
      if (comp.mediaAsset.status !== "ready") {
        message.error(`对象存储校验失败：${comp.mediaAsset.lastErrorClass || comp.mediaAsset.status}${comp.mediaAsset.lastErrorNote ? `（${comp.mediaAsset.lastErrorNote}）` : ""}`);
      } else {
        message.success(`${kind === "cover_image" ? "封面" : kind === "preview_video" ? "试看视频" : "完整视频"}上传完成`);
      }
    } catch (e) {
      setters.setProgress(0);
      const id = coverAssetId || previewAssetId || fullVideoAssetId;
      if (id) {
        try {
          const comp = await completeMediaUpload(id, { ok: false, errorNote: e instanceof Error ? e.message.slice(0, 180) : "upload_aborted" });
          setters.setAsset(comp.mediaAsset);
        } catch {}
      }
      message.error(errMsg(e, kind === "cover_image" ? "封面上传失败" : kind === "preview_video" ? "试看上传失败" : "完整视频上传失败"));
    } finally {
      setters.setUploading(false);
    }
    return Upload.LIST_IGNORE;
  }, [canEdit, coverAssetId, previewAssetId, fullVideoAssetId]);

  const onDrawerSubmit = async () => {
    try {
      const values = await form.validateFields();
      const at: AccessTypeForSelect = values.accessType;
      if (at === "single") {
        message.error("单篇购买（single）首期不支持新建或编辑，请改为会员专享或内容包内含");
        return;
      }
      setSubmitting(true);
      const payload: any = {
        ...values,
        tags: values.tags || [],
        seoKeywords: values.seoKeywords || [],
        geoKeywords: values.geoKeywords || [],
        categoryIds: values.categoryIds || [],
        recommendStartsAt: values.recommendStartsAt ? values.recommendStartsAt.toISOString() : null,
        recommendEndsAt: values.recommendEndsAt ? values.recommendEndsAt.toISOString() : null,
        scheduledAt: values.scheduledAt ? values.scheduledAt.toISOString() : null,
        coverAssetId: coverAssetId ?? undefined,
        previewAssetId: previewAssetId ?? undefined,
        fullVideoAssetId: fullVideoAssetId ?? undefined,
        reason: editing ? `编辑内容：${editing.title}` : `新建内容：${values.title}`,
      };
      if (editing) {
        await updateAdminContent(editing.id, payload);
        message.success("内容已更新");
        const refreshed = await getAdminContent(editing.id);
        setEditing(refreshed);
        refreshPublishJobs(editing.id);
      } else {
        await createAdminContent(payload);
        message.success("内容已创建");
      }
      setDrawerOpen(false);
      fetchList();
    } catch (e) {
      message.error(errMsg(e, editing ? "更新失败" : "创建失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const onLinkChannelMessage = async (row: ChannelMessageItem) => {
    if (!editing?.id) return;
    try {
      setPublishingTg(true);
      setLinkingChannelMessageId(row.id);
      const result = await linkContentChannelMessage(editing.id, row.id, `后台关联频道消息：${row.channelLabel} ${row.messageIdMasked || ""}`.trim());
      message.success(`已关联频道消息：${result.channelLabel}`);
      await refreshChannelMessages(editing.id);
      const refreshed = await getAdminContent(editing.id);
      setEditing(refreshed);
      fetchList();
    } catch (e) {
      message.error(errMsg(e, "关联频道消息失败"));
    } finally {
      setPublishingTg(false);
      setLinkingChannelMessageId(null);
    }
  };

  const onUnlinkChannelMessage = async () => {
    if (!editing?.id) return;
    Modal.confirm({
      title: "解除频道消息关联",
      content: "解除后该内容卡将失去当前 Telegram 交付消息映射；如需更换消息，请先解除再重新关联。",
      okText: "确认解除",
      cancelText: "取消",
      onOk: async () => {
        try {
          setPublishingTg(true);
          await unlinkContentChannelMessage(editing.id, "后台手动解除频道消息关联");
          message.success("已解除关联");
          await refreshChannelMessages(editing.id);
          const refreshed = await getAdminContent(editing.id);
          setEditing(refreshed);
          fetchList();
        } catch (e) {
          message.error(errMsg(e, "解除关联失败"));
        } finally {
          setPublishingTg(false);
        }
      },
    });
  };

  const currentChannelLinkCard = React.useMemo(() => {
    if (!currentChannelLink) return null;
    return (
      <Alert
        type="success"
        showIcon
        message={`已关联 · ${currentChannelLink.channelLabel}`}
        description={
          <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
            <span>· 媒体类型：{currentChannelLink.mediaKind}</span>
            {currentChannelLink.messageIdMasked && <span>· 消息号：{currentChannelLink.messageIdMasked}</span>}
            {currentChannelLink.postedAt && <span>· 发布时间：{dayjs(currentChannelLink.postedAt).format("YYYY-MM-DD HH:mm:ss")}</span>}
            {currentChannelLink.linkedAt && <span>· 关联时间：{dayjs(currentChannelLink.linkedAt).format("YYYY-MM-DD HH:mm:ss")}</span>}
          </Space>
        }
      />
    );
  }, [currentChannelLink]);

  const confirmSubmitReview = (row: ContentItem) => {
    Modal.confirm({
      title: "提交审核",
      content: `确定将「${row.title}」提交审核？提交后状态变更为「审核中」，需 editor 或超管发布。`,
      okText: "提交",
      cancelText: "取消",
      onOk: async () => {
        try {
          await submitContentForReview(row.id, "管理员提交审核");
          message.success("已提交审核");
          fetchList();
        } catch (e) {
          message.error(errMsg(e, "提交审核失败"));
        }
      },
    });
  };

  const confirmPublish = (row: ContentItem) => {
    const extraWarnings: string[] = [];
    if (row.accessType === "single") {
      extraWarnings.push("· 该内容为 single（单篇购买），首期已禁止发布此类型");
    }
    if (row.accessType === "package") {
      if (!row.packageId) extraWarnings.push("· package 类型未绑定内容包");
    }
    Modal.confirm({
      title: "发布内容",
      content: (
        <Space direction="vertical" size={12}>
          <span>确定发布「{row.title}」？发布后 Mini App 用户立即可见。</span>
          {extraWarnings.length > 0 && (
            <Alert type="error" showIcon message="发布前检查未通过" description={extraWarnings.map((t, i) => <div key={i}>{t}</div>)} />
          )}
        </Space>
      ),
      okText: "发布",
      okButtonProps: { danger: true, disabled: extraWarnings.length > 0 },
      cancelText: "取消",
      onOk: async () => {
        if (extraWarnings.length > 0) return;
        try {
          await publishAdminContent(row.id, "管理员发布内容");
          message.success("已发布");
          fetchList();
        } catch (e) {
          message.error(errMsg(e, "发布失败"));
        }
      },
    });
  };

  const confirmUnpublish = (row: ContentItem) => {
    Modal.confirm({
      title: "下架内容",
      content: `确定下架「${row.title}」？下架后 Mini App 用户不再可见。`,
      okText: "下架",
      cancelText: "取消",
      onOk: async () => {
        try {
          await unpublishAdminContent(row.id, "管理员下架内容");
          message.success("已下架");
          fetchList();
        } catch (e) {
          message.error(errMsg(e, "下架失败"));
        }
      },
    });
  };

  const renderAccessTypeTag = (v: string) => {
    if (v === "single") {
      return <Tag color="red">单篇购买 · 旧数据（不支持新建）</Tag>;
    }
    const m = ACCESS_TYPE_OPTIONS.find((o) => o.value === v);
    return <Tag color="blue">{m ? m.label : v}</Tag>;
  };

  const renderPackageConfigBadge = () => {
    if (accessTypeValue !== "package") return null;
    if (!packageIdValue) {
      return <Alert type="warning" showIcon icon={<InfoCircleOutlined />} message="请选择所属内容包（必填）" />;
    }
    if (!selectedPackage) {
      return <Alert type="error" showIcon message="内容包不存在" />;
    }
    const issues: string[] = [];
    if (selectedPackage.status !== "published") issues.push("· 内容包未发布");
    if (!selectedPackage.channelConfigured) issues.push("· 内容包未配置交付频道（需服务端完成受控映射）");
    if (!selectedPackage.productActive) issues.push("· 内容包对应商品未启用");
    if (issues.length === 0) {
      return <Alert type="success" showIcon message={`已绑定：${selectedPackage.title}（可交付）`} />;
    }
    return <Alert type="error" showIcon message={`${selectedPackage.title} 暂不可交付`} description={issues.map((t, i) => <div key={i}>{t}</div>)} />;
  };

  const columns: ColumnsType<ContentItem> = [
    {
      title: "标题",
      dataIndex: "title",
      key: "title",
      width: 240,
      render: (t: string, r) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 500 }}>{t}</span>
          {r.description && (
            <span style={{ color: "#999", fontSize: 12 }}>{r.description.slice(0, 40)}{r.description.length > 40 ? "…" : ""}</span>
          )}
        </Space>
      ),
    },
    {
      title: "分类",
      dataIndex: "categories",
      key: "categories",
      width: 160,
      render: (cats: CategoryItem[] | undefined) => {
        const safeCategories = Array.isArray(cats) ? cats : [];
        return (
        <Space size={4} wrap>
          {safeCategories.length === 0 ? (
            <Tag color="default">未分类</Tag>
          ) : (
            safeCategories.map((c) => <Tag key={c.id} color="blue">{c.name}</Tag>)
          )}
        </Space>
        );
      },
    },
    {
      title: "访问类型",
      dataIndex: "accessType",
      key: "accessType",
      width: 180,
      render: (v: string) => renderAccessTypeTag(v),
    },
    {
      title: "关联包/商品",
      key: "refs",
      width: 220,
      render: (_: any, r) => (
        <Space size={4} wrap>
          {r.package?.title && <Tag color="geekblue">包：{r.package.title}</Tag>}
          {r.product?.title && <Tag color="purple">商品：{r.product.title}</Tag>}
          {!r.package?.title && !r.product?.title && r.accessType !== "public" && <Tag color="default">未绑定</Tag>}
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (s: ContentStatus) => (
        <Tag color={STATUS_TAG[s]?.color || "default"}>{STATUS_TAG[s]?.label || s}</Tag>
      ),
    },
    {
      title: "时长",
      dataIndex: "durationSeconds",
      key: "durationSeconds",
      width: 90,
      render: (s: number | null) => {
        if (!s) return "-";
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}分${r > 0 ? `${r}秒` : ""}`;
      },
    },
    { title: "排序", dataIndex: "sortOrder", key: "sortOrder", width: 70 },
    {
      title: "运营标签",
      key: "tags",
      width: 160,
      render: (_: any, r) => (
        <Space size={4} wrap>
          {r.isRecommended && <Tag color="geekblue">推荐</Tag>}
          {r.isFeatured && <Tag color="purple">精选</Tag>}
          {r.isNewArrival && <Tag color="gold">新品</Tag>}
        </Space>
      ),
    },
    {
      title: "发布/更新",
      key: "time",
      width: 160,
      render: (_: any, r) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          <span>{r.publishedAt ? dayjs(r.publishedAt).format("YYYY-MM-DD HH:mm") : "-"}</span>
          <span style={{ color: "#999" }}>{dayjs(r.updatedAt).format("MM-DD HH:mm")}</span>
        </Space>
      ),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 260,
      render: (_: any, r) => (
        <Space size={4} wrap>
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={!canEdit || r.accessType === "single"}
            onClick={() => openEdit(r)}
          >
            编辑
          </Button>
          {r.accessType === "single" && (
            <Tooltip title="single 类型首期不支持，请修改 accessType 为 membership 或 package">
              <Tag color="red">已锁定</Tag>
            </Tooltip>
          )}
          {r.status === "draft" && canEdit && r.accessType !== "single" && (
            <Button
              size="small"
              icon={<SendOutlined />}
              onClick={() => confirmSubmitReview(r)}
            >
              提交审核
            </Button>
          )}
          {(r.status === "draft" || r.status === "in_review" || r.status === "scheduled") && canPublish && r.accessType !== "single" && (
            <Button
              size="small"
              type="primary"
              icon={<UpCircleOutlined />}
              onClick={() => confirmPublish(r)}
            >
              发布
            </Button>
          )}
          {r.status === "published" && canPublish && (
            <Button
              size="small"
              danger
              icon={<DownCircleOutlined />}
              onClick={() => confirmUnpublish(r)}
            >
              下架
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        message="内容交付说明（阶段一）"
        description={
          <Space direction="vertical" size={4}>
            <span>· 完整视频由运营手工发布到 Telegram 私密频道，后台只维护内容卡、分类和权益。</span>
            <span>· 会员内容 → 统一交付至服务端配置的 VIP 会员频道；内容包内容 → 交付到对应包的受控频道；公开内容 → 预览 URL 展示。</span>
            <span>· 单条售卖（single）首期关闭，避免共享频道造成权益越界。</span>
          </Space>
        }
      />

      <Card
        title={<Title level={5} style={{ margin: 0 }}>内容列表</Title>}
        extra={
          <Space wrap>
            <Input.Search
              placeholder="搜索标题/描述"
              allowClear
              style={{ width: 220 }}
              onSearch={(v) => { setQ(v); setPage(1); }}
            />
            <Select
              placeholder="状态筛选"
              allowClear
              style={{ width: 140 }}
              value={statusFilter}
              onChange={(v) => { setStatusFilter(v); setPage(1); }}
            >
              {Object.entries(STATUS_TAG).map(([k, v]) => (
                <Option key={k} value={k}>{v.label}</Option>
              ))}
            </Select>
            <Select
              placeholder="访问类型筛选"
              allowClear
              style={{ width: 180 }}
              value={accessTypeFilter}
              onChange={(v) => { setAccessTypeFilter(v); setPage(1); }}
            >
              {ACCESS_TYPE_OPTIONS.map((o) => (
                <Option key={o.value} value={o.value}>{o.label}</Option>
              ))}
              <Option value="single">单篇购买 · 旧数据</Option>
            </Select>
            <Segmented<OpsTagFilter>
              options={[
                { label: "全部标签", value: undefined },
                { label: "推荐", value: "recommended" },
                { label: "精选", value: "featured" },
                { label: "新品", value: "new" },
              ]}
              value={opsTagFilter}
              onChange={(v) => setOpsTagFilter(v)}
            />
            <Button icon={<PlusOutlined />} type="primary" onClick={openCreate} disabled={!canEdit}>
              新建内容
            </Button>
          </Space>
        }
      >
        <Table<ContentItem>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={displayRows}
          pagination={{
            current: page,
            pageSize,
            total: opsTagFilter ? displayRows.length : total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条${opsTagFilter ? `（后台原始 ${total} 条，当前按运营标签筛选）` : ""}`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
        />
      </Card>

      <Drawer
        title={editing ? `编辑内容：${editing.title}` : "新建内容"}
        open={drawerOpen}
        onClose={() => !submitting && setDrawerOpen(false)}
        width={760}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)} disabled={submitting}>取消</Button>
            <Button type="primary" loading={submitting} onClick={onDrawerSubmit} disabled={!canEdit}>
              {editing ? "保存" : "创建"}
            </Button>
          </Space>
        }
      >
        <Tabs
          defaultActiveKey="basic"
          items={[
            // ==================== Tab 1：基本信息（原 Form + 发布前检查） ====================
            {
              key: "basic",
              label: <Space><span>基本信息</span>{accessTypeValue === "single" && <Tag color="red">single·硬禁</Tag>}</Space>,
              children: (
                <Form form={form} layout="vertical" preserve={false}>
                  <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                    <Input placeholder="例如：呼吸与身体扫描入门" maxLength={200} />
                  </Form.Item>
                  <Form.Item name="description" label="描述">
                    <TextArea rows={3} placeholder="在 Mini App 列表展示的简短描述" maxLength={1000} />
                  </Form.Item>
                  <Alert
                    type="info"
                    showIcon
                    icon={<InfoCircleOutlined />}
                    message="素材文件请切换到「素材上传」Tab 上传（浏览器直传对象存储，不经 Web 服务器）；此处 URL 字段为兼容老数据的兜底，如已上传素材会由系统自动回填。"
                    style={{ marginBottom: 16 }}
                  />
                  <Space size={16} style={{ width: "100%" }}>
                    <Form.Item name="coverUrl" label="封面图 URL（旧字段，可留空）" style={{ flex: 1 }}>
                      <Input placeholder="https://...（推荐在「素材上传」Tab 传封面，系统会自动回填此字段）" />
                    </Form.Item>
                    <Form.Item name="thumbnailUrl" label="缩略图 URL（旧字段，可留空）" style={{ flex: 1 }}>
                      <Input placeholder="https://..." />
                    </Form.Item>
                  </Space>
                  <Space size={16} style={{ width: "100%" }}>
                    <Form.Item
                      name="accessType"
                      label="访问类型"
                      rules={[{ required: true }]}
                      style={{ flex: 1 }}
                    >
                      <Select
                        disabled={!!editing && editing.accessType === "single"}
                      >
                        {ACCESS_TYPE_OPTIONS.map((o) => (
                          <Option key={o.value} value={o.value}>{o.label}</Option>
                        ))}
                        <Option value="single" disabled>
                          <Tooltip title="首期已硬禁 single，不能通过共享频道交付单条视频。请改用 membership 或 package。">
                            <span style={{ color: "#999", textDecoration: "line-through" }}>单篇购买（single · 已禁用）</span>
                          </Tooltip>
                        </Option>
                      </Select>
                    </Form.Item>
                    <Form.Item name="durationSeconds" label="时长（秒）" style={{ flex: 1 }}>
                      <InputNumber min={0} style={{ width: "100%" }} placeholder="素材校验后会自动回填，可手动覆盖" />
                    </Form.Item>
                    <Form.Item name="sortOrder" label="排序值" style={{ flex: 1 }}>
                      <InputNumber style={{ width: "100%" }} />
                    </Form.Item>
                  </Space>

                  {accessTypeValue === "membership" && (
                    <Alert
                      type="info"
                      showIcon
                      icon={<InfoCircleOutlined />}
                      message="完整内容将统一交付至服务端配置的会员私密频道（不需要在此处指定频道）"
                      style={{ marginBottom: 24 }}
                    />
                  )}

                  {accessTypeValue === "public" && (
                    <Space direction="vertical" size={12} style={{ width: "100%", marginBottom: 12 }}>
                      <Alert
                        type="info"
                        showIcon
                        icon={<InfoCircleOutlined />}
                        message="公开内容：用户点击卡片后，将直接跳转到所选免费频道（由服务端映射 chatId，不允许运营自填）"
                      />
                      <Form.Item
                        name="freeChannelCode"
                        label="选择免费频道（必填，只能从白名单选择）"
                        rules={[
                          { required: true, message: "公开内容必须选择一个免费频道（由服务端受控白名单）" },
                          {
                            validator: (_, value) => {
                              if (!value) return Promise.resolve();
                              if (freeChannels.length === 0) {
                                return Promise.reject(new Error("免费频道白名单尚未加载；请稍后重试或检查服务端配置"));
                              }
                              if (!freeChannels.some((f) => f.code === value)) {
                                return Promise.reject(new Error("该 code 不在白名单中；请从下拉选择"));
                              }
                              return Promise.resolve();
                            },
                          },
                        ]}
                        style={{ marginBottom: 0 }}
                      >
                        <Select
                          placeholder="选择服务端受控的免费频道"
                          showSearch
                          optionFilterProp="label"
                          disabled={!canEdit}
                          loading={freeChannels.length === 0}
                          options={freeChannels.map((f) => ({
                            value: f.code,
                            label: `${f.label}  （${f.code}）`,
                            title: f.description,
                          }))}
                        />
                      </Form.Item>
                    </Space>
                  )}

                  {accessTypeValue === "package" && (
                    <Space direction="vertical" size={12} style={{ width: "100%", marginBottom: 12 }}>
                      {renderPackageConfigBadge()}
                    </Space>
                  )}

                  <Form.Item name="categoryIds" label="关联分类（可多选）">
                    <Select mode="multiple" placeholder="选择分类">
                      {categories.map((c) => (
                        <Option key={c.id} value={c.id}>{c.name}</Option>
                      ))}
                    </Select>
                  </Form.Item>
                  <Form.Item name="tags" label="标签">
                    <Select mode="tags" placeholder="输入标签后回车" />
                  </Form.Item>
                  <Card
                    size="small"
                    title="SEO / GEO（可选，未填则继承平台设置）"
                    style={{ marginBottom: 24 }}
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <Alert
                        type="info"
                        showIcon
                        message="这里仅维护搜索展示元信息与生成式搜索主题词。GEO 只用于主题表达，不采集用户地理位置；且 SEO/GEO 关键词不会自动泄露为 Telegram 标签。"
                      />
                      <Form.Item name="seoTitle" label="SEO 标题">
                        <Input maxLength={120} placeholder="未填则继承平台默认 SEO 标题；再未填则回落到内容标题" />
                      </Form.Item>
                      <Form.Item name="seoDescription" label="SEO 描述">
                        <TextArea rows={3} maxLength={300} placeholder="未填则继承平台默认 SEO 描述；再未填则回落到内容描述" />
                      </Form.Item>
                      <Form.Item name="seoKeywords" label="SEO 关键词">
                        <Select mode="tags" placeholder="输入 SEO 关键词后回车，未填则继承平台默认关键词" />
                      </Form.Item>
                      <Form.Item name="geoKeywords" label="GEO 主题词">
                        <Select mode="tags" placeholder="输入生成式搜索主题词后回车，未填则继承平台默认主题词" />
                      </Form.Item>
                      {!!editing?.effectiveSeo && (
                        <Alert
                          type="success"
                          showIcon
                          message={`当前生效标题：${editing.effectiveSeo.title || "—"}`}
                          description={
                            <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                              <span>描述来源：{editing.effectiveSeo.source.description}</span>
                              <span>关键词：{(editing.effectiveSeo.keywords || []).join(" / ") || "—"}</span>
                              <span>GEO：{(editing.effectiveSeo.geoKeywords || []).join(" / ") || "—"}</span>
                            </Space>
                          }
                        />
                      )}
                    </Space>
                  </Card>
                  <Space size={16} style={{ width: "100%" }} align="start">
                    <Form.Item name="isRecommended" label="推荐位" valuePropName="checked" style={{ marginBottom: 0 }}>
                      <Switch />
                    </Form.Item>
                    <Form.Item name="isFeatured" label="精选位" valuePropName="checked" style={{ marginBottom: 0 }}>
                      <Switch />
                    </Form.Item>
                    <Form.Item name="isNewArrival" label="新品标" valuePropName="checked" style={{ marginBottom: 0 }}>
                      <Switch />
                    </Form.Item>
                    <Form.Item name="featuredSort" label="精选排序" style={{ flex: 1, marginBottom: 0 }}>
                      <InputNumber style={{ width: "100%" }} placeholder="越小越靠前" />
                    </Form.Item>
                  </Space>
                  <Space size={16} style={{ width: "100%", marginTop: 24 }}>
                    <Form.Item name="recommendStartsAt" label="推荐开始" style={{ flex: 1 }}>
                      <DatePicker showTime style={{ width: "100%" }} />
                    </Form.Item>
                    <Form.Item name="recommendEndsAt" label="推荐结束" style={{ flex: 1 }}>
                      <DatePicker showTime style={{ width: "100%" }} />
                    </Form.Item>
                    <Form.Item name="scheduledAt" label="定时发布" style={{ flex: 1 }}>
                      <DatePicker showTime style={{ width: "100%" }} />
                    </Form.Item>
                  </Space>
                  <Form.Item name="previewUrl" label="试听/预览 URL（旧字段，可留空）">
                    <Input placeholder="https://...（推荐在「素材上传」Tab 传试看视频，系统自动回填此字段）" />
                  </Form.Item>
                  <Space size={16} style={{ width: "100%" }}>
                    {accessTypeValue === "package" ? (
                      <Form.Item
                        name="packageId"
                        label="所属内容包（必填）"
                        rules={[{ required: true, message: "package 类型必须绑定内容包" }]}
                        style={{ flex: 1 }}
                      >
                        <Select
                          placeholder="选择可交付的内容包（已发布 + 已配频道 + 商品启用）"
                          showSearch
                          optionFilterProp="label"
                        >
                          {publishablePackages.length === 0 && packages.length > 0 && (
                            <Option value="" disabled>暂无可交付的内容包（请先在服务端完成频道映射）</Option>
                          )}
                          {publishablePackages.map((p) => (
                            <Option key={p.id} value={p.id} label={p.title}>
                              <Space>
                                <span>{p.title}</span>
                                <Tag color="green">已发布</Tag>
                                <Tag color="cyan">{p.contentsCount} 条</Tag>
                              </Space>
                            </Option>
                          ))}
                          {packages
                            .filter((p) => !publishablePackages.find((pp) => pp.id === p.id))
                            .map((p) => (
                              <Option key={p.id} value={p.id} disabled label={p.title}>
                                <Space>
                                  <span style={{ textDecoration: "line-through", color: "#999" }}>{p.title}</span>
                                  {p.status !== "published" && <Tag color="default">{p.status}</Tag>}
                                  {!p.channelConfigured && <Tag color="red">未配频道</Tag>}
                                  {!p.productActive && <Tag color="orange">商品未启用</Tag>}
                                </Space>
                              </Option>
                            ))}
                        </Select>
                      </Form.Item>
                    ) : null}

                    {(accessTypeValue === "membership" || accessTypeValue === "public") ? (
                      <Form.Item name="productId" label="关联商品 ID（可选，分析用）" style={{ flex: 1 }}>
                        <Input placeholder={accessTypeValue === "membership" ? "对应会员商品 UUID" : "public 通常留空"} />
                      </Form.Item>
                    ) : null}

                    {accessTypeValue === "single" && editing && editing.accessType === "single" ? (
                      <Alert type="error" showIcon message="single（单篇购买）首期已停止，请先将访问类型改为 membership 或 package" style={{ flex: 1 }} />
                    ) : null}
                  </Space>

                  {editing?.accessType === "single" && (
                    <Alert
                      type="warning"
                      showIcon
                      icon={<InfoCircleOutlined />}
                      message="该内容为历史 single 数据"
                      description="为避免共享 VIP 频道造成权益越界，首期不再支持 single 交付。建议改为 membership 或 package 后重新发布。"
                    />
                  )}

                  <Card
                    size="small"
                    title={
                      <Space>
                        <span>发布前检查 · 运营自检区</span>
                        {prePublishAllPassed ? (
                          <Tag color="green" icon={<InfoCircleOutlined />}>全部通过（仍需服务端最终校验）</Tag>
                        ) : (
                          <Tag color="orange">有未通过项</Tag>
                        )}
                      </Space>
                    }
                    style={{ marginTop: 24, borderColor: prePublishAllPassed ? "#b7eb8f" : "#ffd591" }}
                  >
                    <Space direction="vertical" size={10} style={{ width: "100%" }}>
                      {prePublishChecklist.map((c) => (
                        <div key={c.key} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                          {c.passed ? (
                            <Tag color="green" style={{ minWidth: 76, textAlign: "center" }}>✓ 通过</Tag>
                          ) : (
                            <Tag color="red" style={{ minWidth: 76, textAlign: "center" }}>✗ 未通过</Tag>
                          )}
                          <div style={{ flex: 1 }}>
                            <span style={{ fontWeight: 500 }}>{c.label}</span>
                            {c.detail && (
                              <div style={{ color: "#666", fontSize: 12, marginTop: 2, lineHeight: 1.5 }}>
                                {c.detail}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginTop: 8 }}
                        message="前端自检仅为提示；保存/提交审核/发布时，服务端会再次严格校验（含跨字段一致性、受控频道映射状态等），以服务端返回为准。"
                      />
                    </Space>
                  </Card>
                </Form>
              ),
            },
            // ==================== Tab 2：素材上传（三 Upload + 尺寸限制 + 水印 + public 禁完整视频） ====================
            {
              key: "media",
              label: <Space><span>素材上传</span>{coverAssetId && previewAssetId ? <Badge count={2} /> : null}</Space>,
              children: (
                <Space direction="vertical" size={20} style={{ width: "100%" }}>
                  <Alert
                    type="info"
                    showIcon
                    icon={<InfoCircleOutlined />}
                    message="所有素材浏览器直传对象存储（DigitalOcean Spaces 等 S3 兼容服务），不经过普通 Web 服务器；因此封面 20MB / 试看 800MB / 完整视频 8GB 可稳定上传，仅需按下方按钮即可。"
                  />
                  {/* 封面 */}
                  <Card
                    size="small"
                    title={
                      <Space>
                        <span>① 封面图片（必填，建议 16:9，Mini App 卡片首图）</span>
                        {coverAsset?.status === "ready" ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : coverAsset?.status === "failed" ? <ExclamationCircleTwoTone twoToneColor="#ff4d4f" /> : <ClockCircleOutlined style={{ color: "#888" }} />}
                      </Space>
                    }
                    extra={<Tag color="blue">≤ 20MB</Tag>}
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <Upload
                        multiple={false}
                        maxCount={1}
                        accept="image/jpeg,image/png,image/webp,image/jpg"
                        disabled={!canEdit || coverUploading}
                        showUploadList={false}
                        beforeUpload={(f) => doDirectUpload(f as File, "cover_image", {
                          setAssetId: setCoverAssetId, setAsset: setCoverAsset,
                          setProgress: setCoverProgress, setUploading: setCoverUploading,
                        }, 20 * 1024 * 1024)}
                      >
                        <Button icon={<UploadOutlined />} loading={coverUploading} disabled={!canEdit}>
                          {coverAssetId ? (coverAsset?.status === "ready" ? "重新上传封面" : "重新上传（上次未完成）") : "上传封面图片"}
                        </Button>
                      </Upload>
                      <Progress percent={coverProgress} status={coverAsset?.status === "failed" ? "exception" : coverProgress === 100 ? "success" : coverUploading ? "active" : undefined} />
                      {coverAsset && (
                        <Space direction="vertical" size={4} style={{ fontSize: 12 }}>
                          <span>文件名：{coverAsset.originalFilename}</span>
                          <span>大小：{(coverAsset.contentLength / 1024 / 1024).toFixed(2)} MB</span>
                          {coverAsset.widthPixels && coverAsset.heightPixels && <span>尺寸：{coverAsset.widthPixels}×{coverAsset.heightPixels}</span>}
                          {coverAsset.status && <span>状态：<Tag color={coverAsset.status === "ready" ? "green" : coverAsset.status === "failed" ? "red" : "default"}>{coverAsset.status}</Tag></span>}
                          {coverAsset.lastErrorClass && <span style={{ color: "#ff4d4f" }}>失败原因：{coverAsset.lastErrorClass}{coverAsset.lastErrorNote ? `（${coverAsset.lastErrorNote}）` : ""}</span>}
                          {coverAsset.storagePublicUrl && <span>公开 URL：<a href={coverAsset.storagePublicUrl} target="_blank" rel="noreferrer">{coverAsset.storagePublicUrl.slice(0, 60)}…</a></span>}
                        </Space>
                      )}
                    </Space>
                  </Card>
                  {/* 试看视频 */}
                  <Card
                    size="small"
                    title={
                      <Space>
                        <span>② 试看视频（必填，30–60 秒 · 必须有水印，发送到免费频道）</span>
                        {previewAsset?.status === "ready" ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : previewAsset?.status === "failed" ? <ExclamationCircleTwoTone twoToneColor="#ff4d4f" /> : <ClockCircleOutlined style={{ color: "#888" }} />}
                      </Space>
                    }
                    extra={<Tag color="geekblue">≤ 800MB</Tag>}
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <Alert
                        type="error"
                        showIcon
                        message="运营流程硬约束：试看视频必须加水印（30–60 秒）；系统当前无法自动检测水印，仅能在审核时人工确认。若发布到免费频道后被投诉无水印，由运营侧负责。"
                      />
                      <Upload
                        multiple={false}
                        maxCount={1}
                        accept="video/*"
                        disabled={!canEdit || previewUploading}
                        showUploadList={false}
                        beforeUpload={(f) => doDirectUpload(f as File, "preview_video", {
                          setAssetId: setPreviewAssetId, setAsset: setPreviewAsset,
                          setProgress: setPreviewProgress, setUploading: setPreviewUploading,
                        }, 800 * 1024 * 1024)}
                      >
                        <Button icon={<UploadOutlined />} loading={previewUploading} disabled={!canEdit}>
                          {previewAssetId ? (previewAsset?.status === "ready" ? "重新上传试看" : "重新上传（上次未完成）") : "上传试看视频（30–60 秒 · 必须带水印）"}
                        </Button>
                      </Upload>
                      <Progress percent={previewProgress} status={previewAsset?.status === "failed" ? "exception" : previewProgress === 100 ? "success" : previewUploading ? "active" : undefined} />
                      {previewAsset && (
                        <Space direction="vertical" size={4} style={{ fontSize: 12 }}>
                          <span>文件名：{previewAsset.originalFilename}</span>
                          <span>大小：{(previewAsset.contentLength / 1024 / 1024).toFixed(2)} MB</span>
                          {previewAsset.durationSeconds && <span>时长：{Math.floor(previewAsset.durationSeconds / 60)}分{previewAsset.durationSeconds % 60}秒</span>}
                          {previewAsset.widthPixels && previewAsset.heightPixels && <span>尺寸：{previewAsset.widthPixels}×{previewAsset.heightPixels}</span>}
                          {previewAsset.hasWatermark ? (
                            <span>水印：<Tag color="green">声明已加水印</Tag></span>
                          ) : (
                            <span>水印：<Tag color="orange">未声明（审核需人工核验）</Tag></span>
                          )}
                          <span>状态：<Tag color={previewAsset.status === "ready" ? "green" : previewAsset.status === "failed" ? "red" : "default"}>{previewAsset.status}</Tag></span>
                          {previewAsset.lastErrorClass && <span style={{ color: "#ff4d4f" }}>失败原因：{previewAsset.lastErrorClass}{previewAsset.lastErrorNote ? `（${previewAsset.lastErrorNote}）` : ""}</span>}
                        </Space>
                      )}
                    </Space>
                  </Card>
                  {/* 完整视频 */}
                  <Card
                    size="small"
                    title={
                      <Space>
                        <span>③ 完整视频（{accessTypeValue === "public" ? "public 类型禁止上传，请改用 membership/package" : `会员/内容包必填 · 发送到${accessTypeValue === "package" ? "内容包独立" : "会员主"}私密频道`}）</span>
                        {fullVideoAsset?.status === "ready" ? <CheckCircleTwoTone twoToneColor="#52c41a" /> : fullVideoAsset?.status === "failed" ? <ExclamationCircleTwoTone twoToneColor="#ff4d4f" /> : <ClockCircleOutlined style={{ color: "#888" }} />}
                      </Space>
                    }
                    extra={<Tag color={accessTypeValue === "public" ? "default" : "purple"}>≤ 8GB</Tag>}
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      {accessTypeValue === "public" ? (
                        <Alert type="info" showIcon message="public 内容仅用于免费频道引流，完整视频交付需升级为 membership 或 package。" />
                      ) : null}
                      <Upload
                        multiple={false}
                        maxCount={1}
                        accept="video/*"
                        disabled={!canEdit || fullVideoUploading || accessTypeValue === "public"}
                        showUploadList={false}
                        beforeUpload={(f) => doDirectUpload(f as File, "full_video", {
                          setAssetId: setFullVideoAssetId, setAsset: setFullVideoAsset,
                          setProgress: setFullVideoProgress, setUploading: setFullVideoUploading,
                        }, 8 * 1024 * 1024 * 1024)}
                      >
                        <Button icon={<UploadOutlined />} loading={fullVideoUploading} disabled={!canEdit || accessTypeValue === "public"}>
                          {fullVideoAssetId ? (fullVideoAsset?.status === "ready" ? "重新上传完整视频" : "重新上传（上次未完成）") : "上传完整视频（会员/内容包私密频道交付）"}
                        </Button>
                      </Upload>
                      <Progress percent={fullVideoProgress} status={fullVideoAsset?.status === "failed" ? "exception" : fullVideoProgress === 100 ? "success" : fullVideoUploading ? "active" : undefined} />
                      {fullVideoAsset && (
                        <Space direction="vertical" size={4} style={{ fontSize: 12 }}>
                          <span>文件名：{fullVideoAsset.originalFilename}</span>
                          <span>大小：{(fullVideoAsset.contentLength / 1024 / 1024 / 1024).toFixed(3)} GB</span>
                          {fullVideoAsset.durationSeconds && <span>时长：{Math.floor(fullVideoAsset.durationSeconds / 60)}分{fullVideoAsset.durationSeconds % 60}秒</span>}
                          {fullVideoAsset.widthPixels && fullVideoAsset.heightPixels && <span>尺寸：{fullVideoAsset.widthPixels}×{fullVideoAsset.heightPixels}</span>}
                          <span>状态：<Tag color={fullVideoAsset.status === "ready" ? "green" : fullVideoAsset.status === "failed" ? "red" : "default"}>{fullVideoAsset.status}</Tag></span>
                          {fullVideoAsset.lastErrorClass && <span style={{ color: "#ff4d4f" }}>失败原因：{fullVideoAsset.lastErrorClass}{fullVideoAsset.lastErrorNote ? `（${fullVideoAsset.lastErrorNote}）` : ""}</span>}
                        </Space>
                      )}
                      <Alert
                        type="warning"
                        showIcon
                        message="完整视频仅发会员主频道 / 内容包独立私密频道，绝不能发送到免费频道。此约束由服务端在 start-telegram-publish 时二次强校验，尝试绕过会返回 400。"
                      />
                    </Space>
                  </Card>
                </Space>
              ),
            },
            // ==================== Tab 3：发布进度（Bot 异步任务队列 + 进度表） ====================
            {
              key: "publish",
              label: <Space><span>频道发布与关联</span>{publishJobs.filter(j => j.status === "processing" || j.status === "queued").length > 0 && <Badge color="processing" count={publishJobs.filter(j => j.status === "processing" || j.status === "queued").length} />}</Space>,
              children: (
                <Space direction="vertical" size={20} style={{ width: "100%" }}>
                  {!editing?.id ? (
                    <Alert type="info" showIcon message="新建内容请先在「基本信息」Tab 点击「创建」保存后，再回到此处触发发布到 Telegram。" />
                  ) : (
                    <>
                      <Card size="small" title="① 由 Bot 发布">
                        <Space direction="vertical" size={12} style={{ width: "100%" }}>
                          <Alert
                            type="info"
                            showIcon
                            icon={<InfoCircleOutlined />}
                            message="频道 chatId 完全由服务端控制，前端仅能选择「渠道类型」；运营绝对不能直接提交 chatId，也无法在 UI 看到明文 chatId。"
                          />
                          <Form.Item
                            name="telegramTags"
                            label="Telegram 标签（可选，仅用于发布 caption）"
                            style={{ marginBottom: 0 }}
                            extra="服务端会自动清洗、去重、限长，并与内容标签合并生成 #标签1 #标签2。SEO/GEO 关键词不会自动进入这里。"
                          >
                            <Select mode="tags" placeholder="例如：夜间, calm_mode" />
                          </Form.Item>
                          <Checkbox.Group
                            value={channelKinds}
                            onChange={(v) => setChannelKinds(v as TelegramPublishJobItem["channelKind"][])}
                            style={{ width: "100%" }}
                          >
                            <Space direction="vertical" size={8} style={{ width: "100%" }}>
                              <Checkbox
                                value="public_free_preview"
                                disabled={
                                  !canPublish ||
                                  accessTypeValue === "single" ||
                                  !!previewAssetId === false ||
                                  previewAsset?.status !== "ready"
                                }
                              >
                                <Space>
                                  <Tag color={CHANNEL_KIND_LABEL.public_free_preview.color}>{CHANNEL_KIND_LABEL.public_free_preview.label}</Tag>
                                  <span style={{ color: "#666", fontSize: 12 }}>
                                    {
                                      !previewAssetId || previewAsset?.status !== "ready"
                                        ? "（未满足：先在「素材上传」Tab 成功上传试看视频，且需 freeChannelCode 已选）"
                                        : "✅ 试看素材已就绪；将发送到上方所选免费频道（白名单）并附带 Mini App 跳转链接"
                                    }
                                  </span>
                                </Space>
                              </Checkbox>
                              <Checkbox
                                value="membership_full"
                                disabled={
                                  !canPublish ||
                                  accessTypeValue !== "membership" ||
                                  !!fullVideoAssetId === false ||
                                  fullVideoAsset?.status !== "ready"
                                }
                              >
                                <Space>
                                  <Tag color={CHANNEL_KIND_LABEL.membership_full.color}>{CHANNEL_KIND_LABEL.membership_full.label}</Tag>
                                  <span style={{ color: "#666", fontSize: 12 }}>
                                    {
                                      accessTypeValue !== "membership"
                                        ? "（未满足：仅 accessType=membership 可选）"
                                        : !fullVideoAssetId || fullVideoAsset?.status !== "ready"
                                          ? "（未满足：先在「素材上传」Tab 成功上传完整视频）"
                                          : "✅ 将发送到服务端配置的 TELEGRAM_CHANNEL_MEMBERSHIP 私密主频道（用户交付时自动获取邀请）"
                                    }
                                  </span>
                                </Space>
                              </Checkbox>
                              <Checkbox
                                value="package_full"
                                disabled={
                                  !canPublish ||
                                  accessTypeValue !== "package" ||
                                  !packageIdValue ||
                                  !!fullVideoAssetId === false ||
                                  fullVideoAsset?.status !== "ready" ||
                                  (!!selectedPackage && !selectedPackage.channelConfigured)
                                }
                              >
                                <Space>
                                  <Tag color={CHANNEL_KIND_LABEL.package_full.color}>{CHANNEL_KIND_LABEL.package_full.label}</Tag>
                                  <span style={{ color: "#666", fontSize: 12 }}>
                                    {
                                      accessTypeValue !== "package"
                                        ? "（未满足：仅 accessType=package 可选）"
                                        : !packageIdValue
                                          ? "（未满足：请在基本信息选择一个内容包）"
                                          : !fullVideoAssetId || fullVideoAsset?.status !== "ready"
                                            ? "（未满足：先上传完整视频）"
                                            : selectedPackage && !selectedPackage.channelConfigured
                                              ? `（未满足：内容包 ${selectedPackage.title} 尚未在服务端配置加密 channelId，请先完成频道映射）`
                                              : "✅ 将发送到所选内容包对应的独立私密频道（购买后一次性邀请进包频道）"
                                    }
                                  </span>
                                </Space>
                              </Checkbox>
                            </Space>
                          </Checkbox.Group>
                          <Space wrap>
                            <Button
                              type="primary"
                              icon={<SendOutlined />}
                              loading={startPublishing}
                              disabled={
                                !canPublish ||
                                !editing?.id ||
                                channelKinds.length === 0 ||
                                accessTypeValue === "single"
                              }
                              onClick={async () => {
                                if (!editing?.id) return;
                                setStartPublishing(true);
                                try {
                                  const rawTelegramTags = form.getFieldValue("telegramTags") || [];
                                  const r = await startTelegramPublish(editing.id, {
                                    channelKinds,
                                    telegramTags: rawTelegramTags,
                                    reason: `运营点击发布：${channelKinds.join("+")}`,
                                  });
                                  message.success(`已入队 ${r.jobs.length} 条 Bot 发送任务${r.normalizedTelegramTags?.length ? ` · 标签：${r.normalizedTelegramTags.join(" ")}` : ""}`);
                                  refreshPublishJobs(editing.id);
                                } catch (e) {
                                  message.error(errMsg(e, "入队失败"));
                                } finally {
                                  setStartPublishing(false);
                                }
                              }}
                            >
                              📤 发布到 Telegram（异步入队）
                            </Button>
                            <Button icon={<ReloadOutlined />} onClick={() => editing?.id && refreshPublishJobs(editing.id)} disabled={publishJobsLoading}>
                              刷新进度
                            </Button>
                          </Space>
                          <Alert
                            type="warning"
                            showIcon
                            message="发布模式说明"
                            description={
                              <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                                <span>· 当前为 P0 「任务队列 · 从未启用真实发送」阶段：即便入队成功，也需要运维完成：S3 env 配置、REDIS_URL、Bot Token、频道 chatId 加密写入、migration 0014 deploy、BullMQ Worker 启动后才会真正发 Telegram。</span>
                                <span>· 即便运维部署完成，Bot 发送也为异步：大视频 8GB 级可能需要 10 分钟以上（TG 大文件带宽限制），请耐心查看下表 attempt / nextRetryAt。</span>
                                <span>· 最大重试 3 次，指数退避（5s / 10s / 20s），重试耗尽后可手动点击「重试」按钮重新入队。</span>
                              </Space>
                            }
                          />
                        </Space>
                      </Card>
                      <Card
                        size="small"
                        title="② 从频道消息关联"
                        extra={
                          <Space>
                            <Button icon={<ReloadOutlined />} onClick={() => editing?.id && refreshChannelMessages(editing.id)} disabled={channelMessagesLoading}>
                              刷新收件箱
                            </Button>
                            {currentChannelLink && me?.role === "super_admin" ? (
                              <Button danger onClick={onUnlinkChannelMessage} loading={publishingTg}>
                                解除当前关联
                              </Button>
                            ) : null}
                          </Space>
                        }
                      >
                        <Space direction="vertical" size={12} style={{ width: "100%" }}>
                          <Alert
                            type="info"
                            showIcon
                            message="运营手工在频道发视频后，Bot 会通过 Webhook 收到 channel_post，并把未关联消息放进收件箱。这里不再要求人工填 messageId。"
                          />
                          {currentChannelLinkCard}
                          <Alert
                            type="warning"
                            showIcon
                            message={
                              editing?.accessType === "public"
                                ? "public 内容只能关联免费频道试看消息。"
                                : editing?.accessType === "membership"
                                  ? "membership 内容只能关联会员主频道消息。"
                                  : editing?.accessType === "package"
                                    ? "package 内容只能关联所属内容包私密频道消息。"
                                    : "当前内容类型不支持频道消息关联。"
                            }
                            description="若收件箱为空，请确认 @InTune_bdsm_bot 已是目标频道管理员，并在发出视频后等待 webhook 收到 channel_post。"
                          />
                          <Table<ChannelMessageItem>
                            rowKey="id"
                            size="small"
                            loading={channelMessagesLoading}
                            dataSource={channelMessages}
                            pagination={{ pageSize: 6, hideOnSinglePage: true }}
                            locale={{ emptyText: "暂无可关联的频道消息" }}
                            columns={[
                              {
                                title: "频道",
                                key: "channel",
                                render: (_, r) => (
                                  <Space direction="vertical" size={0}>
                                    <span>{r.channelLabel}</span>
                                    <Text type="secondary" style={{ fontSize: 12 }}>{r.channelPurpose}</Text>
                                  </Space>
                                ),
                              },
                              {
                                title: "消息",
                                key: "message",
                                render: (_, r) => (
                                  <Space direction="vertical" size={0}>
                                    <span>{r.mediaKind}</span>
                                    <Text type="secondary" style={{ fontSize: 12 }}>{r.messageIdMasked || "-"}</Text>
                                  </Space>
                                ),
                              },
                              {
                                title: "发布时间",
                                dataIndex: "postedAt",
                                key: "postedAt",
                                render: (v?: string | null) => v ? dayjs(v).format("MM-DD HH:mm:ss") : "-",
                              },
                              {
                                title: "操作",
                                key: "action",
                                width: 120,
                                render: (_, r) => (
                                  <Button
                                    type="primary"
                                    size="small"
                                    disabled={!canPublish || !!currentChannelLink}
                                    loading={publishingTg && linkingChannelMessageId === r.id}
                                    onClick={() => onLinkChannelMessage(r)}
                                  >
                                    选择
                                  </Button>
                                ),
                              },
                            ]}
                          />
                        </Space>
                      </Card>
                      <Card
                        size="small"
                        title={
                          <Space>
                            <span>③ 发送任务进度</span>
                            {publishJobs.length > 0 && <Tag color="processing">{publishJobs.length} 条</Tag>}
                            <Tooltip title="默认每 8 秒自动刷新，或点击上方按钮立即刷新">
                              <InfoCircleOutlined style={{ color: "#888" }} />
                            </Tooltip>
                          </Space>
                        }
                      >
                        <Table<TelegramPublishJobItem>
                          rowKey="id"
                          size="small"
                          loading={publishJobsLoading}
                          dataSource={publishJobs}
                          pagination={{ pageSize: 10, hideOnSinglePage: true }}
                          locale={{ emptyText: editing?.id ? "尚未入队任何 Bot 发送任务" : "创建内容后才可查看任务" }}
                          columns={[
                            {
                              title: "目标", dataIndex: "channelKind", key: "ck", width: 190,
                              render: (ck: TelegramPublishJobItem["channelKind"], r) => (
                                <Space direction="vertical" size={0}>
                                  <Tag color={CHANNEL_KIND_LABEL[ck]?.color || "default"}>{CHANNEL_KIND_LABEL[ck]?.label || ck}</Tag>
                                  {r.targetFreeChannelCode && <span style={{ fontSize: 12, color: "#666" }}>freeChannelCode: {r.targetFreeChannelCode}</span>}
                                  {r.targetChatMasked && <span style={{ fontSize: 12, color: "#999" }}>目标掩码：{r.targetChatMasked}</span>}
                                </Space>
                              ),
                            },
                            {
                              title: "状态 / 进度", key: "st", width: 200,
                              render: (_, r) => {
                                const pct = Math.max(0, Math.min(100, Math.round((r.attempt / Math.max(1, r.maxAttempts)) * 100)));
                                const s = PUBLISH_JOB_STATUS_TAG[r.status];
                                return (
                                  <Space direction="vertical" size={2} style={{ width: "100%" }}>
                                    <Tag color={s?.color || "default"}>{s?.label || r.status}</Tag>
                                    <Progress percent={pct} size="small" format={() => `attempt ${r.attempt || 0}/${r.maxAttempts || 3}`} />
                                    {r.lastErrorClass && <span style={{ color: "#ff4d4f", fontSize: 12 }}>失败类：{r.lastErrorClass}</span>}
                                  </Space>
                                );
                              },
                            },
                            {
                              title: "素材", dataIndex: ["mediaAsset", "originalFilename"], key: "md",
                              render: (_: any, r) => (
                                <Space direction="vertical" size={0}>
                                  <span style={{ fontSize: 12 }}>{r.mediaAsset?.originalFilename || "-"}</span>
                                  {r.mediaAsset && (
                                    <span style={{ color: "#666", fontSize: 11 }}>
                                      {(r.mediaAsset.contentLength / 1024 / 1024).toFixed(2)} MB
                                      {r.mediaAsset.durationSeconds ? ` · ${Math.floor(r.mediaAsset.durationSeconds / 60)}分${r.mediaAsset.durationSeconds % 60}秒` : ""}
                                    </span>
                                  )}
                                </Space>
                              ),
                            },
                            {
                              title: "结果（如有）", key: "rs", width: 170,
                              render: (_, r) => (
                                <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                                  {r.telegramMessageId && <span>messageId: <b>{r.telegramMessageId}</b></span>}
                                  {r.sentAt && <span style={{ color: "#52c41a" }}>发送完成：{dayjs(r.sentAt).format("MM-DD HH:mm:ss")}</span>}
                                  {r.nextRetryAt && r.status === "failed" && <span style={{ color: "#faad14" }}>下次重试：{dayjs(r.nextRetryAt).format("HH:mm:ss")}</span>}
                                  {r.cancelledAt && <span style={{ color: "#888" }}>取消：{dayjs(r.cancelledAt).format("MM-DD HH:mm")}</span>}
                                  {r.admin?.displayName && <span style={{ color: "#666" }}>创建：{r.admin.displayName}</span>}
                                </Space>
                              ),
                            },
                            {
                              title: "操作", key: "op", width: 170, fixed: "right",
                              render: (_, r) => {
                                const canCancel = r.status === "queued" || r.status === "failed" || r.status === "retried_exhausted";
                                const canRetry = r.status === "failed" || r.status === "retried_exhausted";
                                return (
                                  <Space size={4}>
                                    <Button
                                      size="small"
                                      type="primary"
                                      ghost
                                      icon={<ReloadOutlined />}
                                      disabled={!canRetry || !canPublish}
                                      onClick={async () => {
                                        if (!editing?.id) return;
                                        setStartPublishing(true);
                                        try {
                                          const r2 = await startTelegramPublish(editing.id, {
                                            channelKinds: [r.channelKind],
                                            reason: `运营手动重试运行任务 id=${r.id.slice(0, 8)}（lastStatus=${r.status}）`,
                                          });
                                          message.success(`已重新入队 ${r2.jobs.length} 条任务`);
                                          refreshPublishJobs(editing.id);
                                        } catch (e) {
                                          message.error(errMsg(e, "重试入队失败"));
                                        } finally {
                                          setStartPublishing(false);
                                        }
                                      }}
                                    >重试</Button>
                                    <Button
                                      size="small"
                                      danger
                                      icon={<CloseCircleOutlined />}
                                      disabled={!canCancel || !canPublish}
                                      onClick={async () => {
                                        Modal.confirm({
                                          title: `取消发送任务 ${r.id.slice(0, 8)}…`,
                                          content: "取消后任务将标记为 cancelled，BullMQ 若已入队也会从队列移除。若 Telegram 已在发送中，取消不会撤回已在途中的视频。",
                                          okText: "确认取消",
                                          cancelText: "再想想",
                                          onOk: async () => {
                                            try {
                                              await cancelTelegramPublishJob(r.id, "运营点击取消按钮");
                                              message.success("已取消任务");
                                              if (editing?.id) refreshPublishJobs(editing.id);
                                            } catch (e) {
                                              message.error(errMsg(e, "取消失败"));
                                            }
                                          },
                                        });
                                      }}
                                    >取消</Button>
                                  </Space>
                                );
                              },
                            },
                          ]}
                        />
                      </Card>
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Drawer>
    </Space>
  );
};

export default ContentsPage;
