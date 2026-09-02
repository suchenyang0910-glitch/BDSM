import React from "react";
import {
  Alert,
  Button,
  Card,
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
  listAdminInteractionComments,
  listAdminInteractionReports,
  moderateAdminInteractionComment,
  reviewAdminInteractionReport,
} from "../api/client";
import type {
  AdminInteractionReportItem,
  AdminInteractionCommentQueueItem,
  AdminRole,
  InteractionCommentStatus,
  InteractionReportStatus,
  InteractionTargetType,
  ModerateInteractionCommentInput,
  ReviewInteractionReportInput,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const VIEW_ROLES: AdminRole[] = ["super_admin", "customer_service", "operator", "editor", "auditor"];
const REVIEW_ROLES: AdminRole[] = ["super_admin", "customer_service", "operator", "editor"];

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

const TARGET_TYPE_LABEL: Record<InteractionTargetType, string> = {
  video_content: "视频",
  article: "文章",
  circle_post: "圈子帖子",
};

const REVIEWABLE_COMMENT_STATUSES: Array<Extract<InteractionCommentStatus, "approved" | "hidden" | "rejected" | "deleted">> = [
  "approved",
  "hidden",
  "rejected",
  "deleted",
];

const InteractionReportsPage: React.FC = () => {
  const { me } = useAuth();
  const canView = !!me && VIEW_ROLES.includes(me.role);
  const canReview = !!me && REVIEW_ROLES.includes(me.role);

  const [form] = Form.useForm<{ status?: InteractionReportStatus; targetType?: InteractionTargetType }>();
  const [commentQueueForm] = Form.useForm<{ status?: InteractionCommentStatus; targetType?: InteractionTargetType }>();
  const [rows, setRows] = React.useState<AdminInteractionReportItem[]>([]);
  const [commentRows, setCommentRows] = React.useState<AdminInteractionCommentQueueItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [total, setTotal] = React.useState(0);
  const [queueMode, setQueueMode] = React.useState<"reports" | "comments">("comments");

  const [reviewModalOpen, setReviewModalOpen] = React.useState(false);
  const [reviewForm] = Form.useForm<ReviewInteractionReportInput>();
  const [reviewing, setReviewing] = React.useState(false);
  const [activeReport, setActiveReport] = React.useState<AdminInteractionReportItem | null>(null);

  const [commentModalOpen, setCommentModalOpen] = React.useState(false);
  const [commentForm] = Form.useForm<ModerateInteractionCommentInput>();
  const [moderating, setModerating] = React.useState(false);
  const [activeComment, setActiveComment] = React.useState<AdminInteractionCommentQueueItem | null>(null);

  const fetchReports = React.useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    try {
      const values = form.getFieldsValue();
      const res = await listAdminInteractionReports({
        page,
        pageSize,
        status: values.status,
        targetType: values.targetType,
      });
      setRows(res.items || []);
      setTotal(res.total || 0);
    } catch (err: any) {
      message.error("互动举报列表加载失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setLoading(false);
    }
  }, [canView, form, page, pageSize]);

  const fetchComments = React.useCallback(async () => {
    if (!canView) return;
    setLoading(true);
    try {
      const values = commentQueueForm.getFieldsValue();
      const res = await listAdminInteractionComments({
        page,
        pageSize,
        status: values.status || "pending",
        targetType: values.targetType,
      });
      setCommentRows(res.items || []);
      setTotal(res.total || 0);
    } catch (err: any) {
      message.error("待审核评论队列加载失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setLoading(false);
    }
  }, [canView, commentQueueForm, page, pageSize]);

  React.useEffect(() => {
    if (queueMode === "reports") {
      void fetchReports();
    } else {
      void fetchComments();
    }
  }, [fetchComments, fetchReports, queueMode]);

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

  const handleReviewSubmit = async () => {
    if (!activeReport) return;
    const values = await reviewForm.validateFields();
    setReviewing(true);
    try {
      await reviewAdminInteractionReport(activeReport.id, values);
      message.success("举报状态已更新");
      setReviewModalOpen(false);
      setActiveReport(null);
      if (queueMode === "reports") {
        await fetchReports();
      } else {
        await fetchComments();
      }
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
      setActiveReport(null);
      setActiveComment(null);
      if (queueMode === "reports") {
        await fetchReports();
      } else {
        await fetchComments();
      }
    } catch (err: any) {
      message.error("评论审核失败：" + (err?.response?.data?.message || err?.message || "请稍后重试"));
    } finally {
      setModerating(false);
    }
  };

  const columns: ColumnsType<AdminInteractionReportItem> = [
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
          <Text type="secondary" style={{ fontSize: 12 }}>
            {row.targetId}
          </Text>
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
              <Tag color={COMMENT_STATUS_META[row.comment.status].color}>{COMMENT_STATUS_META[row.comment.status].label}</Tag>
              <Paragraph ellipsis={{ rows: 2, expandable: false }} style={{ marginBottom: 0 }}>
                {row.comment.body}
              </Paragraph>
            </>
          ) : (
            <Text type="secondary">目标级举报（{TARGET_TYPE_LABEL[row.targetType]}）</Text>
          )}
          {row.detailText ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              补充：{row.detailText}
            </Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 200,
      render: (_, row) => (
        <Space wrap>
          <Button size="small" onClick={() => openReviewModal(row)} disabled={!canReview}>
            处理举报
          </Button>
          <Button size="small" onClick={() => row.comment && openCommentModal({
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
            author: row.reporter,
            target: { id: row.targetId, title: row.targetId, status: "unknown" },
          }, row)} disabled={!row.comment || !canReview}>
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
      render: (value: InteractionCommentStatus) => <Tag color={COMMENT_STATUS_META[value].color}>{COMMENT_STATUS_META[value].label}</Tag>,
    },
    {
      title: "目标",
      width: 220,
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <Text strong>{TARGET_TYPE_LABEL[row.targetType]}</Text>
          <Text>{row.target?.title || row.targetId}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.targetId}</Text>
        </Space>
      ),
    },
    {
      title: "作者/评论",
      render: (_, row) => (
        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          <Text>{row.author?.displayName || "匿名用户"}</Text>
          <Paragraph ellipsis={{ rows: 3, expandable: false }} style={{ marginBottom: 0 }}>
            {row.body}
          </Paragraph>
        </Space>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 140,
      render: (_, row) => (
        <Button size="small" onClick={() => openCommentModal(row)} disabled={!canReview}>
          审核评论
        </Button>
      ),
    },
  ];

  if (!canView) {
    return <Alert type="warning" showIcon message="你当前没有查看互动审核页的权限。" />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Tabs
        activeKey={queueMode}
        onChange={(key) => {
          setQueueMode(key as "reports" | "comments");
          setPage(1);
        }}
        items={[
          {
            key: "comments",
            label: "待审核评论",
            children: (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card>
                  <Form
                    form={commentQueueForm}
                    layout="inline"
                    initialValues={{ status: "pending" }}
                    onFinish={() => {
                      setPage(1);
                      void fetchComments();
                    }}
                  >
                    <Form.Item name="status" label="评论状态">
                      <Select allowClear style={{ width: 160 }} placeholder="默认待审核">
                        {Object.entries(COMMENT_STATUS_META).map(([value, meta]) => (
                          <Select.Option key={value} value={value}>
                            {meta.label}
                          </Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                    <Form.Item name="targetType" label="目标类型">
                      <Select allowClear style={{ width: 160 }} placeholder="全部目标">
                        {Object.entries(TARGET_TYPE_LABEL).map(([value, label]) => (
                          <Select.Option key={value} value={value}>
                            {label}
                          </Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                    <Form.Item>
                      <Space>
                        <Button type="primary" htmlType="submit">筛选</Button>
                        <Button
                          onClick={() => {
                            commentQueueForm.resetFields();
                            commentQueueForm.setFieldsValue({ status: "pending" });
                            setPage(1);
                            void fetchComments();
                          }}
                        >
                          重置
                        </Button>
                      </Space>
                    </Form.Item>
                  </Form>
                </Card>
                <Card title="待审核评论队列" extra={<Text type="secondary">不需要先被举报，pending 评论会直接进入这里</Text>}>
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
                      onChange: (nextPage: number, nextPageSize: number) => {
                        setPage(nextPage);
                        setPageSize(nextPageSize);
                      },
                    }}
                  />
                </Card>
              </Space>
            ),
          },
          {
            key: "reports",
            label: "举报队列",
            children: (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card>
                  <Form
                    form={form}
                    layout="inline"
                    onFinish={() => {
                      setPage(1);
                      void fetchReports();
                    }}
                  >
                    <Form.Item name="status" label="举报状态">
                      <Select allowClear style={{ width: 160 }} placeholder="全部状态">
                        {Object.entries(REPORT_STATUS_META).map(([value, meta]) => (
                          <Select.Option key={value} value={value}>
                            {meta.label}
                          </Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                    <Form.Item name="targetType" label="目标类型">
                      <Select allowClear style={{ width: 160 }} placeholder="全部目标">
                        {Object.entries(TARGET_TYPE_LABEL).map(([value, label]) => (
                          <Select.Option key={value} value={value}>
                            {label}
                          </Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                    <Form.Item>
                      <Space>
                        <Button type="primary" htmlType="submit">筛选</Button>
                        <Button
                          onClick={() => {
                            form.resetFields();
                            setPage(1);
                            void fetchReports();
                          }}
                        >
                          重置
                        </Button>
                      </Space>
                    </Form.Item>
                  </Form>
                </Card>
                <Card title="互动举报队列" extra={<Text type="secondary">E1 仅允许将评论级举报标记为“已处理”</Text>}>
                  <Table
                    rowKey="id"
                    loading={loading}
                    columns={columns}
                    dataSource={rows}
                    pagination={{
                      current: page,
                      pageSize,
                      total,
                      showSizeChanger: true,
                      onChange: (nextPage: number, nextPageSize: number) => {
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
                    {COMMENT_STATUS_META[status].label}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          ) : (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="目标级举报在 E1 只能标记为 reviewing 或 dismissed，不能直接标记为 actioned。"
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
                <Tag color={COMMENT_STATUS_META[activeComment.status].color}>
                  {COMMENT_STATUS_META[activeComment.status].label}
                </Tag>
                <Paragraph style={{ marginBottom: 0 }}>{activeComment.body}</Paragraph>
              </Space>
            </Card>
          ) : null}
          <Form.Item name="status" label="评论状态" rules={[{ required: true, message: "请选择评论状态" }]}>
            <Select>
              {REVIEWABLE_COMMENT_STATUSES.map((status) => (
                <Select.Option key={status} value={status}>
                  {COMMENT_STATUS_META[status].label}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="reason" label="审核原因">
            <TextArea rows={4} maxLength={500} placeholder="写明为什么隐藏、驳回或恢复。" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
};

export default InteractionReportsPage;
