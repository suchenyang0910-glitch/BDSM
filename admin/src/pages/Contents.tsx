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
  PauseCircleOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
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
import DelimitedTagInput from "../components/DelimitedTagInput";
import type {
  ContentItem,
  ContentStatus,
  CategoryItem,
  AdminMe,
  AdminPackageItem,
  FreeChannelOption,
} from "../api/types";
import type { DelimitedInputState } from "../utils/delimitedTagInput";

const { Title, Text } = Typography;
const { TextArea } = Input;
const { Option } = Select;

// ================== Phase A：VOD 私有媒体类型 ==================
export type MediaAssetKind = "cover_image" | "preview_video" | "full_video";
type ApiMediaKind = "cover" | "preview_source" | "full_source";
type ApiMediaStatus = "uploading" | "verified" | "failed" | "deleted";
export type MediaAssetStatus = "uploading" | "ready" | "failed" | "deleted";

export type MediaAssetItem = {
  id: string;
  kind: MediaAssetKind;
  originalFilename: string;
  mimeType: string | null;
  contentLength: number;
  /** `vod` 是当前阶段的私有媒体链路；legacy 只用于兼容旧的 MediaAsset。 */
  source?: "vod" | "legacy";
  previewPath?: string | null;
  status: MediaAssetStatus;
  lastErrorClass?: string | null;
  lastVerifiedAt?: string | null;
  createdAt?: string;
  transcodeJobId?: string | null;
  transcodeStatus?: string | null;
  transcodeProgressPercent?: number;
  transcodeErrorClass?: string | null;
  renditions?: Array<{
    kind: "preview" | "hls_1080" | "hls_720" | "hls_480" | string;
    status: "pending" | "processing" | "ready" | "failed" | "deleted" | string;
    width?: number | null;
    height?: number | null;
    bitrateKbps?: number | null;
    durationSeconds?: number | null;
    segmentCount?: number | null;
    byteSize?: string | null;
    errorClass?: string | null;
    readyAt?: string | null;
  }>;
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
  videoAsset?: MediaAssetItem | null;
  mediaAssetId?: string | null;
  videoAssetId?: string | null;
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

// ================== Phase A 媒体 API 封装 ==================
type InitMediaUploadReq = {
  assetKind: ApiMediaKind;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
};
type InitMediaUploadResp = {
  uploadSessionId: string;
  uploadUrl: string;
  uploadExpiresAt: string;
  expectedHttpHeaders: Record<string, string>;
};
type MultipartUploadInitResp = {
  uploadSessionId: string;
  storageUploadId: string;
  partSize: number;
  totalParts: number;
  expiresAt: string;
  maxConcurrency: number;
};
type UploadSessionPartSummary = {
  partNumber: number;
  etag: string;
  bytes: string;
  checksum?: string | null;
  status: "uploaded" | string;
  uploadedAt?: string | null;
};
type UploadSessionSummary = {
  id: string;
  contentId: string;
  assetKind: ApiMediaKind;
  status: "initiated" | "uploading" | "paused" | "completing" | "completed" | "cancelled" | "expired" | "failed";
  filename?: string | null;
  mimeType?: string | null;
  expectedSize: string | null;
  uploadedBytes: string | null;
  totalParts: number | null;
  partSize: number | null;
  storageUploadIdPresent: boolean;
  expiresAt?: string | null;
  lastActivityAt?: string | null;
  completedAt?: string | null;
  parts: UploadSessionPartSummary[];
};
type CompleteMediaUploadReq = { uploadSessionId: string; proof?: { etag?: string | null } };
type CompleteMediaUploadResp = { ok: boolean; asset: any };
type ContentMediaResp = { contentStatus: string; items: any[]; uploadSessions?: UploadSessionSummary[] };
type TranscodeJobActionResp = { ok: true; job: any; asset: any };
type StartTelegramPublishReq = { channelKinds: Array<"public_free_preview" | "membership_full" | "package_full">; telegramTags?: string[]; reason?: string };
type StartTelegramPublishResp = { ok: true; jobs: Array<{ id: string; channelKind: string; status: string; jobToken: string; mediaAssetId: string | null; videoAssetId: string | null; targetFreeChannelCode: string | null; createdAt: string }>; normalizedTelegramTags?: string[] };

type MultipartSessionResp = {
  ok?: boolean;
  session: UploadSessionSummary;
  progressPercent?: number;
};

type LocalMultipartResumeRecord = {
  version: 1;
  contentId: string;
  sessionId: string;
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  fileType: string;
  sha256: string;
  headSha256: string;
  tailSha256: string;
  partSize: number;
  totalParts: number;
  expiresAt: string;
  updatedAt: string;
};

const MULTIPART_FINGERPRINT_SAMPLE_BYTES = 1024 * 1024;
const MULTIPART_HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const MULTIPART_MAX_RETRIES = 5;
const MULTIPART_DEFAULT_CONCURRENCY = 3;
const MULTIPART_RESUME_STORAGE_PREFIX = "vod_multipart_resume";

function multipartResumeStorageKey(contentId: string): string {
  return `${MULTIPART_RESUME_STORAGE_PREFIX}:${contentId}:full_source`;
}

function readPersistedMultipartResume(contentId: string): LocalMultipartResumeRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(multipartResumeStorageKey(contentId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalMultipartResumeRecord;
    if (parsed?.contentId !== contentId || !parsed?.sessionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistMultipartResume(record: LocalMultipartResumeRecord): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(multipartResumeStorageKey(record.contentId), JSON.stringify(record));
}

function clearPersistedMultipartResume(contentId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(multipartResumeStorageKey(contentId));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "-";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "-";
  const totalSeconds = Math.max(1, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function normalizePartEtag(value: string | null | undefined): string | null {
  if (!value) return null;
  return String(value).replace(/^W\//, "").replace(/^"|"$/g, "").trim() || null;
}

function parseIntString(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getPartBounds(fileSize: number, partSize: number, partNumber: number) {
  const start = (partNumber - 1) * partSize;
  const end = Math.min(fileSize, start + partSize);
  return {
    start,
    end,
    bytes: Math.max(0, end - start),
  };
}

function humanizeUploadSessionStatus(status: UploadSessionSummary["status"] | null | undefined): string {
  if (status === "paused") return "已暂停";
  if (status === "uploading") return "上传中";
  if (status === "initiated") return "待上传";
  if (status === "completing") return "正在合并";
  if (status === "completed") return "已完成";
  if (status === "cancelled") return "已取消";
  if (status === "expired") return "已过期";
  if (status === "failed") return "失败";
  return "待处理";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function digestBlobSha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function digestBlobSha256Base64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  let binary = "";
  const bytes = new Uint8Array(digest);
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

async function computeFileEdgeFingerprint(file: File): Promise<{ headSha256: string; tailSha256: string }> {
  const sampleBytes = Math.max(1, Math.min(MULTIPART_FINGERPRINT_SAMPLE_BYTES, file.size || MULTIPART_FINGERPRINT_SAMPLE_BYTES));
  const [headSha256, tailSha256] = await Promise.all([
    digestBlobSha256Hex(file.slice(0, sampleBytes)),
    digestBlobSha256Hex(file.slice(Math.max(0, file.size - sampleBytes), file.size)),
  ]);
  return { headSha256, tailSha256 };
}

async function computeFileFingerprint(
  file: File,
  onProgress?: (processedBytes: number, totalBytes: number) => void,
): Promise<{ sha256: string; headSha256: string; tailSha256: string }> {
  const worker = new Worker(new URL("../workers/uploadHashWorker.ts", import.meta.url), { type: "module" });
  return await new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<any>) => {
      const payload = event.data || {};
      if (payload.type === "progress") {
        onProgress?.(Number(payload.processedBytes || 0), Number(payload.totalBytes || file.size || 0));
        return;
      }
      if (payload.type === "done") {
        worker.terminate();
        resolve({
          sha256: String(payload.sha256 || ""),
          headSha256: String(payload.headSha256 || ""),
          tailSha256: String(payload.tailSha256 || ""),
        });
        return;
      }
      if (payload.type === "error") {
        worker.terminate();
        reject(new Error(String(payload.message || "文件指纹计算失败")));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("文件指纹计算失败"));
    };
    worker.postMessage({
      type: "fingerprint",
      file,
      chunkSize: MULTIPART_HASH_CHUNK_BYTES,
      sampleSize: MULTIPART_FINGERPRINT_SAMPLE_BYTES,
    });
  });
}

function mapApiMediaKind(kind: ApiMediaKind): MediaAssetKind {
  if (kind === "cover") return "cover_image";
  if (kind === "preview_source") return "preview_video";
  return "full_video";
}

function mapUiMediaKind(kind: MediaAssetKind): ApiMediaKind {
  if (kind === "cover_image") return "cover";
  if (kind === "preview_video") return "preview_source";
  return "full_source";
}

function mapApiMediaStatus(status: ApiMediaStatus): MediaAssetStatus {
  if (status === "verified") return "ready";
  if (status === "failed") return "failed";
  if (status === "deleted") return "deleted";
  return "uploading";
}

export async function initMediaUpload(contentId: string, req: InitMediaUploadReq): Promise<InitMediaUploadResp> {
  const res = await http.post(`/admin/contents/${encodeURIComponent(contentId)}/assets/upload-session`, req, { timeout: 20_000 });
  return res.data;
}

export async function initiateMultipartMediaUpload(contentId: string, req: InitMediaUploadReq): Promise<MultipartUploadInitResp> {
  const res = await http.post(`/admin/contents/${encodeURIComponent(contentId)}/assets/multipart/initiate`, req, { timeout: 30_000 });
  return res.data;
}

export async function signMultipartUploadPart(
  sessionId: string,
  partNumber: number,
  checksumSha256?: string | null,
): Promise<{ uploadSessionId: string; partNumber: number; uploadUrl: string; uploadExpiresAt: string; expectedHttpHeaders: Record<string, string> }> {
  const res = await http.post(`/admin/upload-sessions/${encodeURIComponent(sessionId)}/parts/${partNumber}/sign`, { checksumSha256: checksumSha256 || null }, { timeout: 20_000 });
  return res.data;
}

export async function getMultipartUploadSession(sessionId: string): Promise<MultipartSessionResp> {
  const res = await http.get(`/admin/upload-sessions/${encodeURIComponent(sessionId)}`, { timeout: 20_000 });
  return res.data;
}

export async function pauseMultipartUpload(sessionId: string): Promise<MultipartSessionResp> {
  const res = await http.post(`/admin/upload-sessions/${encodeURIComponent(sessionId)}/pause`, {}, { timeout: 20_000 });
  return res.data;
}

export async function resumeMultipartUpload(sessionId: string): Promise<MultipartSessionResp> {
  const res = await http.post(`/admin/upload-sessions/${encodeURIComponent(sessionId)}/resume`, {}, { timeout: 20_000 });
  return res.data;
}

export async function abortMultipartUpload(sessionId: string): Promise<MultipartSessionResp> {
  const res = await http.post(`/admin/upload-sessions/${encodeURIComponent(sessionId)}/abort`, {}, { timeout: 20_000 });
  return res.data;
}

export async function completeMultipartUpload(sessionId: string): Promise<CompleteMediaUploadResp> {
  const res = await http.post(`/admin/upload-sessions/${encodeURIComponent(sessionId)}/complete`, {}, { timeout: 60_000 });
  return res.data;
}

function normalizeMediaAsset(raw: any): MediaAssetItem {
  return {
    id: String(raw?.id || ""),
    kind: mapApiMediaKind(raw?.kind as ApiMediaKind),
    originalFilename: String(raw?.filename || "未命名文件"),
    mimeType: raw?.mimeType || null,
    contentLength: Number(raw?.byteSize || 0),
    source: raw?.source === "legacy" ? "legacy" : "vod",
    previewPath: typeof raw?.previewPath === "string" ? raw.previewPath : null,
    status: mapApiMediaStatus((raw?.status || "uploading") as ApiMediaStatus),
    lastErrorClass: raw?.errorClass || raw?.transcode?.errorClass || null,
    lastVerifiedAt: raw?.verifiedAt || null,
    createdAt: raw?.createdAt || null,
    transcodeJobId: raw?.transcode?.id || null,
    transcodeStatus: raw?.transcode?.status || null,
    transcodeProgressPercent: typeof raw?.transcode?.progressPercent === "number" ? raw.transcode.progressPercent : 0,
    transcodeErrorClass: raw?.transcode?.errorClass || null,
    renditions: Array.isArray(raw?.renditions) ? raw.renditions : [],
  };
}

function humanizeTranscodeStatus(asset: MediaAssetItem): string {
  if (asset.transcodeStatus === "ready") return "可发布";
  if (asset.transcodeStatus === "processing") return `转码中 ${asset.transcodeProgressPercent || 0}%`;
  if (asset.transcodeStatus === "failed") return "转码失败";
  if (asset.transcodeStatus === "queued") return "等待转码";
  return asset.status === "ready" ? "等待转码" : "未开始";
}

function transcodeStatusTagColor(asset: MediaAssetItem): string {
  if (asset.transcodeStatus === "ready") return "green";
  if (asset.transcodeStatus === "processing") return "processing";
  if (asset.transcodeStatus === "failed") return "red";
  if (asset.transcodeStatus === "queued") return "gold";
  return "default";
}

function humanizeRenditionKind(kind: string): string {
  switch (kind) {
    case "preview": return "试看";
    case "hls_1080": return "1080p";
    case "hls_720": return "720p";
    case "hls_480": return "480p";
    default: return kind;
  }
}

function humanizeRenditionStatus(status: string): string {
  switch (status) {
    case "ready": return "就绪";
    case "processing": return "转码中";
    case "failed": return "失败";
    case "deleted": return "已删除";
    default: return "等待中";
  }
}
export async function completeMediaUpload(contentId: string, req: CompleteMediaUploadReq): Promise<CompleteMediaUploadResp> {
  const res = await http.post(`/admin/contents/${encodeURIComponent(contentId)}/assets/complete`, req, { timeout: 30_000 });
  return res.data;
}
export async function listContentMedia(contentId: string): Promise<ContentMediaResp> {
  const res = await http.get(`/admin/contents/${encodeURIComponent(contentId)}/media`);
  return res.data;
}
export async function deleteContentMedia(contentId: string, assetId: string): Promise<{ ok: true; asset: any }> {
  const res = await http.delete(`/admin/contents/${encodeURIComponent(contentId)}/assets/${encodeURIComponent(assetId)}`);
  return res.data;
}
export async function retryTranscodeJob(jobId: string): Promise<TranscodeJobActionResp> {
  const res = await http.post(`/admin/transcode-jobs/${encodeURIComponent(jobId)}/retry`, {});
  return res.data;
}
export async function cancelTranscodeJob(jobId: string): Promise<TranscodeJobActionResp> {
  const res = await http.post(`/admin/transcode-jobs/${encodeURIComponent(jobId)}/cancel`, {});
  return res.data;
}
export async function startTelegramPublish(contentId: string, req: StartTelegramPublishReq): Promise<StartTelegramPublishResp> {
  return startAdminTelegramPublish(contentId, req as any);
}

async function computeFileSha256Hex(file: File): Promise<string> {
  const { sha256 } = await computeFileFingerprint(file);
  return sha256;
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
  { value: "single", label: "单篇解锁" },
  { value: "membership", label: "会员专享" },
  { value: "package", label: "打包内含" },
];

type AccessTypeForSelect = "public" | "membership" | "package" | "single";
type OpsTagFilter = "recommended" | "featured" | "new" | undefined;

const ContentsPage: React.FC = () => {
  const [viewportWidth, setViewportWidth] = React.useState<number>(() => (typeof window !== "undefined" ? window.innerWidth : 1440));
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
  const [editorTab, setEditorTab] = React.useState("basic");
  const [editing, setEditing] = React.useState<ContentItem | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = React.useState(false);

  const [categories, setCategories] = React.useState<CategoryItem[]>([]);
  const [packages, setPackages] = React.useState<AdminPackageItem[]>([]);
  const [freeChannels, setFreeChannels] = React.useState<FreeChannelOption[]>([]);
  const [me, setMe] = React.useState<AdminMe | null>(null);
  const [publishingTg, setPublishingTg] = React.useState(false);
  const [inputStates, setInputStates] = React.useState<Record<string, DelimitedInputState>>({});

  // ================== 素材上传 state ==================
  const [coverAssetId, setCoverAssetId] = React.useState<string | null>(null);
  const [coverAsset, setCoverAsset] = React.useState<MediaAssetItem | null>(null);
  // 仅允许把当前编辑内容的已校验素材写回内容。抽屉切换、网络重试期间，
  // 旧内容的 React state 不能作为新内容的素材引用提交。
  const [coverAssetContentId, setCoverAssetContentId] = React.useState<string | null>(null);
  const [coverProgress, setCoverProgress] = React.useState<number>(0);
  const [coverUploading, setCoverUploading] = React.useState(false);

  const [previewAssetId, setPreviewAssetId] = React.useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = React.useState<MediaAssetItem | null>(null);
  const [previewProgress, setPreviewProgress] = React.useState<number>(0);
  const [previewUploading, setPreviewUploading] = React.useState(false);

  const [fullVideoAssetId, setFullVideoAssetId] = React.useState<string | null>(null);
  const [fullVideoAsset, setFullVideoAsset] = React.useState<MediaAssetItem | null>(null);
  const [fullVideoSegments, setFullVideoSegments] = React.useState<MediaAssetItem[]>([]);
  const [fullVideoProgress, setFullVideoProgress] = React.useState<number>(0);
  const [fullVideoUploading, setFullVideoUploading] = React.useState(false);
  const [fullVideoFingerprinting, setFullVideoFingerprinting] = React.useState(false);
  const [fullVideoSession, setFullVideoSession] = React.useState<UploadSessionSummary | null>(null);
  const [fullVideoResumeRecord, setFullVideoResumeRecord] = React.useState<LocalMultipartResumeRecord | null>(null);
  const [fullVideoUploadedBytes, setFullVideoUploadedBytes] = React.useState(0);
  const [fullVideoTotalBytes, setFullVideoTotalBytes] = React.useState(0);
  const [fullVideoSpeedBps, setFullVideoSpeedBps] = React.useState(0);
  const [fullVideoEtaSeconds, setFullVideoEtaSeconds] = React.useState<number | null>(null);
  const [fullVideoStatusHint, setFullVideoStatusHint] = React.useState<string>("");
  const [fullVideoUploadError, setFullVideoUploadError] = React.useState<string | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = React.useState<string | null>(null);
  const fullVideoActiveRequestsRef = React.useRef<Map<number, XMLHttpRequest>>(new Map());
  const fullVideoActiveLoadedBytesRef = React.useRef<Map<number, number>>(new Map());
  const fullVideoCompletedBytesRef = React.useRef(0);
  const fullVideoProgressSampleRef = React.useRef({ ts: 0, bytes: 0 });
  const fullVideoRunIdRef = React.useRef(0);
  const fullVideoControlRef = React.useRef<{ action: "none" | "pause" | "cancel" }>({ action: "none" });
  const lastFullVideoFileRef = React.useRef<File | null>(null);

  // ================== 发布任务 state ==================
  const [channelKinds, setChannelKinds] = React.useState<Array<TelegramPublishJobItem["channelKind"]>>([]);
  const [publishJobs, setPublishJobs] = React.useState<TelegramPublishJobItem[]>([]);
  const [publishJobsLoading, setPublishJobsLoading] = React.useState(false);
  const [startPublishing, setStartPublishing] = React.useState(false);
  const [lastNormalizedTelegramTags, setLastNormalizedTelegramTags] = React.useState<string[]>([]);
  const [publishJobsRefreshTimer, setPublishJobsRefreshTimer] = React.useState<number | null>(null);
  const [channelMessages, setChannelMessages] = React.useState<ChannelMessageItem[]>([]);
  const [currentChannelLink, setCurrentChannelLink] = React.useState<ChannelMessageItem | null>(null);
  const [channelMessagesLoading, setChannelMessagesLoading] = React.useState(false);
  const [linkingChannelMessageId, setLinkingChannelMessageId] = React.useState<string | null>(null);

  const updateInputState = React.useCallback((field: string, state: DelimitedInputState) => {
    setInputStates((prev) => ({ ...prev, [field]: state }));
  }, []);

  const hasInputErrors = React.useCallback((fields: string[]) => {
    return fields.some((field) => (inputStates[field]?.errors?.length || 0) > 0);
  }, [inputStates]);

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

  React.useEffect(() => {
    const syncViewportWidth = () => setViewportWidth(window.innerWidth);
    syncViewportWidth();
    window.addEventListener("resize", syncViewportWidth);
    return () => window.removeEventListener("resize", syncViewportWidth);
  }, []);

  const drawerWidth = viewportWidth <= 768 ? "100vw" : 760;
  const drawerBodyPadding = viewportWidth <= 768 ? 16 : 24;

  const accessTypeValue = Form.useWatch("accessType", form);
  const packageIdValue = Form.useWatch("packageId", form);

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
      passed: accessTypeValue === "public" || accessTypeValue === "single" || accessTypeValue === "membership" || accessTypeValue === "package",
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
      checks.push({
        key: "freeChannelPool",
        label: "免费流量频道池已配置",
        passed: freeChannels.length > 0,
        detail: freeChannels.length === 0
          ? "需由服务端启用至少一个免费频道；发布时会自动同步到全部已启用频道"
          : `发布时将自动同步到全部 ${freeChannels.length} 个已启用免费频道`,
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
  }, [accessTypeValue, selectedPackage, form, freeChannels]);

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

  const refreshContentMedia = React.useCallback(async (contentId: string) => {
    try {
      const resp = await listContentMedia(contentId);
      const items = Array.isArray(resp.items) ? resp.items.map(normalizeMediaAsset) : [];
      const uploadSessions = Array.isArray(resp.uploadSessions) ? resp.uploadSessions : [];
      const cover = items.find((item) => item.kind === "cover_image" && item.status !== "deleted") || null;
      const preview = items.find((item) => item.kind === "preview_video" && item.status !== "deleted") || null;
      const fulls = items.filter((item) => item.kind === "full_video" && item.status !== "deleted");
      const pendingFullSession = uploadSessions
        .filter((item) => item.assetKind === "full_source" && !["completed", "cancelled", "expired"].includes(item.status))
        .sort((a, b) => String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || "")))[0] || null;
      setCoverAsset(cover);
      setCoverAssetId(cover?.id || null);
      setCoverAssetContentId(cover?.id ? contentId : null);
      // 重新打开编辑页时没有本地 Object URL；应使用受控的站内预览地址。
      // 否则素材状态正确却只显示黑色占位框，误导运营以为上传失败。
      setCoverPreviewUrl(cover?.previewPath || null);
      setPreviewAsset(preview);
      setPreviewAssetId(preview?.id || null);
      setFullVideoSegments(fulls);
      setFullVideoAsset(fulls[0] || null);
      setFullVideoAssetId(fulls[0]?.id || null);
      setFullVideoSession(pendingFullSession);
      if (pendingFullSession) {
        const totalBytes = parseIntString(pendingFullSession.expectedSize);
        const uploadedBytes = parseIntString(pendingFullSession.uploadedBytes);
        setFullVideoTotalBytes(totalBytes);
        setFullVideoUploadedBytes(uploadedBytes);
        setFullVideoProgress(totalBytes > 0 ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)) : 0);
        if (!fullVideoUploading) {
          setFullVideoStatusHint(`发现未完成上传：${humanizeUploadSessionStatus(pendingFullSession.status)}`);
        }
      } else if (!fullVideoUploading) {
        setFullVideoStatusHint(fulls[0]?.status === "ready" ? "完整源视频已校验完成" : "");
      }
      const persisted = readPersistedMultipartResume(contentId);
      setFullVideoResumeRecord(persisted);
      if (!pendingFullSession && persisted) {
        clearPersistedMultipartResume(contentId);
        setFullVideoResumeRecord(null);
      }
    } catch {
      setCoverAsset(null);
      setCoverAssetId(null);
      setCoverAssetContentId(null);
      setCoverPreviewUrl(null);
      setPreviewAsset(null);
      setPreviewAssetId(null);
      setFullVideoSegments([]);
      setFullVideoAsset(null);
      setFullVideoAssetId(null);
      setFullVideoSession(null);
      setFullVideoResumeRecord(readPersistedMultipartResume(contentId));
    }
  }, [fullVideoUploading]);

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
    setCoverAssetId(null); setCoverAsset(null); setCoverAssetContentId(null); setCoverProgress(0); setCoverUploading(false);
    setPreviewAssetId(null); setPreviewAsset(null); setPreviewProgress(0); setPreviewUploading(false);
    setFullVideoAssetId(null); setFullVideoAsset(null); setFullVideoSegments([]); setFullVideoProgress(0); setFullVideoUploading(false);
    setFullVideoFingerprinting(false);
    setFullVideoSession(null);
    setFullVideoResumeRecord(null);
    setFullVideoUploadedBytes(0);
    setFullVideoTotalBytes(0);
    setFullVideoSpeedBps(0);
    setFullVideoEtaSeconds(null);
    setFullVideoStatusHint("");
    setFullVideoUploadError(null);
    setCoverPreviewUrl(null);
    fullVideoActiveRequestsRef.current.forEach((xhr) => {
      try { xhr.abort(); } catch {}
    });
    fullVideoActiveRequestsRef.current.clear();
    fullVideoActiveLoadedBytesRef.current.clear();
    fullVideoCompletedBytesRef.current = 0;
    fullVideoProgressSampleRef.current = { ts: 0, bytes: 0 };
    fullVideoRunIdRef.current += 1;
    fullVideoControlRef.current = { action: "none" };
    lastFullVideoFileRef.current = null;
  }, []);

  const openCreate = () => {
    setEditing(null);
    setEditorTab("basic");
    setChannelKinds([]);
    setInputStates({});
    setLastNormalizedTelegramTags([]);
    resetMediaState();
    form.resetFields();
    setCurrentChannelLink(null);
    setChannelMessages([]);
    form.setFieldsValue({
      // 首发的主路径是「付费完整视频 + 可选试看」；公开类型仅用于引流，
      // 不应作为新建内容的默认项，否则完整视频上传会被禁用而让运营无所适从。
      accessType: "membership" as AccessTypeForSelect,
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
      previewEnabled: true,
      previewDurationSeconds: 60,
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: ContentItem) => {
    setEditing(row);
    setEditorTab("basic");
    resetMediaState();
    setChannelKinds([]);
    setInputStates({});
    setLastNormalizedTelegramTags([]);
    setCurrentChannelLink(null);
    setChannelMessages([]);
    // 默认勾选与 accessType 匹配的 channel kinds
    const defaultKinds: Array<TelegramPublishJobItem["channelKind"]> = [];
    if (row.accessType === "membership") defaultKinds.push("membership_full");
    if (row.accessType === "package") defaultKinds.push("package_full");
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
      previewEnabled: row.previewEnabled !== false,
      previewDurationSeconds: row.previewDurationSeconds || 60,
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
      telegramTags: [],
    });
    void refreshContentMedia(row.id);
    setDrawerOpen(true);
  };

  const updateFullVideoMetrics = React.useCallback((uploadedBytes: number, totalBytes: number) => {
    const safeUploaded = Math.max(0, uploadedBytes);
    const safeTotal = Math.max(0, totalBytes);
    const now = Date.now();
    const prev = fullVideoProgressSampleRef.current;
    const elapsedMs = prev.ts > 0 ? now - prev.ts : 0;
    const deltaBytes = prev.ts > 0 ? safeUploaded - prev.bytes : 0;
    const speedBps = elapsedMs >= 400 && deltaBytes >= 0 ? (deltaBytes * 1000) / elapsedMs : fullVideoSpeedBps;
    const remainingBytes = Math.max(0, safeTotal - safeUploaded);
    setFullVideoUploadedBytes(safeUploaded);
    setFullVideoTotalBytes(safeTotal);
    setFullVideoProgress(safeTotal > 0 ? Math.min(100, Math.round((safeUploaded / safeTotal) * 100)) : 0);
    setFullVideoSpeedBps(Number.isFinite(speedBps) ? speedBps : 0);
    setFullVideoEtaSeconds(speedBps > 0 ? remainingBytes / speedBps : null);
    fullVideoProgressSampleRef.current = { ts: now, bytes: safeUploaded };
  }, [fullVideoSpeedBps]);

  const syncFullVideoSessionState = React.useCallback((session: UploadSessionSummary | null, fallbackFilename?: string | null) => {
    setFullVideoSession(session);
    if (!session) return;
    const totalBytes = parseIntString(session.expectedSize);
    const uploadedFromParts = Array.isArray(session.parts)
      ? session.parts.reduce((sum, item) => sum + parseIntString(item.bytes), 0)
      : 0;
    const uploadedBytes = Math.max(parseIntString(session.uploadedBytes), uploadedFromParts);
    fullVideoCompletedBytesRef.current = uploadedBytes;
    fullVideoActiveLoadedBytesRef.current.clear();
    updateFullVideoMetrics(uploadedBytes, totalBytes);
    setFullVideoStatusHint(
      session.status === "completed"
        ? "完整源视频已完成分片合并"
        : session.status === "paused"
          ? "上传已暂停，可继续"
          : session.status === "completing"
            ? "分片已齐，正在完成合并"
            : `${fallbackFilename || session.filename || "完整源视频"}：${humanizeUploadSessionStatus(session.status)}`,
    );
  }, [updateFullVideoMetrics]);

  const uploadPartWithSignedUrl = React.useCallback(async (
    uploadUrl: string,
    headers: Record<string, string>,
    blob: Blob,
    partNumber: number,
    runId: number,
  ): Promise<string | null> => {
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      fullVideoActiveRequestsRef.current.set(partNumber, xhr);
      fullVideoActiveLoadedBytesRef.current.set(partNumber, 0);
      xhr.open("PUT", uploadUrl, true);
      Object.entries(headers || {}).forEach(([key, value]) => {
        try { xhr.setRequestHeader(key, value); } catch {}
      });
      xhr.upload.onprogress = (event) => {
        if (runId !== fullVideoRunIdRef.current) return;
        const loaded = event.lengthComputable ? Math.max(0, Number(event.loaded || 0)) : 0;
        fullVideoActiveLoadedBytesRef.current.set(partNumber, loaded);
        const activeLoaded = Array.from(fullVideoActiveLoadedBytesRef.current.values()).reduce((sum, value) => sum + value, 0);
        updateFullVideoMetrics(fullVideoCompletedBytesRef.current + activeLoaded, fullVideoTotalBytes || blob.size);
      };
      xhr.onload = () => {
        fullVideoActiveRequestsRef.current.delete(partNumber);
        fullVideoActiveLoadedBytesRef.current.delete(partNumber);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(normalizePartEtag(xhr.getResponseHeader("ETag")));
          return;
        }
        reject(new Error(`分片 ${partNumber} 上传失败（HTTP ${xhr.status}）`));
      };
      xhr.onerror = () => {
        fullVideoActiveRequestsRef.current.delete(partNumber);
        fullVideoActiveLoadedBytesRef.current.delete(partNumber);
        reject(new Error(`分片 ${partNumber} 上传时网络中断`));
      };
      xhr.onabort = () => {
        fullVideoActiveRequestsRef.current.delete(partNumber);
        fullVideoActiveLoadedBytesRef.current.delete(partNumber);
        reject(new Error("__multipart_aborted__"));
      };
      xhr.send(blob);
    });
  }, [fullVideoTotalBytes, updateFullVideoMetrics]);

  const runMultipartUpload = React.useCallback(async (
    file: File,
    sessionSeed: UploadSessionSummary,
    resumeRecord: LocalMultipartResumeRecord,
  ) => {
    const runId = fullVideoRunIdRef.current + 1;
    fullVideoRunIdRef.current = runId;
    fullVideoControlRef.current = { action: "none" };
    fullVideoActiveRequestsRef.current.clear();
    fullVideoActiveLoadedBytesRef.current.clear();
    fullVideoProgressSampleRef.current = { ts: 0, bytes: fullVideoCompletedBytesRef.current };
    lastFullVideoFileRef.current = file;
    setFullVideoUploading(true);
    setFullVideoFingerprinting(false);
    setFullVideoUploadError(null);
    try {
      const latest = await getMultipartUploadSession(sessionSeed.id);
      if (runId !== fullVideoRunIdRef.current) return;
      let session = latest.session;
      syncFullVideoSessionState(session, file.name);
      const totalParts = session.totalParts || resumeRecord.totalParts;
      const partSize = session.partSize || resumeRecord.partSize;
      const totalBytes = file.size;
      const uploadedPartNumbers = new Set((session.parts || []).map((part) => part.partNumber));
      const pendingPartNumbers: number[] = [];
      for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
        if (!uploadedPartNumbers.has(partNumber)) pendingPartNumbers.push(partNumber);
      }
      const concurrency = Math.min(MULTIPART_DEFAULT_CONCURRENCY, totalParts || MULTIPART_DEFAULT_CONCURRENCY);
      const uploadNextPart = async () => {
        while (pendingPartNumbers.length > 0) {
          if (runId !== fullVideoRunIdRef.current) return;
          if (fullVideoControlRef.current.action !== "none") return;
          const partNumber = pendingPartNumbers.shift();
          if (!partNumber) return;
          const { start, end, bytes } = getPartBounds(totalBytes, partSize, partNumber);
          const blob = file.slice(start, end);
          let uploaded = false;
          for (let attempt = 0; attempt < MULTIPART_MAX_RETRIES && !uploaded; attempt += 1) {
            if (fullVideoControlRef.current.action !== "none") return;
            try {
              setFullVideoStatusHint(`正在上传分片 ${partNumber}/${totalParts}${attempt > 0 ? `（重试 ${attempt + 1}/${MULTIPART_MAX_RETRIES}）` : ""}`);
              const checksumSha256 = await digestBlobSha256Base64(blob);
              const signed = await signMultipartUploadPart(session.id, partNumber, checksumSha256);
              await uploadPartWithSignedUrl(signed.uploadUrl, signed.expectedHttpHeaders || {}, blob, partNumber, runId);
              fullVideoCompletedBytesRef.current += bytes;
              updateFullVideoMetrics(fullVideoCompletedBytesRef.current, totalBytes);
              const synced = await getMultipartUploadSession(session.id);
              if (runId !== fullVideoRunIdRef.current) return;
              session = synced.session;
              syncFullVideoSessionState(session, file.name);
              uploaded = true;
            } catch (error: any) {
              if (String(error?.message || "") === "__multipart_aborted__") {
                if (fullVideoControlRef.current.action !== "none") return;
                throw error;
              }
              if (attempt >= MULTIPART_MAX_RETRIES - 1) {
                throw error;
              }
              const delayMs = Math.min(8000, 500 * (2 ** attempt));
              setFullVideoStatusHint(`分片 ${partNumber} 上传失败，${Math.round(delayMs / 1000)} 秒后自动重试`);
              await sleep(delayMs);
            }
          }
        }
      };

      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => uploadNextPart()));
      if (runId !== fullVideoRunIdRef.current) return;
      if (fullVideoControlRef.current.action === "pause" || fullVideoControlRef.current.action === "cancel") return;
      setFullVideoStatusHint("所有分片已上传，正在完成合并");
      const completion = await completeMultipartUpload(session.id);
      if (runId !== fullVideoRunIdRef.current) return;
      const verified = normalizeMediaAsset(completion.asset);
      setFullVideoAssetId(verified.id);
      setFullVideoAsset(verified);
      setFullVideoSegments((current) => current.some((item) => item.id === verified.id) ? current : [...current, verified]);
      setFullVideoProgress(100);
      setFullVideoSpeedBps(0);
      setFullVideoEtaSeconds(0);
      setFullVideoStatusHint("完整源视频上传并校验完成，已进入转码排队");
      setFullVideoSession(null);
      clearPersistedMultipartResume(resumeRecord.contentId);
      setFullVideoResumeRecord(null);
      await refreshContentMedia(resumeRecord.contentId);
      message.success("完整源视频已完成分片上传与校验");
    } catch (error: any) {
      if (fullVideoControlRef.current.action === "pause" || fullVideoControlRef.current.action === "cancel") return;
      setFullVideoUploadError(errMsg(error, "完整源视频上传失败"));
      setFullVideoStatusHint("上传中断，可重试或继续上传");
      message.error(errMsg(error, "完整源视频上传失败"));
    } finally {
      if (runId === fullVideoRunIdRef.current) {
        setFullVideoUploading(false);
        setFullVideoFingerprinting(false);
        fullVideoActiveRequestsRef.current.clear();
        fullVideoActiveLoadedBytesRef.current.clear();
        setFullVideoSpeedBps(0);
      }
    }
  }, [refreshContentMedia, syncFullVideoSessionState, updateFullVideoMetrics, uploadPartWithSignedUrl]);

  const startOrResumeFullVideoUpload = React.useCallback(async (file: File) => {
    if (!canEdit) {
      message.error("当前角色无 content:edit 权限，不能上传素材");
      return Upload.LIST_IGNORE;
    }
    if (!editing?.id) {
      message.error("请先保存基础信息，再上传媒体文件");
      return Upload.LIST_IGNORE;
    }
    if (file.size > 8 * 1024 * 1024 * 1024) {
      message.error("完整源视频尚未完成超大文件验收，当前暂不接受超过 8GB 的源文件");
      return Upload.LIST_IGNORE;
    }

    const persisted = readPersistedMultipartResume(editing.id);
    const activeSessionId = fullVideoSession?.id || persisted?.sessionId || null;
    const resumable = Boolean(
      persisted &&
      activeSessionId &&
      persisted.sessionId === activeSessionId &&
      fullVideoSession &&
      !["completed", "cancelled", "expired"].includes(fullVideoSession.status),
    );

    setFullVideoUploadError(null);
    setFullVideoStatusHint("");
    setFullVideoProgress(0);
    lastFullVideoFileRef.current = file;

    if (resumable && persisted && fullVideoSession) {
      if (file.name !== persisted.fileName || file.size !== persisted.fileSize || file.lastModified !== persisted.fileLastModified) {
        message.error("所选文件与上次未完成上传的文件不一致，请选择同一文件继续，或先点击“放弃上传”");
        return Upload.LIST_IGNORE;
      }
      setFullVideoFingerprinting(true);
      setFullVideoStatusHint("正在校验续传文件指纹");
      try {
        const sample = await computeFileEdgeFingerprint(file);
        if (sample.headSha256 !== persisted.headSha256 || sample.tailSha256 !== persisted.tailSha256) {
          message.error("文件抽样校验未通过，无法续传到不同文件。请放弃旧会话后重新上传。");
          setFullVideoFingerprinting(false);
          setFullVideoStatusHint("文件校验失败，请重新选择同一文件");
          return Upload.LIST_IGNORE;
        }
        const resumed = fullVideoSession.status === "paused"
          ? await resumeMultipartUpload(fullVideoSession.id)
          : await getMultipartUploadSession(fullVideoSession.id);
        const refreshedRecord: LocalMultipartResumeRecord = {
          ...persisted,
          partSize: resumed.session.partSize || persisted.partSize,
          totalParts: resumed.session.totalParts || persisted.totalParts,
          expiresAt: resumed.session.expiresAt || persisted.expiresAt,
          updatedAt: new Date().toISOString(),
        };
        persistMultipartResume(refreshedRecord);
        setFullVideoResumeRecord(refreshedRecord);
        await runMultipartUpload(file, resumed.session, refreshedRecord);
      } catch (error) {
        setFullVideoFingerprinting(false);
        setFullVideoUploadError(errMsg(error, "恢复上传失败"));
        message.error(errMsg(error, "恢复上传失败"));
      }
      return Upload.LIST_IGNORE;
    }

    if (fullVideoSession && !["completed", "cancelled", "expired"].includes(fullVideoSession.status)) {
      message.warning("已发现未完成上传，请先继续上传或点击“放弃上传”终止旧会话后再上传新文件。");
      return Upload.LIST_IGNORE;
    }

    setFullVideoFingerprinting(true);
    setFullVideoStatusHint("正在分片计算文件指纹");
    try {
      const fingerprint = await computeFileFingerprint(file, (processedBytes, totalBytes) => {
        const percent = totalBytes > 0 ? Math.min(99, Math.round((processedBytes / totalBytes) * 100)) : 0;
        setFullVideoStatusHint(`正在分片计算文件指纹 ${percent}%`);
      });
      const initiated = await initiateMultipartMediaUpload(editing.id, {
        assetKind: "full_source",
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        byteSize: file.size,
        sha256: fingerprint.sha256,
      });
      const record: LocalMultipartResumeRecord = {
        version: 1,
        contentId: editing.id,
        sessionId: initiated.uploadSessionId,
        fileName: file.name,
        fileSize: file.size,
        fileLastModified: file.lastModified,
        fileType: file.type || "application/octet-stream",
        sha256: fingerprint.sha256,
        headSha256: fingerprint.headSha256,
        tailSha256: fingerprint.tailSha256,
        partSize: initiated.partSize,
        totalParts: initiated.totalParts,
        expiresAt: initiated.expiresAt,
        updatedAt: new Date().toISOString(),
      };
      persistMultipartResume(record);
      setFullVideoResumeRecord(record);
      const session: UploadSessionSummary = {
        id: initiated.uploadSessionId,
        contentId: editing.id,
        assetKind: "full_source",
        status: "initiated",
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        expectedSize: String(file.size),
        uploadedBytes: "0",
        totalParts: initiated.totalParts,
        partSize: initiated.partSize,
        storageUploadIdPresent: true,
        expiresAt: initiated.expiresAt,
        lastActivityAt: new Date().toISOString(),
        completedAt: null,
        parts: [],
      };
      await runMultipartUpload(file, session, record);
    } catch (error) {
      setFullVideoFingerprinting(false);
      setFullVideoUploading(false);
      setFullVideoUploadError(errMsg(error, "完整源视频初始化失败"));
      setFullVideoStatusHint("无法创建分片上传会话");
      message.error(errMsg(error, "完整源视频初始化失败"));
    }
    return Upload.LIST_IGNORE;
  }, [canEdit, editing?.id, fullVideoSession, runMultipartUpload]);

  const pauseFullVideoUpload = React.useCallback(async () => {
    if (!fullVideoSession?.id) return;
    fullVideoControlRef.current = { action: "pause" };
    setFullVideoStatusHint("正在暂停上传");
    fullVideoActiveRequestsRef.current.forEach((xhr) => {
      try { xhr.abort(); } catch {}
    });
    setFullVideoUploading(false);
    try {
      const paused = await pauseMultipartUpload(fullVideoSession.id);
      syncFullVideoSessionState(paused.session);
      setFullVideoStatusHint("上传已暂停，可继续");
    } catch (error) {
      setFullVideoUploadError(errMsg(error, "暂停上传失败"));
      message.error(errMsg(error, "暂停上传失败"));
    } finally {
      setFullVideoSpeedBps(0);
      setFullVideoEtaSeconds(null);
    }
  }, [fullVideoSession?.id, syncFullVideoSessionState]);

  const resumeFullVideoUpload = React.useCallback(async () => {
    if (!fullVideoSession?.id) {
      message.warning("当前没有可继续的上传会话");
      return;
    }
    const file = lastFullVideoFileRef.current;
    if (!file) {
      message.info("请重新选择同一文件继续上传");
      return;
    }
    await startOrResumeFullVideoUpload(file);
  }, [fullVideoSession?.id, startOrResumeFullVideoUpload]);

  const abortFullVideoUpload = React.useCallback(async () => {
    if (!editing?.id || !fullVideoSession?.id) return;
    fullVideoControlRef.current = { action: "cancel" };
    fullVideoActiveRequestsRef.current.forEach((xhr) => {
      try { xhr.abort(); } catch {}
    });
    setFullVideoUploading(false);
    setFullVideoStatusHint("正在放弃上传");
    try {
      await abortMultipartUpload(fullVideoSession.id);
      clearPersistedMultipartResume(editing.id);
      setFullVideoResumeRecord(null);
      setFullVideoSession(null);
      setFullVideoProgress(0);
      setFullVideoUploadedBytes(0);
      setFullVideoSpeedBps(0);
      setFullVideoEtaSeconds(null);
      setFullVideoUploadError(null);
      lastFullVideoFileRef.current = null;
      await refreshContentMedia(editing.id);
      message.success("已取消该次完整视频上传，会话不可恢复");
    } catch (error) {
      setFullVideoUploadError(errMsg(error, "取消上传失败"));
      message.error(errMsg(error, "取消上传失败"));
    }
  }, [editing?.id, fullVideoSession?.id, refreshContentMedia]);

  const retryFullVideoUpload = React.useCallback(async () => {
    if (!lastFullVideoFileRef.current) {
      message.info("请重新选择同一文件继续上传");
      return;
    }
    await startOrResumeFullVideoUpload(lastFullVideoFileRef.current);
  }, [startOrResumeFullVideoUpload]);

  React.useEffect(() => {
    if (!editing?.id) return;
    const persisted = readPersistedMultipartResume(editing.id);
    if (persisted) setFullVideoResumeRecord(persisted);
  }, [editing?.id]);

  React.useEffect(() => {
    if (!fullVideoUploading || !fullVideoSession?.id || !editing?.id) return;
    const handlePageHide = () => {
      try {
        navigator.sendBeacon?.(
          `/admin/upload-sessions/${encodeURIComponent(fullVideoSession.id)}/pause`,
          new Blob(["{}"], { type: "application/json" }),
        );
      } catch {}
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [editing?.id, fullVideoSession?.id, fullVideoUploading]);

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
    if (!editing?.id) {
      message.error("请先保存基础信息，再上传媒体文件");
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
      const sha256 = await computeFileSha256Hex(file);
      if (kind === "cover_image") {
        setCoverPreviewUrl(URL.createObjectURL(file));
      }
      const init = await initMediaUpload(editing.id, {
        assetKind: mapUiMediaKind(kind),
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        byteSize: file.size,
        sha256,
      });
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
      const comp = await completeMediaUpload(editing.id, { uploadSessionId: init.uploadSessionId, proof: { etag: "" } });
      const verified = normalizeMediaAsset(comp.asset);
      setters.setAssetId(verified.id);
      setters.setAsset(verified);
      if (kind === "cover_image") setCoverAssetContentId(editing.id);
      await refreshContentMedia(editing.id);
      message.success(`${kind === "cover_image" ? "封面" : kind === "preview_video" ? "试看源视频" : "完整源视频"}上传并校验完成`);
    } catch (e) {
      setters.setProgress(0);
      message.error(errMsg(e, kind === "cover_image" ? "封面上传失败" : kind === "preview_video" ? "试看源视频上传失败" : "完整源视频上传失败"));
    } finally {
      setters.setUploading(false);
    }
    return Upload.LIST_IGNORE;
  }, [canEdit, editing?.id, refreshContentMedia]);

  const onDrawerSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (hasInputErrors(["tags", "seoKeywords", "geoKeywords"])) {
        message.error("请先修正标签或 SEO / GEO 字段中的错误项");
        return;
      }
      setSubmitting(true);
      // VOD 阶段的封面由 VideoAsset 按 contentId 归属，不能写进旧
      // MediaAsset 外键（否则会把一个有效的 VOD cover 误判为“不存在”）。
      // 仅兼容历史 MediaAsset 时才携带 coverAssetId。
      const currentReadyCoverAssetId =
        coverAssetContentId === editing?.id && coverAsset?.status === "ready" && coverAsset?.source === "legacy"
          ? coverAsset.id
          : null;
      const payload: any = {
        ...values,
        tags: values.tags || [],
        seoKeywords: values.seoKeywords || [],
        geoKeywords: values.geoKeywords || [],
        fullVideoAssetId: fullVideoAssetId ?? null,
        fullVideoAssetIds: fullVideoSegments.map((asset) => asset.id),
        categoryIds: values.categoryIds || [],
        recommendStartsAt: values.recommendStartsAt ? values.recommendStartsAt.toISOString() : null,
        recommendEndsAt: values.recommendEndsAt ? values.recommendEndsAt.toISOString() : null,
        scheduledAt: values.scheduledAt ? values.scheduledAt.toISOString() : null,
        reason: editing ? `编辑内容：${editing.title}` : `新建内容：${values.title}`,
      };
      if (editing) {
        if (currentReadyCoverAssetId) payload.coverAssetId = currentReadyCoverAssetId;
      } else {
        payload.coverAssetId = currentReadyCoverAssetId;
      }
      if (editing) {
        await updateAdminContent(editing.id, payload);
        message.success("内容已更新");
        const refreshed = await getAdminContent(editing.id);
        setEditing(refreshed);
        refreshPublishJobs(editing.id);
        refreshContentMedia(editing.id);
      } else {
        const created = await createAdminContent(payload);
        const refreshed = await getAdminContent(created.id);
        setEditing(refreshed);
        refreshContentMedia(created.id);
        // 创建完成后保留当前上传状态，直接进入下一步，避免运营回列表再找一次内容。
        setEditorTab("media");
        message.success("视频已创建，请继续上传素材");
      }
      fetchList();
    } catch (e) {
      message.error(errMsg(e, editing ? "更新失败" : "创建失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const onDeleteMediaAsset = async (asset: MediaAssetItem | null) => {
    if (!editing?.id || !asset?.id) return;
    try {
      await deleteContentMedia(editing.id, asset.id);
      await refreshContentMedia(editing.id);
      message.success("媒体记录已软删除");
    } catch (e) {
      message.error(errMsg(e, "删除媒体失败"));
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
          const result = await publishAdminContent(row.id, "管理员发布内容");
          if (result.telegramPublish?.queued) {
            message.success(`已发布，Bot 已创建 ${result.telegramPublish.jobs?.length || 0} 条频道发送任务`);
          } else if (result.telegramPublish) {
            message.warning(`内容已发布，但频道发送任务未创建：${result.telegramPublish.message || result.telegramPublish.error || "请进入编辑页检查发布进度"}`);
          } else {
            message.success("已发布");
          }
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
      title: "封面",
      key: "cover",
      width: 88,
      render: (_: any, r) => {
        const src = r.coverPreviewPath || r.coverUrl || r.thumbnailUrl;
        if (!src) return <Text type="secondary">—</Text>;
        return (
          <img
            src={src}
            alt=""
            style={{ width: 76, height: 43, display: "block", objectFit: "cover", borderRadius: 6, background: "#f0f0f0" }}
            onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
          />
        );
      },
    },
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
          {!r.package?.title && !r.product?.title && r.accessType === "membership" && <Tag color="green">继承月度会员</Tag>}
          {!r.package?.title && !r.product?.title && r.accessType !== "public" && r.accessType !== "membership" && <Tag color="default">未绑定</Tag>}
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
    {
      title: "媒体托管",
      key: "privateVideo",
      width: 128,
      render: (_: any, r) => {
        const isPrivateContent = r.accessType === "membership" || r.accessType === "package";
        if (!isPrivateContent) return <Text type="secondary">—</Text>;
        return <Tag color="default">私有托管</Tag>;
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
          {r.status === "draft" && canEdit && (
            <Button
              size="small"
              icon={<SendOutlined />}
              onClick={() => confirmSubmitReview(r)}
            >
              提交审核
            </Button>
          )}
          {(r.status === "draft" || r.status === "in_review" || r.status === "scheduled") && canPublish && (
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
            <span>· 每条内容只上传一份完整源视频；系统会自动生成独立私有试看 HLS，未付费不会拿到完整版播放资产。</span>
            <span>· Web 平台播放为主，Telegram 私密频道仍保留为备用完整交付链路。</span>
            <span>· single（单篇解锁）走站内 HLS 权益校验；Telegram 私密频道不承载单条完整交付。</span>
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
              发布视频
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
        title={editing ? `编辑视频：${editing.title}` : "发布视频"}
        open={drawerOpen}
        onClose={() => !submitting && setDrawerOpen(false)}
        width={drawerWidth}
        destroyOnClose
        styles={{ body: { padding: drawerBodyPadding } }}
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)} disabled={submitting}>取消</Button>
            <Button type="primary" loading={submitting} onClick={onDrawerSubmit} disabled={!canEdit}>
              {editing ? "保存视频信息" : "保存并上传素材"}
            </Button>
          </Space>
        }
      >
        <Tabs
          activeKey={editorTab}
          onChange={setEditorTab}
          items={[
            // ==================== Tab 1：基本信息（原 Form + 发布前检查） ====================
            {
              key: "basic",
              label: <Space><span>① 视频信息</span>{accessTypeValue === "single" && <Tag color="blue">single·站内解锁</Tag>}</Space>,
              children: (
                <Form form={form} layout="vertical" preserve={false}>
                  <Alert
                    type="info"
                    showIcon
                    message="只需三步：填写标题与试看策略 → 上传完整源视频 → 选择交付方式"
                    description="每条内容只上传一份完整源视频；系统会自动生成独立私有试看 HLS。SEO、排序、运营标签等不影响首次上传，可在保存后再补充。"
                    style={{ marginBottom: 16 }}
                  />
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
                      <Select>
                        {ACCESS_TYPE_OPTIONS.map((o) => (
                          <Option key={o.value} value={o.value}>{o.label}</Option>
                        ))}
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

                  <Space direction="vertical" size={12} style={{ width: "100%", marginBottom: 12 }}>
                    <Alert
                      type="info"
                      showIcon
                      icon={<InfoCircleOutlined />}
                      message={
                        accessTypeValue === "public"
                          ? "公开内容会基于完整源视频自动生成试看 HLS；未付费用户不会拿到完整版播放会话。"
                          : accessTypeValue === "single"
                            ? "single 会走站内 HLS 单条权益校验；不会向 Telegram 私密频道投放单条完整视频。"
                            : "完整视频上传并转码后，未付费用户只会获得试看播放会话；已购/会员用户才会获得完整版会话。"
                      }
                    />
                  </Space>

                  <Card
                    size="small"
                    title="试看策略"
                    style={{ marginBottom: 24 }}
                  >
                    <Space size={16} style={{ width: "100%" }} align="start">
                      <Form.Item name="previewEnabled" label="启用试看" valuePropName="checked" style={{ marginBottom: 0 }}>
                        <Switch checkedChildren="启用" unCheckedChildren="关闭" />
                      </Form.Item>
                      <Form.Item name="previewDurationSeconds" label="试看时长" style={{ flex: 1, marginBottom: 0 }}>
                        <Select>
                          <Option value={30}>30 秒</Option>
                          <Option value={60}>60 秒</Option>
                          <Option value={90}>90 秒</Option>
                        </Select>
                      </Form.Item>
                    </Space>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginTop: 12 }}
                      message="系统会从完整源视频起点自动生成独立私有试看 HLS"
                      description="源片短于设定时长时会自动取全长。试看限制完全在服务端产物层实现，不依赖前端播放器裁剪完整版。"
                    />
                  </Card>

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
                    <DelimitedTagInput
                      mode="telegram"
                      selectPlaceholder="输入标签后回车"
                      textareaPlaceholder="支持直接粘贴逗号分隔标签；会按 Telegram 规则规范化。"
                      previewLabel="发布到 Telegram 时将显示为"
                      onStateChange={(state) => updateInputState("tags", state)}
                    />
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
                        <DelimitedTagInput
                          mode="keyword"
                          selectPlaceholder="输入 SEO 关键词后回车，未填则继承平台默认关键词"
                          textareaPlaceholder="支持直接粘贴逗号分隔关键词；词组空格会保留。"
                          onStateChange={(state) => updateInputState("seoKeywords", state)}
                        />
                      </Form.Item>
                      <Form.Item name="geoKeywords" label="GEO 主题词">
                        <DelimitedTagInput
                          mode="keyword"
                          selectPlaceholder="输入生成式搜索主题词后回车，未填则继承平台默认主题词"
                          textareaPlaceholder="支持直接粘贴逗号分隔主题词；词组空格会保留。"
                          onStateChange={(state) => updateInputState("geoKeywords", state)}
                        />
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

                    {accessTypeValue === "membership" ? (
                      <Alert
                        type="success"
                        showIcon
                        message="自动使用平台默认月度会员"
                        description="无需填写商品 ID。用户购买月度会员后即可观看全部会员专享内容。"
                        style={{ flex: 1 }}
                      />
                    ) : accessTypeValue === "single" ? (
                      <Form.Item
                        name="productId"
                        label="单篇商品 ID（必填）"
                        rules={[{ required: true, message: "single 类型必须绑定单篇商品" }]}
                        style={{ flex: 1 }}
                      >
                        <Input placeholder="绑定 type=single 的商品 ID" />
                      </Form.Item>
                    ) : accessTypeValue === "public" ? (
                      <Form.Item name="productId" label="关联商品 ID（可选，分析用）" style={{ flex: 1 }}>
                        <Input placeholder="公开内容通常留空" />
                      </Form.Item>
                    ) : null}

                    {accessTypeValue === "single" ? (
                      <Alert
                        type="info"
                        showIcon
                        message="single 将以站内完整播放为主"
                        description="用户支付后会获得当前内容的 content entitlement；若 Web 完整播放异常，不会自动退回共享频道交付。"
                        style={{ flex: 1 }}
                      />
                    ) : null}
                  </Space>

                  {editing?.accessType === "single" && (
                    <Alert
                      type="info"
                      showIcon
                      icon={<InfoCircleOutlined />}
                      message="该内容为 single 单篇解锁"
                      description="当前版本支持站内 HLS 单条解锁；免费流量入口仍只投放封面、简介与详情页深链，不投放完整视频文件。"
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
            // ==================== Tab 2：Phase A 私有媒体基础设施 ====================
            {
              key: "media",
              label: <Space><span>② 上传素材</span>{coverAssetId && fullVideoAssetId ? <Badge count={2} /> : null}</Space>,
              children: (
                <Space direction="vertical" size={20} style={{ width: "100%" }}>
                  <Alert
                    type="info"
                    showIcon
                    icon={<InfoCircleOutlined />}
                    message="后台只上传封面和完整源视频。"
                    description="试看 HLS 由 Worker 从完整源视频自动生成，后台不会提供单独的试看视频上传入口，也不会返回对象 Key、Bucket、签名下载地址或完整私有媒体 URL。"
                  />
                  <Card
                    size="small"
                    title={
                      <Space>
                        <span>① 封面图片（16:9 裁切预览）</span>
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
                      <div style={{ width: "100%", maxWidth: 420, aspectRatio: "16 / 9", overflow: "hidden", borderRadius: 16, border: "1px solid #303030", background: "#111318" }}>
                        {coverPreviewUrl ? (
                          <img src={coverPreviewUrl} alt="封面预览" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center", display: "block" }} />
                        ) : (
                          <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "#8c8c8c", fontSize: 12 }}>
                            16:9 封面预览
                          </div>
                        )}
                      </div>
                      {coverAsset && (
                        <Space direction="vertical" size={4} style={{ fontSize: 12 }}>
                          <span>文件名：{coverAsset.originalFilename}</span>
                          <span>大小：{(coverAsset.contentLength / 1024 / 1024).toFixed(2)} MB</span>
                          <span>状态：<Tag color={coverAsset.status === "ready" ? "green" : coverAsset.status === "failed" ? "red" : "default"}>{coverAsset.status === "ready" ? "已校验" : coverAsset.status === "failed" ? "失败" : "上传中"}</Tag></span>
                          {coverAsset.lastErrorClass && <span style={{ color: "#ff4d4f" }}>错误类别：{coverAsset.lastErrorClass}</span>}
                          <Button size="small" danger onClick={() => onDeleteMediaAsset(coverAsset)}>删除</Button>
                        </Space>
                      )}
                    </Space>
                  </Card>
                  <Card
                    size="small"
                    title={
                      <Space>
                        <span>② 完整源视频</span>
                        {fullVideoSegments.length > 0 && fullVideoSegments.every((asset) => asset.status === "ready")
                          ? <CheckCircleTwoTone twoToneColor="#52c41a" />
                          : fullVideoUploadError
                            ? <ExclamationCircleTwoTone twoToneColor="#ff4d4f" />
                            : <ClockCircleOutlined style={{ color: "#888" }} />}
                      </Space>
                    }
                    extra={<Tag color="purple">Multipart 分片上传</Tag>}
                  >
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      <Alert
                        type="info"
                        showIcon
                        message="完整源视频必须走 Multipart Upload：默认 32MiB 分片、最多 3 并发、失败自动重试、刷新后可继续。"
                        description={`转码完成后系统会自动生成${form.getFieldValue("previewEnabled") === false ? "完整版 HLS" : `${form.getFieldValue("previewDurationSeconds") || 60} 秒试看 HLS + 完整版 HLS`}；前端不会拿到永久 Bucket 地址、对象 Key 或完整视频公开 URL；取消上传会调用 abort，旧会话不可恢复。`}
                      />
                      {(fullVideoSession || fullVideoResumeRecord) && (
                        <Alert
                          type={fullVideoUploadError ? "error" : fullVideoSession?.status === "paused" ? "warning" : "info"}
                          showIcon
                          message={`发现未完成上传：${humanizeUploadSessionStatus(fullVideoSession?.status || "initiated")}`}
                          description={
                            <Space direction="vertical" size={6} style={{ width: "100%" }}>
                              <span>
                                {fullVideoResumeRecord
                                  ? `文件：${fullVideoResumeRecord.fileName} · ${formatBytes(fullVideoResumeRecord.fileSize)}`
                                  : `会话：${fullVideoSession?.filename || "完整源视频"}`}
                              </span>
                              <Space wrap>
                                <Upload
                                  multiple={false}
                                  maxCount={1}
                                  accept="video/*"
                                  disabled={!canEdit || fullVideoUploading || fullVideoFingerprinting}
                                  showUploadList={false}
                                  beforeUpload={(f) => startOrResumeFullVideoUpload(f as File)}
                                >
                                  <Button icon={<PlayCircleOutlined />} loading={fullVideoUploading || fullVideoFingerprinting} disabled={!canEdit}>
                                    继续上传（选择同一文件）
                                  </Button>
                                </Upload>
                                <Button icon={<DeleteOutlined />} danger disabled={!canEdit || fullVideoUploading || fullVideoFingerprinting} onClick={() => void abortFullVideoUpload()}>
                                  放弃上传
                                </Button>
                              </Space>
                            </Space>
                          }
                        />
                      )}
                      <Space wrap>
                        <Upload
                          multiple={false}
                          maxCount={1}
                          accept="video/*"
                          disabled={!canEdit || fullVideoUploading || fullVideoFingerprinting}
                          showUploadList={false}
                          beforeUpload={(f) => startOrResumeFullVideoUpload(f as File)}
                        >
                          <Button icon={<UploadOutlined />} loading={fullVideoUploading || fullVideoFingerprinting} disabled={!canEdit}>
                            {fullVideoSession || fullVideoResumeRecord ? "继续上传完整源视频" : "上传完整源视频"}
                          </Button>
                        </Upload>
                        <Button
                          icon={<PauseCircleOutlined />}
                          disabled={!fullVideoUploading || !fullVideoSession}
                          onClick={() => void pauseFullVideoUpload()}
                        >
                          暂停
                        </Button>
                        <Button
                          icon={<PlayCircleOutlined />}
                          disabled={fullVideoUploading || !fullVideoSession || fullVideoSession.status === "cancelled" || fullVideoSession.status === "completed"}
                          onClick={() => void resumeFullVideoUpload()}
                        >
                          继续
                        </Button>
                        <Button
                          icon={<DeleteOutlined />}
                          danger
                          disabled={!fullVideoSession || fullVideoSession.status === "completed"}
                          onClick={() => void abortFullVideoUpload()}
                        >
                          取消
                        </Button>
                        <Button
                          icon={<ReloadOutlined />}
                          disabled={!fullVideoUploadError}
                          onClick={() => void retryFullVideoUpload()}
                        >
                          重试
                        </Button>
                      </Space>
                      <Progress
                        percent={fullVideoProgress}
                        status={fullVideoUploadError ? "exception" : fullVideoProgress === 100 && fullVideoAsset?.status === "ready" ? "success" : (fullVideoUploading || fullVideoFingerprinting) ? "active" : "normal"}
                      />
                      <Space direction="vertical" size={4} style={{ fontSize: 12, width: "100%" }}>
                        <span>状态：<Tag color={fullVideoUploadError ? "red" : fullVideoSession?.status === "paused" ? "gold" : fullVideoUploading ? "processing" : fullVideoAsset?.status === "ready" ? "green" : "default"}>{fullVideoFingerprinting ? "计算文件指纹" : humanizeUploadSessionStatus(fullVideoSession?.status || (fullVideoAsset?.status === "ready" ? "completed" : "initiated"))}</Tag></span>
                        <span>文件名：{fullVideoResumeRecord?.fileName || fullVideoSession?.filename || fullVideoAsset?.originalFilename || "未选择文件"}</span>
                        <span>总大小：{formatBytes(fullVideoTotalBytes || fullVideoResumeRecord?.fileSize || 0)}</span>
                        <span>已上传：{formatBytes(fullVideoUploadedBytes)} / {formatBytes(fullVideoTotalBytes || fullVideoResumeRecord?.fileSize || 0)}</span>
                        <span>实时速度：{formatSpeed(fullVideoSpeedBps)} · 预计剩余：{formatEta(fullVideoEtaSeconds)}</span>
                        {fullVideoSession && (
                          <span>
                            分片：{fullVideoSession.parts.length}/{fullVideoSession.totalParts || fullVideoResumeRecord?.totalParts || 0}
                            {fullVideoSession.expiresAt ? ` · 过期时间：${dayjs(fullVideoSession.expiresAt).format("YYYY-MM-DD HH:mm:ss")}` : ""}
                          </span>
                        )}
                        {fullVideoStatusHint && <span style={{ color: "#666" }}>{fullVideoStatusHint}</span>}
                        {fullVideoUploadError && <span style={{ color: "#ff4d4f" }}>{fullVideoUploadError}</span>}
                      </Space>
                      {fullVideoSegments.map((asset, index) => (
                        <Card key={asset.id} size="small" style={{ background: "#fafafa" }}>
                          <Space direction="vertical" size={8} style={{ width: "100%" }}>
                            <Space wrap size={8}>
                              <Tag color="purple">源文件 {index + 1}</Tag>
                              <span>{asset.originalFilename || "未命名视频"}</span>
                              <span>{(asset.contentLength / 1024 / 1024 / 1024).toFixed(3)} GB</span>
                              <Tag color={asset.status === "ready" ? "green" : asset.status === "failed" ? "red" : "default"}>{asset.status === "ready" ? "已校验" : asset.status === "failed" ? "失败" : "上传中"}</Tag>
                              <Tag color={transcodeStatusTagColor(asset)}>{humanizeTranscodeStatus(asset)}</Tag>
                              <Button size="small" danger disabled={fullVideoUploading} onClick={() => onDeleteMediaAsset(asset)}>删除</Button>
                              {!!asset.transcodeStatus && asset.transcodeStatus === "failed" && (
                                <Button
                                  size="small"
                                  icon={<ReloadOutlined />}
                                  disabled={!canPublish || !asset.transcodeJobId}
                                  onClick={async () => {
                                    try {
                                      if (!asset.transcodeJobId) {
                                        message.warning("当前没有可重试的转码任务");
                                        return;
                                      }
                                      await retryTranscodeJob(asset.transcodeJobId);
                                      message.success("已重新入队转码任务");
                                      await refreshContentMedia(editing!.id);
                                    } catch (e) {
                                      message.error(errMsg(e, "重新入队失败"));
                                    }
                                  }}
                                >
                                  重试转码
                                </Button>
                              )}
                              {!!asset.transcodeStatus && ["queued", "processing"].includes(asset.transcodeStatus) && (
                                <Button
                                  size="small"
                                  icon={<CloseCircleOutlined />}
                                  disabled={!canPublish || !asset.transcodeJobId}
                                  onClick={async () => {
                                    try {
                                      if (!asset.transcodeJobId) {
                                        message.warning("当前没有可取消的转码任务");
                                        return;
                                      }
                                      await cancelTranscodeJob(asset.transcodeJobId);
                                      message.success("已取消转码任务");
                                      await refreshContentMedia(editing!.id);
                                    } catch (e) {
                                      message.error(errMsg(e, "取消转码失败"));
                                    }
                                  }}
                                >
                                  取消转码
                                </Button>
                              )}
                            </Space>
                            {!!asset.transcodeErrorClass && (
                              <Text type="danger" style={{ fontSize: 12 }}>
                                失败说明：{asset.transcodeErrorClass === "source_invalid_media" ? "视频文件无法读取，请更换源文件" : asset.transcodeErrorClass}
                              </Text>
                            )}
                            <Space wrap size={8}>
                              {(asset.renditions || []).map((rendition) => (
                                <Tag key={`${asset.id}-${rendition.kind}`} color={rendition.status === "ready" ? "green" : rendition.status === "failed" ? "red" : rendition.status === "processing" ? "processing" : "default"}>
                                  {humanizeRenditionKind(rendition.kind)} · {humanizeRenditionStatus(rendition.status)}
                                </Tag>
                              ))}
                            </Space>
                          </Space>
                        </Card>
                      ))}
                    </Space>
                  </Card>
                </Space>
              ),
            },
            // ==================== Tab 3：发布进度（Bot 异步任务队列 + 进度表） ====================
            {
              key: "publish",
              label: <Space><span>③ 发布到频道</span>{publishJobs.filter(j => j.status === "processing" || j.status === "queued").length > 0 && <Badge color="processing" count={publishJobs.filter(j => j.status === "processing" || j.status === "queued").length} />}</Space>,
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
                            message="频道 chatId 完全由服务端控制，前端仅能选择备用完整交付渠道；运营绝对不能直接提交 chatId，也无法在 UI 看到明文 chatId。"
                          />
                          <Form.Item
                            name="telegramTags"
                            label="Telegram 标签（可选，仅用于发布 caption）"
                            style={{ marginBottom: 0 }}
                            extra="支持粘贴逗号分隔词组、#标签1 #标签2 或普通短语。仅会与内容标签合并，SEO / GEO 关键词不会自动公开为 Telegram 标签。"
                          >
                            <DelimitedTagInput
                              mode="telegram"
                              selectPlaceholder="例如：夜间, calm_mode"
                              textareaPlaceholder="支持粘贴逗号分隔词组、#标签1 #标签2 或普通短语。"
                              previewLabel="当前预览"
                              onStateChange={(state) => updateInputState("telegramTags", state)}
                            />
                          </Form.Item>
                          {lastNormalizedTelegramTags.length > 0 && (
                            <Alert
                              type="success"
                              showIcon
                              message="服务端最终标签预览"
                              description={lastNormalizedTelegramTags.join(" ")}
                            />
                          )}
                          <Alert
                            type="info"
                            showIcon
                            style={{ marginBottom: 12 }}
                            message="免费流量入口：必发"
                            description={freeChannels.length > 0
                              ? `发布时系统会自动向全部 ${freeChannels.length} 个免费入口发送封面推广图与 Bot 内容入口；60 秒试看在同频内播放。`
                              : "尚未配置免费流量入口；系统会阻止内容发布。"}
                          />
                          <Checkbox.Group
                            value={channelKinds}
                            onChange={(v) => setChannelKinds(v as TelegramPublishJobItem["channelKind"][])}
                            style={{ width: "100%" }}
                          >
                            <Space direction="vertical" size={8} style={{ width: "100%" }}>
                              <Checkbox
                                value="membership_full"
                                disabled={
                                  !canPublish ||
                                  accessTypeValue !== "membership" ||
                                  fullVideoSegments.length === 0 ||
                                  fullVideoSegments.some((asset) => asset.status !== "ready")
                                }
                              >
                                <Space>
                                  <Tag color={CHANNEL_KIND_LABEL.membership_full.color}>{CHANNEL_KIND_LABEL.membership_full.label}</Tag>
                                  <span style={{ color: "#666", fontSize: 12 }}>
                                    {
                                      accessTypeValue !== "membership"
                                        ? "（未满足：仅 accessType=membership 可选）"
                                        : fullVideoSegments.length === 0 || fullVideoSegments.some((asset) => asset.status !== "ready")
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
                                  fullVideoSegments.length === 0 ||
                                  fullVideoSegments.some((asset) => asset.status !== "ready") ||
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
                                          : fullVideoSegments.length === 0 || fullVideoSegments.some((asset) => asset.status !== "ready")
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
                                if (hasInputErrors(["telegramTags"])) {
                                  message.error("请先修正 Telegram 标签里的错误项");
                                  return;
                                }
                                setStartPublishing(true);
                                try {
                                  const rawTelegramTags = form.getFieldValue("telegramTags") || [];
                                  const r = await startTelegramPublish(editing.id, {
                                    channelKinds,
                                    telegramTags: rawTelegramTags,
                                    reason: `运营点击发布：${channelKinds.join("+")}`,
                                  });
                                  setLastNormalizedTelegramTags(r.normalizedTelegramTags || []);
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
                            type="info"
                            showIcon
                            message="发布模式说明"
                            description={
                              <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                                <span>· 当前主链路是 Web 平台播放；Telegram 仅作为完整版备用交付，不再依赖单独试看视频上传。</span>
                                <span>· 此处用于查看状态、按需补发或取消。Bot 发送为异步：大视频可能需要较长时间，请查看下表状态与重试次数。</span>
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
