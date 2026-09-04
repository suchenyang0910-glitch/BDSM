import React from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import {
  listAdminCommunityPostAudits,
  listAdminCommunityPosts,
  listAdminInteractionCommentAudits,
  listAdminInteractionComments,
  listAdminInteractionReports,
  moderateAdminCommunityPost,
  moderateAdminInteractionComment,
  pinAdminCommunityPost,
  reviewAdminInteractionReport,
  updateAdminCommunityPostSeo,
} from "../api/client";
import type {
  AdminAuditLogEntry,
  AdminCommunityPostItem,
  AdminInteractionCommentQueueItem,
  AdminInteractionReportItem,
  AdminRole,
  CommunityPostStatus,
  InteractionCommentStatus,
  InteractionReportStatus,
  InteractionTargetType,
  ModerateCommunityPostInput,
  ModerateInteractionCommentInput,
  ReviewInteractionReportInput,
  UpdateCommunityPostSeoInput,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";

const { Text, Paragraph } = Typography;
const { TextArea, Search } = Input;

const VIEW_ROLES: AdminRole[] = ["super_admin", "customer_service", "operator", "editor", "auditor"];
const REVIEW_ROLES: AdminRole[] = ["super_admin", "customer_service"];

type QueueTabKey = "circle_posts" | "circle_comments" | "video_comments" | "article_comments" | "reports";

const REPORT_STATUS_META: Record<InteractionReportStatus, { color: string; label: string }> = {
  open: { color: "red", label: "待处理" },
  reviewing: { color: "processing", label: "审核中" },
  actioned: { color: "green", label: "已处理" },
  dismissed: { color: "default", label: "驳回" },
};

const COMMENT_STATUS_META: Record<InteractionCommentStatus, { color: string; label: string }> = {
  pending: { color: "gold", label: "待审核" },
  approved: { color: "green", label: "已通过" },
  hidden: { color: "orange", label: "已隐藏" },
  rejected: { color: "red", label: "已驳回" },
  deleted: { color: "default", label: "已删除" },
};

const COMMUNITY_POST_STATUS_META: Record<CommunityPostStatus, { color: string; label: string }> = {
  pending: { color: "gold", label: "待审" },
  rejected: { color: "red", label: "已驳回" },
  published: { color: "green", label: "已发布" },
  hidden: { color: "orange", label: "已隐藏" },
  removed: { color: "default", label: "已删除" },
};

const TARGET_TYPE_LABEL: Record<InteractionTargetType, string> = {
  video_content: "视频",
  article: "文章",
  circle_post: "圈子帖子",
};

const COMMENT_TAB_TO_TARGET: Record<Extract<QueueTabKey, "circle_comments" | "video_comments" | "article_comments">, InteractionTargetType> = {
  circle_comments: "circle_post",
  video_comments: "video_content",
  article_comments: "article",
};

const REVIEWABLE_COMMENT_STATUSES: Array<Extract<InteractionCommentStatus, "approved" | "hidden" | "rejected" | "deleted">> = [
  "approved",
  "hidden",
  "rejected",
  "deleted",
];

function renderCommentStatus(status: InteractionCommentStatus, tab: QueueTabKey) {
  const meta = COMMENT_STATUS_META[status];
  const label = status === "approved" && tab !== "reports" ? "已发布" : meta.label;
  return <Tag color={meta.color}>{label}</Tag>;
}

const InteractionReportsPage: React.FC = () => {
  const { me } = useAuth();
  const canView = !!me && VIEW_ROLES.includes(me.role);
  const canReview = !!me && REVIEW_ROLES.includes(me.role);

  const [activeTab, setActiveTab] = React.useState<QueueTabKey>("circle_posts");
  const [loading, setLoading] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [total, setTotal] = React.useState(0);

  const [postFilterForm] = Form.useForm<{ status?: CommunityPostStatus; keyword?: string }>();
  const [commentFilterForm] = Form.useForm<{ status?: InteractionCommentStatus }>();
  const [reportFilterForm] = Form.useForm<{ status?: InteractionReportStatus; targetType?: InteractionTargetType }>();

  const [postRows, setPostRows] = React.useState<AdminCommunityPostItem[]>([]);
  const [commentRows, setCommentRows] = React.useState<AdminInteractionCommentQueueItem[]>([]);
  const [reportRows, setReportRows] = React.useState<AdminInteractionReportItem[]>([]);

  const [reviewModalOpen, setReviewModalOpen] = React.useState(false);
  const [reviewForm] = Form.useForm<ReviewInteractionReportInput>();
  const [reviewing, setReviewing] = React.useState(false);
  const [activeReport, setActiveReport] = React.useState<AdminInteractionReportItem | null>(null);

  const [commentModalOpen, setCommentModalOpen] = React.useState(false);
  const [commentForm] = Form.useForm<ModerateInteractionCommentInput>();
  const [moderating, setModerating] = React.useState(false);
  const [activeComment, setActiveComment] = React.useState<AdminInteractionCommentQueueItem | null>(null);

  const [postModalOpen, setPostModalOpen] = React.useState(false);
  const [postForm] = Form.useForm<ModerateCommunityPostInput>();
  const [postModerating, setPostModerating] = React.useState(false);
  const [activePost, setActivePost] = React.useState<AdminCommunityPostItem | null>(null);

  const [seoModalOpen, setSeoModalOpen] = React.useState(false);
  const [seoForm] = Form.useForm<UpdateCommunityPostSeoInput>();
  const [seoSaving, setSeoSaving] = React.useState(false);

  const [auditModalOpen, setAuditModalOpen] = React.useState(false);
  const [auditTitle, setAuditTitle] = React.useState("审计记录");
  const [auditRows, setAuditRows] = React.useState<AdminAuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = React.useState(false);

  const [detailReportsOpen, setDetailReportsOpen] = React.useState(false);
  const [detailReportsTitle, setDetailReportsTitle] = React.useState("相关举报");
  const [detailReportRows, setDetailReportRows] = React.useState<AdminInteractionReportItem[]>([]);
  const [detailReportsLoading, setDetailReportsLoading] = React.useState(false);

  const fetchPosts = React.useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    try {
      const values = postFilterForm.getFieldsValue();
      const res = await listAdminCommunityPosts({
        page,
        pageSize,
        status: values.status,
        keyword: values.keyword,
      });
      setPostRows(res.items || []);
      setTotal(res.total || 0);
    } catch (err: any) {
      message.error("圈子帖子列表加载失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setLoading(false);
    }
  }, [canView, page, pageSize, postFilterForm]);

  const fetchComments = React.useCallback(async () => {
    if (!canView || activeTab === "circle_posts" || activeTab === "reports") return;
    setLoading(true);
    try {
      const values = commentFilterForm.getFieldsValue();
      const targetType = COMMENT_TAB_TO_TARGET[activeTab as keyof typeof COMMENT_TAB_TO_TARGET];
      const res = await listAdminInteractionComments({
        page,
        pageSize,
        status: values.status || "pending",
        targetType,
      });
      setCommentRows(res.items || []);
      setTotal(res.total || 0);
    } catch (err: any) {
      message.error("评论队列加载失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setLoading(false);
    }
  }, [activeTab, canView, commentFilterForm, page, pageSize]);

  const fetchReports = React.useCallback(async () => {
    if (!canView || activeTab !== "reports") return;
    setLoading(true);
    try {
      const values = reportFilterForm.getFieldsValue();
      const res = await listAdminInteractionReports({
        page,
        pageSize,
        status: values.status,
        targetType: values.targetType,
      });
      setReportRows(res.items || []);
      setTotal(res.total || 0);
    } catch (err: any) {
      message.error("互动举报列表加载失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setLoading(false);
    }
  }, [canView, page, pageSize, reportFilterForm, activeTab]);

  React.useEffect(() => {
    if (activeTab === "circle_posts") {
      void fetchPosts();
      return;
    }
    if (activeTab === "reports") {
      void fetchReports();
      return;
    }
    void fetchComments();
  }, [activeTab, fetchPosts, fetchComments, fetchReports]);

  const refreshActiveTab = React.useCallback(async () => {
    if (activeTab === "circle_posts") return fetchPosts();
    if (activeTab === "reports") return fetchReports();
    return fetchComments();
  }, [activeTab, fetchComments, fetchPosts, fetchReports]);

  const openReviewModal = (report: AdminInteractionReportItem) => {
    setActiveReport(report);
    setReviewModalOpen(true);
    reviewForm.setFieldsValue({
      status: report.comment ? "actioned" : (report.status === "actioned" ? "reviewing" : report.status),
      resolutionNote: report.resolutionNote || undefined,
      commentStatus: report.comment ? (report.comment.status === "pending" ? "hidden" : report.comment.status) : undefined,
      commentReason: undefined,
    });
  };

  const openCommentModal = (comment: AdminInteractionCommentQueueItem, report?: AdminInteractionReportItem) => {
    setActiveReport(report || null);
    setActiveComment(comment);
    setCommentModalOpen(true);
    commentForm.setFieldsValue({
      status: comment.status !== "pending" ? (comment.status as any) : "hidden",
      reason: undefined,
    });
  };

  const openPostModal = (post: AdminCommunityPostItem, status: Extract<CommunityPostStatus, "published" | "hidden" | "removed">) => {
    setActivePost(post);
    setPostModalOpen(true);
    postForm.setFieldsValue({ status, reason: undefined });
  };

  const openSeoModal = (post: AdminCommunityPostItem) => {
    setActivePost(post);
    seoForm.setFieldsValue({
      seoTitle: post.seoTitle || "",
      seoDescription: post.seoDescription || "",
      seoKeywords: post.seoKeywords || [],
      geoKeywords: post.geoKeywords || [],
      searchIndexable: !!post.searchIndexable,
    });
    setSeoModalOpen(true);
  };

  const openAuditModal = async (title: string, loader: () => Promise<{ items: AdminAuditLogEntry[] }>) => {
    setAuditTitle(title);
    setAuditRows([]);
    setAuditModalOpen(true);
    setAuditLoading(true);
    try {
      const res = await loader();
      setAuditRows(res.items || []);
    } catch (err: any) {
      message.error("审计记录加载失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setAuditLoading(false);
    }
  };

  const openReportsModal = async (title: string, filter: { targetType: InteractionTargetType; targetId?: string; commentId?: string }) => {
    setDetailReportsTitle(title);
    setDetailReportRows([]);
    setDetailReportsOpen(true);
    setDetailReportsLoading(true);
    try {
      const res = await listAdminInteractionReports({
        page: 1,
        pageSize: 50,
        ...filter,
      });
      setDetailReportRows(res.items || []);
    } catch (err: any) {
      message.error("举报详情加载失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setDetailReportsLoading(false);
    }
  };

  const handleReviewSubmit = async () => {
    if (!activeReport) return;
    const values = await reviewForm.validateFields();
    setReviewing(true);
    try {
      await reviewAdminInteractionReport(activeReport.id, values);
      message.success("举报状态已更新");
      setReviewModalOpen(false);
      setActiveReport(null);
      await refreshActiveTab();
    } catch (err: any) {
      message.error("举报处理失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setReviewing(false);
    }
  };

  const handleCommentSubmit = async () => {
    if (!activeComment) return;
    const values = await commentForm.validateFields();
    setModerating(true);
    try {
      await moderateAdminInteractionComment(activeComment.id, values);
      message.success("评论审核状态已更新");
      setCommentModalOpen(false);
      setActiveComment(null);
      await refreshActiveTab();
    } catch (err: any) {
      message.error("评论审核失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setModerating(false);
    }
  };

  const handlePostSubmit = async () => {
    if (!activePost) return;
    const values = await postForm.validateFields();
    setPostModerating(true);
    try {
      await moderateAdminCommunityPost(activePost.id, values);
      message.success("圈子帖子状态已更新");
      setPostModalOpen(false);
      setActivePost(null);
      await refreshActiveTab();
    } catch (err: any) {
      message.error("圈子帖子处理失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setPostModerating(false);
    }
  };

  const handlePinToggle = async (post: AdminCommunityPostItem, pinned: boolean) => {
    try {
      await pinAdminCommunityPost(post.id, {
        pinned,
        reason: pinned ? "后台圈子帖子置顶" : "后台取消圈子帖子置顶",
      });
      message.success(pinned ? "已置顶" : "已取消置顶");
      await refreshActiveTab();
    } catch (err: any) {
      message.error((pinned ? "置顶" : "取消置顶") + "失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    }
  };

  const handleSeoSubmit = async () => {
    if (!activePost) return;
    const values = await seoForm.validateFields();
    setSeoSaving(true);
    try {
      await updateAdminCommunityPostSeo(activePost.id, values);
      message.success("圈子帖子 SEO/GEO 已保存");
      setSeoModalOpen(false);
      setActivePost(null);
      await refreshActiveTab();
    } catch (err: any) {
      message.error("SEO/GEO 保存失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setSeoSaving(false);
    }
  };

  const reportColumns: ColumnsType<AdminInteractionReportItem> = [
    {
      title: "举报时间",
      dataIndex: "createdAt",
      width: 168,
      render: (value: string) => dayjs(value).format("MM-DD HH:mm"),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (value: InteractionReportStatus) => <Tag color={REPORT_STATUS_META[value].color}>{REPORT_STATUS_META[value].label}</Tag>,
    },
    {
      title: "目标",
      width: 150,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Text strong>{TARGET_TYPE_LABEL[row.targetType]}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.targetId}</Text>
        </Space>
      ),
    },
    {
      title: "举报人/原因",
      width: 180,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Text>{row.reporter?.displayName || "匿名用户"}</Text>
          <Tag>{row.reasonCode}</Tag>
        </Space>
      ),
    },
    {
      title: "举报内容",
      render: (_, row) => (
        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          {row.comment ? (
            <>
              {renderCommentStatus(row.comment.status, "reports")}
              <Paragraph ellipsis={{ rows: 2, expandable: false }} style={{ marginBottom: 0 }}>
                {row.comment.body}
              </Paragraph>
            </>
          ) : (
            <Text type="secondary">目标级举报（{TARGET_TYPE_LABEL[row.targetType]}）</Text>
          )}
          {row.detailText ? <Text type="secondary" style={{ fontSize: 12 }}>补充：{row.detailText}</Text> : null}
        </Space>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 200,
      render: (_, row) => (
        <Space wrap>
          <Button size="small" onClick={() => openReviewModal(row)} disabled={!canReview}>处理举报</Button>
          <Button
            size="small"
            disabled={!row.comment || !canReview}
            onClick={() => row.comment && openCommentModal({
              id: row.comment.id,
              targetType: row.targetType,
              targetId: row.targetId,
              parentId: null,
              rootId: null,
              body: row.comment.body,
              status: row.comment.status,
              likeCount: row.comment.likeCount,
              replyCount: row.comment.replyCount,
              createdAt: row.createdAt,
              updatedAt: row.createdAt,
              moderatedAt: row.reviewedAt,
              moderationReason: row.resolutionNote,
              reportCount: 0,
              author: row.reporter,
              parentComment: null,
              target: { id: row.targetId, title: row.targetId, status: "unknown" },
            }, row)}
          >
            审核评论
          </Button>
        </Space>
      ),
    },
  ];

  const commentColumns: ColumnsType<AdminInteractionCommentQueueItem> = [
    {
      title: "提交时间",
      dataIndex: "createdAt",
      width: 168,
      render: (value: string) => dayjs(value).format("MM-DD HH:mm"),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (value: InteractionCommentStatus) => renderCommentStatus(value, activeTab),
    },
    {
      title: "目标",
      width: 220,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Text strong>{TARGET_TYPE_LABEL[row.targetType]}</Text>
          <Text>{row.target?.title || row.targetId}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.target?.status || row.targetId}</Text>
        </Space>
      ),
    },
    {
      title: "作者/评论",
      render: (_, row) => (
        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          <Text>{row.author?.displayName || "匿名用户"}</Text>
          {row.parentComment ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              回复 @{row.parentComment.author?.displayName || "同频成员"}：{row.parentComment.body.slice(0, 30)}
            </Text>
          ) : null}
          <Paragraph ellipsis={{ rows: 3, expandable: false }} style={{ marginBottom: 0 }}>
            {row.body}
          </Paragraph>
          {row.moderationReason ? <Text type="secondary" style={{ fontSize: 12 }}>原因：{row.moderationReason}</Text> : null}
        </Space>
      ),
    },
    {
      title: "举报",
      width: 96,
      render: (_, row) => <Tag color={row.reportCount > 0 ? "red" : "default"}>{row.reportCount}</Tag>,
    },
    {
      title: "操作",
      key: "actions",
      width: 220,
      render: (_, row) => (
        <Space wrap>
          <Button size="small" onClick={() => openCommentModal(row)} disabled={!canReview}>审核评论</Button>
          <Button
            size="small"
            disabled={row.reportCount <= 0}
            onClick={() => openReportsModal("评论相关举报", { targetType: row.targetType, targetId: row.targetId, commentId: row.id })}
          >
            查看举报
          </Button>
          <Button
            size="small"
            onClick={() => void openAuditModal("评论审计记录", () => listAdminInteractionCommentAudits(row.id))}
          >
            审计
          </Button>
        </Space>
      ),
    },
  ];

  const postColumns: ColumnsType<AdminCommunityPostItem> = [
    {
      title: "发布时间",
      width: 170,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Text>{row.publishedAt ? dayjs(row.publishedAt).format("MM-DD HH:mm") : "-"}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>创建 {dayjs(row.createdAt).format("MM-DD HH:mm")}</Text>
        </Space>
      ),
    },
    {
      title: "作者",
      width: 160,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Text strong>{row.author?.displayName || "匿名用户"}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.id}</Text>
        </Space>
      ),
    },
    {
      title: "文本 / 媒体",
      render: (_, row) => (
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          <Paragraph ellipsis={{ rows: 3, expandable: false }} style={{ marginBottom: 0 }}>
            {row.body}
          </Paragraph>
          <Space wrap size={[4, 4]}>
            {(row.assets || []).map((asset) => (
              <Tag key={asset.id}>
                {asset.kind === "video" ? "视频" : "图片"} #{asset.ordinal + 1} / {asset.moderationStatus} / {asset.transcodeStatus}
                {asset.kind === "video" ? ` / ${asset.transcodeQueueName || "-"} / ${asset.playbackQuotaBucket || "-"}` : ""}
              </Tag>
            ))}
            {row.assets.length === 0 ? <Text type="secondary">纯文本帖子</Text> : null}
          </Space>
          {row.moderationReason ? <Text type="secondary" style={{ fontSize: 12 }}>原因：{row.moderationReason}</Text> : null}
        </Space>
      ),
    },
    {
      title: "话题",
      width: 180,
      render: (_, row) => (
        <Space wrap size={[4, 4]}>
          {(row.topics || []).length > 0
            ? row.topics.map((topic) => <Tag key={topic}>#{topic}</Tag>)
            : <Text type="secondary">无话题</Text>}
        </Space>
      ),
    },
    {
      title: "状态",
      width: 120,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Tag color={COMMUNITY_POST_STATUS_META[row.status].color}>{COMMUNITY_POST_STATUS_META[row.status].label}</Tag>
          {row.isPinned ? <Tag color="geekblue">已置顶</Tag> : null}
        </Space>
      ),
    },
    {
      title: "举报数",
      width: 96,
      render: (_, row) => <Tag color={row.reportCount > 0 ? "red" : "default"}>{row.reportCount}</Tag>,
    },
    {
      title: "操作",
      key: "actions",
      width: 320,
      render: (_, row) => (
        <Space wrap>
          {row.status !== "published" ? (
            <Button size="small" onClick={() => openPostModal(row, "published")} disabled={!canReview}>
              {row.status === "pending" ? "审核发布" : "恢复"}
            </Button>
          ) : (
            <Button size="small" onClick={() => openPostModal(row, "hidden")} disabled={!canReview}>
              隐藏
            </Button>
          )}
          {row.status !== "removed" ? (
            <Button size="small" danger onClick={() => openPostModal(row, "removed")} disabled={!canReview}>
              删除
            </Button>
          ) : null}
          <Button size="small" onClick={() => void handlePinToggle(row, !row.isPinned)} disabled={!canReview}>
            {row.isPinned ? "取消置顶" : "置顶"}
          </Button>
          <Button size="small" onClick={() => openSeoModal(row)} disabled={!canReview}>
            SEO/GEO
          </Button>
          <Button
            size="small"
            disabled={row.reportCount <= 0}
            onClick={() => openReportsModal("帖子相关举报", { targetType: "circle_post", targetId: row.id })}
          >
            查看举报
          </Button>
          <Button size="small" onClick={() => void openAuditModal("圈子帖子审计记录", () => listAdminCommunityPostAudits(row.id))}>
            审计
          </Button>
        </Space>
      ),
    },
  ];

  if (!canView) {
    return <Alert type="warning" showIcon message="你当前没有查看互动审核页的权限。" />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Tabs
        activeKey={activeTab}
        onChange={(key) => {
          setActiveTab(key as QueueTabKey);
          setPage(1);
        }}
        items={[
          {
            key: "circle_posts",
            label: "圈子帖子",
            children: (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Alert
                  type="info"
                  showIcon
                  message="圈子媒体继续走独立约束：图片先审，短视频必须使用 community 前缀、community_transcode 队列和 community_video 播放额度；后台仅展示安全摘要，不回传可访问地址或源文件路径。"
                />
                <Card>
                  <Form
                    form={postFilterForm}
                    layout="inline"
                    onFinish={() => {
                      setPage(1);
                      void fetchPosts();
                    }}
                  >
                    <Form.Item name="status" label="帖子状态">
                      <Select allowClear style={{ width: 160 }} placeholder="全部状态">
                        {Object.entries(COMMUNITY_POST_STATUS_META).map(([value, meta]) => (
                          <Select.Option key={value} value={value}>{meta.label}</Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                    <Form.Item name="keyword" label="关键词">
                      <Search allowClear placeholder="作者 / 文本 / 话题" style={{ width: 240 }} onSearch={() => {
                        setPage(1);
                        void fetchPosts();
                      }} />
                    </Form.Item>
                    <Form.Item>
                      <Space>
                        <Button type="primary" htmlType="submit">筛选</Button>
                        <Button onClick={() => {
                          postFilterForm.resetFields();
                          setPage(1);
                          void fetchPosts();
                        }}>重置</Button>
                      </Space>
                    </Form.Item>
                  </Form>
                </Card>
                <Card title="圈子帖子管理">
                  <Table
                    rowKey="id"
                    loading={loading}
                    columns={postColumns}
                    dataSource={postRows}
                    pagination={{
                      current: page,
                      pageSize,
                      total,
                      showSizeChanger: true,
                      onChange: (nextPage, nextPageSize) => {
                        setPage(nextPage);
                        setPageSize(nextPageSize);
                      },
                    }}
                  />
                </Card>
              </Space>
            ),
          },
          ...([
            ["circle_comments", "圈子评论"],
            ["video_comments", "视频评论"],
            ["article_comments", "文章评论"],
          ] as Array<[QueueTabKey, string]>).map(([key, label]) => ({
            key,
            label,
            children: (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card>
                  <Form
                    form={commentFilterForm}
                    layout="inline"
                    initialValues={{ status: "pending" }}
                    onFinish={() => {
                      setPage(1);
                      void fetchComments();
                    }}
                  >
                    <Form.Item name="status" label="评论状态">
                      <Select allowClear style={{ width: 180 }} placeholder="默认待审核">
                        {Object.entries(COMMENT_STATUS_META).map(([value, meta]) => (
                          <Select.Option key={value} value={value}>
                            {value === "approved" ? "已发布" : meta.label}
                          </Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                    <Form.Item>
                      <Space>
                        <Button type="primary" htmlType="submit">筛选</Button>
                        <Button onClick={() => {
                          commentFilterForm.resetFields();
                          commentFilterForm.setFieldsValue({ status: "pending" });
                          setPage(1);
                          void fetchComments();
                        }}>重置</Button>
                      </Space>
                    </Form.Item>
                  </Form>
                </Card>
                <Card
                  title={label}
                  extra={<Text type="secondary">{key === "circle_comments" ? "帖子被隐藏/删除后，该帖评论会自动从用户端隐藏。" : "支持评论审核、举报查看和审计追踪。"}</Text>}
                >
                  <Table
                    rowKey="id"
                    loading={loading}
                    columns={commentColumns}
                    dataSource={commentRows}
                    pagination={{
                      current: page,
                      pageSize,
                      total,
                      showSizeChanger: true,
                      onChange: (nextPage, nextPageSize) => {
                        setPage(nextPage);
                        setPageSize(nextPageSize);
                      },
                    }}
                  />
                </Card>
              </Space>
            ),
          })),
          {
            key: "reports",
            label: "举报队列",
            children: (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card>
                  <Form
                    form={reportFilterForm}
                    layout="inline"
                    onFinish={() => {
                      setPage(1);
                      void fetchReports();
                    }}
                  >
                    <Form.Item name="status" label="举报状态">
                      <Select allowClear style={{ width: 160 }} placeholder="全部状态">
                        {Object.entries(REPORT_STATUS_META).map(([value, meta]) => (
                          <Select.Option key={value} value={value}>{meta.label}</Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                    <Form.Item name="targetType" label="目标类型">
                      <Select allowClear style={{ width: 160 }} placeholder="全部目标">
                        {Object.entries(TARGET_TYPE_LABEL).map(([value, label]) => (
                          <Select.Option key={value} value={value}>{label}</Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                    <Form.Item>
                      <Space>
                        <Button type="primary" htmlType="submit">筛选</Button>
                        <Button onClick={() => {
                          reportFilterForm.resetFields();
                          setPage(1);
                          void fetchReports();
                        }}>重置</Button>
                      </Space>
                    </Form.Item>
                  </Form>
                </Card>
                <Card title="互动举报队列" extra={<Text type="secondary">圈子帖子、圈子评论、视频评论、文章评论的举报统一归档在这里。</Text>}>
                  <Table
                    rowKey="id"
                    loading={loading}
                    columns={reportColumns}
                    dataSource={reportRows}
                    pagination={{
                      current: page,
                      pageSize,
                      total,
                      showSizeChanger: true,
                      onChange: (nextPage, nextPageSize) => {
                        setPage(nextPage);
                        setPageSize(nextPageSize);
                      },
                    }}
                  />
                </Card>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title="处理举报"
        open={reviewModalOpen}
        onCancel={() => {
          setReviewModalOpen(false);
          setActiveReport(null);
        }}
        onOk={() => void handleReviewSubmit()}
        okText="保存"
        confirmLoading={reviewing}
        destroyOnClose
      >
        <Form form={reviewForm} layout="vertical">
          <Form.Item name="status" label="举报状态" rules={[{ required: true, message: "请选择举报状态" }]}>
            <Select>
              <Select.Option value="reviewing">审核中</Select.Option>
              {activeReport?.comment ? <Select.Option value="actioned">已处理</Select.Option> : null}
              <Select.Option value="dismissed">驳回</Select.Option>
            </Select>
          </Form.Item>
          {activeReport?.comment ? (
            <Form.Item name="commentStatus" label="同步处理评论">
              <Select allowClear placeholder="可选，顺手更新评论状态">
                {REVIEWABLE_COMMENT_STATUSES.map((status) => (
                  <Select.Option key={status} value={status}>
                    {status === "approved" ? "已发布" : COMMENT_STATUS_META[status].label}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          ) : (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="目标级举报当前只能标记为 reviewing 或 dismissed，不能直接标记为 actioned。"
            />
          )}
          <Form.Item name="resolutionNote" label="处理备注">
            <TextArea rows={4} maxLength={500} placeholder="给后台留一条可追溯的处理说明。" />
          </Form.Item>
          {activeReport?.comment ? (
            <Form.Item name="commentReason" label="评论处理原因">
              <TextArea rows={3} maxLength={500} placeholder="如果同步改了评论状态，可填写原因。" />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title="审核评论"
        open={commentModalOpen}
        onCancel={() => {
          setCommentModalOpen(false);
          setActiveReport(null);
          setActiveComment(null);
        }}
        onOk={() => void handleCommentSubmit()}
        okText="保存"
        confirmLoading={moderating}
        destroyOnClose
      >
        <Form form={commentForm} layout="vertical">
          {activeComment ? (
            <Card size="small" style={{ marginBottom: 16 }}>
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                {renderCommentStatus(activeComment.status, activeTab)}
                <Paragraph style={{ marginBottom: 0 }}>{activeComment.body}</Paragraph>
              </Space>
            </Card>
          ) : null}
          <Form.Item name="status" label="评论状态" rules={[{ required: true, message: "请选择评论状态" }]}>
            <Select>
              {REVIEWABLE_COMMENT_STATUSES.map((status) => (
                <Select.Option key={status} value={status}>
                  {status === "approved" ? "已发布" : COMMENT_STATUS_META[status].label}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="reason" label="审核原因">
            <TextArea rows={4} maxLength={500} placeholder="写明为什么隐藏、驳回或恢复。" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="处理圈子帖子"
        open={postModalOpen}
        onCancel={() => {
          setPostModalOpen(false);
          setActivePost(null);
        }}
        onOk={() => void handlePostSubmit()}
        okText="保存"
        confirmLoading={postModerating}
        destroyOnClose
      >
        <Form form={postForm} layout="vertical">
          {activePost ? (
            <Card size="small" style={{ marginBottom: 16 }}>
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Tag color={COMMUNITY_POST_STATUS_META[activePost.status].color}>{COMMUNITY_POST_STATUS_META[activePost.status].label}</Tag>
                <Paragraph style={{ marginBottom: 0 }}>{activePost.body}</Paragraph>
              </Space>
            </Card>
          ) : null}
          <Form.Item name="status" label="帖子状态" rules={[{ required: true, message: "请选择帖子状态" }]}>
            <Select>
              <Select.Option value="published">已发布</Select.Option>
              <Select.Option value="rejected">已驳回</Select.Option>
              <Select.Option value="hidden">已隐藏</Select.Option>
              <Select.Option value="removed">已删除</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="reason" label="处理原因">
            <TextArea rows={4} maxLength={500} placeholder="写明发布、隐藏、恢复或删除原因。" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="圈子帖子 SEO / GEO"
        open={seoModalOpen}
        onCancel={() => {
          setSeoModalOpen(false);
          setActivePost(null);
        }}
        onOk={() => void handleSeoSubmit()}
        okText="保存"
        confirmLoading={seoSaving}
        destroyOnClose
      >
        <Form form={seoForm} layout="vertical" initialValues={{ searchIndexable: false }}>
          <Alert
            type="info"
            showIcon
            message="普通帖子默认不收录；只有已发布且人工确认适合公开搜索的帖子，才能开启搜索收录。"
            style={{ marginBottom: 16 }}
          />
          <Form.Item name="seoTitle" label="SEO 标题" rules={[{ max: 120, message: "最多 120 个字符" }]}>
            <Input maxLength={120} placeholder="留空时使用帖子正文摘要" />
          </Form.Item>
          <Form.Item name="seoDescription" label="SEO 描述" rules={[{ max: 300, message: "最多 300 个字符" }]}>
            <TextArea rows={3} maxLength={300} placeholder="留空时使用帖子正文摘要" />
          </Form.Item>
          <Form.Item name="seoKeywords" label="SEO 关键词">
            <Select mode="tags" tokenSeparators={[",", "，", "\n"]} placeholder="输入后按回车或逗号分隔，最多 20 项" />
          </Form.Item>
          <Form.Item name="geoKeywords" label="GEO 关键词">
            <Select mode="tags" tokenSeparators={[",", "，", "\n"]} placeholder="用于生成式搜索理解，最多 20 项" />
          </Form.Item>
          <Form.Item name="searchIndexable" valuePropName="checked">
            <Checkbox disabled={activePost?.status !== "published"}>允许搜索引擎收录该已发布帖子</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={detailReportsTitle}
        open={detailReportsOpen}
        footer={null}
        width={900}
        onCancel={() => setDetailReportsOpen(false)}
        destroyOnClose
      >
        <Table rowKey="id" loading={detailReportsLoading} columns={reportColumns} dataSource={detailReportRows} pagination={false} />
      </Modal>

      <Modal
        title={auditTitle}
        open={auditModalOpen}
        footer={null}
        width={860}
        onCancel={() => setAuditModalOpen(false)}
        destroyOnClose
      >
        <Table
          rowKey="id"
          loading={auditLoading}
          dataSource={auditRows}
          pagination={false}
          columns={[
            {
              title: "时间",
              dataIndex: "createdAt",
              width: 180,
              render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm:ss"),
            },
            {
              title: "操作",
              dataIndex: "action",
              width: 180,
            },
            {
              title: "管理员",
              width: 160,
              render: (_: unknown, row: AdminAuditLogEntry) => row.admin?.displayName || row.admin?.email || "-",
            },
            {
              title: "原因",
              dataIndex: "reason",
              render: (value: string | null) => value || "-",
            },
          ]}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" size={12} style={{ width: "100%" }}>
                <div>
                  <Text strong>Before</Text>
                  <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(row.beforeValue, null, 2)}</pre>
                </div>
                <div>
                  <Text strong>After</Text>
                  <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(row.afterValue, null, 2)}</pre>
                </div>
              </Space>
            ),
          }}
        />
      </Modal>
    </Space>
  );
};

export default InteractionReportsPage;
