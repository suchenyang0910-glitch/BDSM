import React, { useCallback, useMemo, useState } from "react";
import {
  Table,
  Button,
  Space,
  Input,
  Select,
  Form,
  Tag,
  Drawer,
  Descriptions,
  Empty,
  Tooltip,
  message as antdMsg,
  Modal,
  Typography,
  Badge,
  Timeline as AntTimeline,
  Tabs,
  Avatar,
  Divider,
  List,
} from "antd";
import {
  SearchOutlined,
  EyeOutlined,
  ReloadOutlined,
  UserOutlined,
  MessageOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  UserAddOutlined,
  FormOutlined,
  ExclamationCircleFilled,
} from "@ant-design/icons";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import dayjs from "dayjs";
import {
  listAdminTickets,
  getAdminTicket,
  createAdminTicket,
  adminAssignTicketSelf,
  adminAddTicketNote,
  adminResolveTicket,
  adminCloseTicket,
  listAdminUsers,
} from "../api/client";
import type {
  SupportTicketItem,
  SupportTicketDetail,
  TicketStatus,
  TicketPriority,
  TicketCategory,
  TicketEventType,
  TicketEventItem,
  CreateTicketInput,
  AdminRole,
  AdminUserItem,
  SupportTicketsFilter,
  OrderStatus,
  EntitlementStatus,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";

const { Text, Title } = Typography;
const { Option } = Select;
const { TextArea: FormTextArea } = Input;

const ROLE_LABEL: Record<AdminRole, string> = {
  super_admin: "超级管理员",
  operator: "运营",
  editor: "内容编审",
  customer_service: "客服",
  finance: "财务",
  auditor: "审计",
};

const STATUS_META: Record<TicketStatus, { label: string; color: string; dot: any }> = {
  open: { label: "待处理", color: "red", dot: "error" },
  in_progress: { label: "处理中", color: "processing", dot: "processing" },
  resolved: { label: "已解决", color: "green", dot: "success" },
  closed: { label: "已关闭", color: "default", dot: "default" },
};

const PRIORITY_META: Record<TicketPriority, { label: string; color: string }> = {
  urgent: { label: "紧急", color: "red" },
  high: { label: "高", color: "orange" },
  normal: { label: "中", color: "blue" },
  low: { label: "低", color: "default" },
};

const CATEGORY_META: Record<TicketCategory, { label: string; color: string }> = {
  payment: { label: "支付问题", color: "magenta" },
  entitlement: { label: "权益相关", color: "geekblue" },
  access: { label: "访问 / 频道", color: "purple" },
  refund: { label: "退款相关", color: "volcano" },
  other: { label: "其他咨询", color: "cyan" },
};

const EVENT_META: Record<TicketEventType, { label: string; color: string }> = {
  created: { label: "工单创建", color: "blue" },
  assigned: { label: "分配处理人", color: "purple" },
  note_internal: { label: "内部备注", color: "default" },
  note_public: { label: "用户可见备注", color: "cyan" },
  status_changed: { label: "状态变更", color: "geekblue" },
  resolved: { label: "解决", color: "green" },
  closed: { label: "关单", color: "default" },
  action_taken: { label: "补偿/操作", color: "magenta" },
};

const VIEW_ROLES: AdminRole[] = ["super_admin", "customer_service", "operator", "editor", "auditor"];
const ASSIGN_SELF_ROLES: AdminRole[] = ["super_admin", "customer_service"];
const NOTE_ROLES: AdminRole[] = ["super_admin", "customer_service"];
const RESOLVE_ROLES: AdminRole[] = ["super_admin", "customer_service"];
const CLOSE_ROLES: AdminRole[] = ["super_admin", "customer_service"];
const CREATE_ROLES: AdminRole[] = ["super_admin", "customer_service"];

type NoteType = "note_public" | "note_internal";

const SupportTicketsPage: React.FC = () => {
  const { me } = useAuth();
  const canView = !!me && VIEW_ROLES.includes(me.role);
  const canCreate = !!me && CREATE_ROLES.includes(me.role);
  const canAssignSelf = !!me && ASSIGN_SELF_ROLES.includes(me.role);
  const canNote = !!me && NOTE_ROLES.includes(me.role);
  const canResolve = !!me && RESOLVE_ROLES.includes(me.role);
  const canClose = !!me && CLOSE_ROLES.includes(me.role);

  const [form] = Form.useForm<Omit<SupportTicketsFilter, "page" | "pageSize" | "mine" | "assignedToId">>();
  const [activeTab, setActiveTab] = useState<"all" | "mine" | "unassigned">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<SupportTicketItem[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<SupportTicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [assignLoading, setAssignLoading] = useState(false);
  const [resolveLoading, setResolveLoading] = useState(false);
  const [closeLoading, setCloseLoading] = useState(false);
  const [noteForm] = Form.useForm<{
    noteText: string;
    noteType: NoteType;
    reason?: string;
  }>();
  const [noteLoading, setNoteLoading] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createForm] = Form.useForm<
    Partial<CreateTicketInput> & {
      reason?: string;
      searchUser?: string;
      selectedUserId?: string | null;
    }
  >();
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [userSearchOptions, setUserSearchOptions] = useState<
    Array<{ value: string; label: React.ReactNode; item: AdminUserItem }>
  >([]);

  const fetchData = useCallback(async () => {
    const v = form.getFieldsValue();
    setLoading(true);
    try {
      const params: SupportTicketsFilter = { ...v, page, pageSize };
      if (activeTab === "mine") params.mine = true;
      else if (activeTab === "unassigned") params.unassignedOnly = true;
      const res = await listAdminTickets(params);
      setRows(res.items);
      setTotal(res.pagination.total);
    } catch (e: any) {
      antdMsg.error("工单列表加载失败：" + (e?.response?.data?.message || e.message));
    } finally {
      setLoading(false);
    }
  }, [form, page, pageSize, activeTab]);

  React.useEffect(() => { fetchData(); }, [fetchData]);

  const onSearch = () => { setPage(1); setTimeout(fetchData, 0); };
  const onReset = () => { form.resetFields(); setPage(1); setTimeout(fetchData, 0); };

  const openDetail = async (t: SupportTicketItem) => {
    setDetailOpen(true);
    setDetailLoading(true);
    noteForm.resetFields();
    try {
      const latest = await getAdminTicket(t.id);
      setDetail(latest);
    } catch (e: any) {
      antdMsg.error("工单详情加载失败：" + (e?.response?.data?.message || e.message));
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async () => {
    if (!detail) return;
    const latest = await getAdminTicket(detail.id);
    setDetail(latest);
  };

  const handleUserSearch = async (keyword: string) => {
    if (!keyword || keyword.length < 1) return;
    setUserSearchLoading(true);
    try {
      const r = await listAdminUsers({ q: keyword, pageSize: 20 });
      setUserSearchOptions(
        r.items.map((u) => ({
          value: u.id,
          label: (
            <Space>
              <Text strong>{u.displayName}</Text>
              {u.username ? <Tag>@{u.username}</Tag> : null}
              {u.telegramUserId ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  TG {u.telegramUserId}
                </Text>
              ) : null}
            </Space>
          ),
          item: u,
        })),
      );
    } catch (e: any) {
      antdMsg.error("用户搜索失败：" + (e?.response?.data?.message || e.message));
    } finally {
      setUserSearchLoading(false);
    }
  };

  const doAssignSelf = async () => {
    if (!detail) return;
    setAssignLoading(true);
    try {
      await adminAssignTicketSelf(detail.id, "主动领单处理");
      antdMsg.success(`已将工单 ${detail.ticketNo} 分配给我，状态：处理中`);
      await refreshDetail();
      await fetchData();
    } catch (e: any) {
      const s = e?.response?.status;
      const body = e?.response?.data;
      if (s === 403) antdMsg.error("你没有分配工单的权限，需要客服或超管");
      else if (s === 409) antdMsg.error(body?.message || "当前工单状态不允许领单");
      else antdMsg.error("领单失败：" + (body?.message || body?.error || e.message));
    } finally {
      setAssignLoading(false);
    }
  };

  const doAddNote = async () => {
    if (!detail) return;
    const v = await noteForm.validateFields();
    setNoteLoading(true);
    try {
      await adminAddTicketNote(detail.id, v.noteText, {
        isPublic: v.noteType === "note_public",
      });
      antdMsg.success(
        v.noteType === "note_internal" ? "已追加内部备注（用户不可见）" : "已追加公开备注（用户可见）",
      );
      noteForm.resetFields();
      await refreshDetail();
      await fetchData();
    } catch (e: any) {
      const s = e?.response?.status;
      const body = e?.response?.data;
      if (s === 403) antdMsg.error("你没有追加备注的权限");
      else if (s === 409) antdMsg.error(body?.message || "工单已关单，不可追加备注");
      else antdMsg.error("追加备注失败：" + (body?.message || body?.error || e.message));
    } finally {
      setNoteLoading(false);
    }
  };

  const doResolve = async () => {
    if (!detail) return;
    setResolveLoading(true);
    try {
      await new Promise<void>((resolve, reject) => {
        Modal.confirm({
          title: "确认解决此工单？",
          icon: <CheckCircleOutlined style={{ color: "#52c41a" }} />,
          content: (
            <div>
              <p>
                将工单状态 <Tag color={STATUS_META[detail.status].color}>{STATUS_META[detail.status].label}</Tag>{" "}
                → <Tag color="green">已解决 resolved</Tag>，记录解决事件。
              </p>
              <p style={{ fontSize: 12, color: "#666" }}>
                解决后用户可能仍可追加评论，但处理人已无需进一步行动。如需永久归档，请再点「关单」。
              </p>
            </div>
          ),
          okText: "确认解决",
          cancelText: "取消",
          okButtonProps: { danger: false, type: "primary" },
          onOk: () => resolve(),
          onCancel: () => reject(new Error("cancel")),
        });
      });
      await adminResolveTicket(detail.id, "客服确认问题已解决");
      antdMsg.success(`已解决工单 ${detail.ticketNo}`);
      await refreshDetail();
      await fetchData();
    } catch (e: any) {
      if (e?.message === "cancel") return;
      const s = e?.response?.status;
      const body = e?.response?.data;
      if (s === 403) antdMsg.error("你没有解决工单的权限");
      else if (s === 409) antdMsg.error(body?.message || "已解决 / 已关闭的工单不可重复解决");
      else antdMsg.error("解决失败：" + (body?.message || body?.error || e.message));
    } finally {
      setResolveLoading(false);
    }
  };

  const doClose = async () => {
    if (!detail) return;
    setCloseLoading(true);
    try {
      await new Promise<void>((resolve, reject) => {
        Modal.confirm({
          title: "⚠️ 确认关单？关单后不可追加备注 / 解决（不可恢复）",
          icon: <ExclamationCircleFilled style={{ color: "#f5222d" }} />,
          content: (
            <div>
              <p>
                关单后工单状态 → <Tag color="default">closed</Tag>，所有写操作接口返回 409。
              </p>
              <p style={{ fontSize: 12, color: "#666" }}>
                如果只是处理完成但用户可能回评，建议先用「解决」；如确认结案归档再点关单。
              </p>
            </div>
          ),
          okText: "永久关单",
          cancelText: "取消",
          okButtonProps: { danger: true },
          onOk: () => resolve(),
          onCancel: () => reject(new Error("cancel")),
        });
      });
      await adminCloseTicket(detail.id, "客服关单结案");
      antdMsg.success(`工单 ${detail.ticketNo} 已关单`);
      await refreshDetail();
      await fetchData();
    } catch (e: any) {
      if (e?.message === "cancel") return;
      const s = e?.response?.status;
      const body = e?.response?.data;
      if (s === 403) antdMsg.error("你没有关单的权限");
      else if (s === 409) antdMsg.error(body?.message || "已关单的工单不可重复关单");
      else antdMsg.error("关单失败：" + (body?.message || body?.error || e.message));
    } finally {
      setCloseLoading(false);
    }
  };

  const doCreate = async () => {
    const v = await createForm.validateFields();
    if (!v.selectedUserId) return;
    setCreateSubmitting(true);
    try {
      const input: CreateTicketInput = {
        userId: v.selectedUserId,
        title: v.title!,
        category: v.category!,
        priority: v.priority || "normal",
        description: v.description,
        initialNotePublic: v.initialPublicNote,
      };
      const tkt = await createAdminTicket(input);
      antdMsg.success(`已代开单 ${tkt.ticketNo}，已写入审计日志`);
      setCreateModalOpen(false);
      createForm.resetFields();
      await fetchData();
    } catch (e: any) {
      const s = e?.response?.status;
      const body = e?.response?.data;
      if (s === 403) antdMsg.error("你没有代开单的权限，需要客服或超管");
      else if (s === 400) antdMsg.error("参数错误：" + (body?.message || JSON.stringify(body?.details || {})));
      else if (s === 404) antdMsg.error(body?.message || "用户不存在");
      else antdMsg.error("开单失败：" + (body?.message || body?.error || e.message));
    } finally {
      setCreateSubmitting(false);
    }
  };

  const columns = useMemo<ColumnsType<SupportTicketItem>>(
    () => [
      {
        title: "工单号",
        dataIndex: "ticketNo",
        key: "no",
        width: 200,
        fixed: "left",
        render: (v: string, r: SupportTicketItem) => (
          <Space>
            <Text code copyable style={{ fontSize: 12 }}>{v}</Text>
            <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => openDetail(r)}>详情</Button>
          </Space>
        ),
      },
      {
        title: "用户",
        key: "user",
        width: 220,
        render: (_: unknown, r: SupportTicketItem) => (
          <div>
            <div>
              <Avatar size={22} icon={<UserOutlined />} src={r.user?.avatarUrl || r.user?.photoUrl || undefined}>
                {r.user?.displayName?.slice(0, 1)}
              </Avatar>
              <Text strong style={{ marginLeft: 6 }}>{r.user?.displayName || "未知用户"}</Text>
              {r.user?.username ? <Tag style={{ marginLeft: 4 }}>@{r.user.username}</Tag> : null}
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {r.user?.telegramUserId ? `TG: ${r.user.telegramUserId}  ` : ""}
                ID <Text code copyable>{r.userId.slice(0, 10)}…</Text>
              </Text>
            </div>
          </div>
        ),
      },
      {
        title: "分类 / 优先级",
        key: "cat",
        width: 160,
        render: (_: unknown, r: SupportTicketItem) => (
          <Space direction="vertical" size={2}>
            <Tag color={CATEGORY_META[r.category]?.color}>{CATEGORY_META[r.category]?.label || r.category}</Tag>
            <Tag color={PRIORITY_META[r.priority]?.color}>
              优先级：{PRIORITY_META[r.priority]?.label || r.priority}
            </Tag>
          </Space>
        ),
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 130,
        render: (s: TicketStatus) => {
          const m = STATUS_META[s];
          return <Badge status={m.dot} text={<Tag color={m.color}>{m.label}</Tag>} />;
        },
      },
      {
        title: "处理人",
        key: "assignee",
        width: 140,
        render: (_: unknown, r: SupportTicketItem) =>
          r.assignedToId ? (
            <Space>
              <Avatar size={22} icon={<UserOutlined />}>
                {(r.assignedTo?.displayName || r.assignedToName || "?").slice(0, 1)}
              </Avatar>
              <Text>{r.assignedTo?.displayName || r.assignedToName || "已分配"}</Text>
            </Space>
          ) : <Tag icon={<UserAddOutlined />} color="warning">待分配 · 点击领单</Tag>,
      },
      {
        title: "关联",
        key: "rel",
        width: 220,
        render: (_: unknown, r: SupportTicketItem) => {
          const bits: React.ReactNode[] = [];
          const orderNo = r.sourceOrderNo || r.sourceOrder?.orderNo;
          const orderStatus = r.sourceOrder?.status;
          const entId = r.relatedEntitlementId || r.entitlementId;
          const entStatus = r.entitlement?.status;
          if (orderNo) bits.push(
            <Tag key="o" icon={<FileTextOutlined />}>
              订单 {orderNo.slice(-6)}
              {orderStatus ? (
                <Text type="secondary" style={{ fontSize: 10 }}> {orderStatus}</Text>
              ) : null}
            </Tag>,
          );
          if (entId) bits.push(
            <Tag key="e" icon={<SafetyCertificateOutlined />} color="geekblue">
              权益 {entId.slice(-6)}…
              {entStatus ? (
                <Text type="secondary" style={{ fontSize: 10 }}> {entStatus}</Text>
              ) : null}
            </Tag>,
          );
          if (!bits.length) return <Text type="secondary">—</Text>;
          return <Space wrap>{bits}</Space>;
        },
      },
      {
        title: "事件数 / 标题摘要",
        key: "sum",
        render: (_: unknown, r: SupportTicketItem) => (
          <div style={{ fontSize: 13 }}>
            <div>
              <MessageOutlined /> 事件 {r.eventsCount ?? 0} 条
              {r.lastEventAt ? (
                <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                  最近 {dayjs(r.lastEventAt).format("MM-DD HH:mm")}
                </Text>
              ) : null}
            </div>
            <div style={{ marginTop: 2 }}>
              {r.title ? <Text ellipsis style={{ maxWidth: 320 }}>{r.title}</Text> : <Text type="secondary">(无标题)</Text>}
            </div>
          </div>
        ),
      },
      {
        title: "创建 / 期限",
        key: "t",
        width: 220,
        render: (_: unknown, r: SupportTicketItem) => (
          <div style={{ fontSize: 12 }}>
            <div>
              <Text type="secondary">创建：</Text>
              {dayjs(r.createdAt).format("YYYY-MM-DD HH:mm")}
            </div>
            <div>
              <Text type="secondary">更新：</Text>
              {dayjs(r.updatedAt).format("YYYY-MM-DD HH:mm")}
            </div>
            {r.dueAt ? (
              <div>
                <Text type="secondary">期限：</Text>
                {dayjs(r.dueAt).format("MM-DD HH:mm")}
                {dayjs(r.dueAt).isBefore(dayjs()) && r.status !== "closed" && r.status !== "resolved" ? (
                  <Tag color="red">已逾期</Tag>
                ) : null}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        title: "操作",
        key: "act",
        fixed: "right",
        width: 240,
        render: (_: unknown, r: SupportTicketItem) => {
          const locked = r.status === "closed" || r.status === "resolved";
          return (
            <Space wrap>
              <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(r)}>详情</Button>
              {canAssignSelf && !r.assignedToId && !locked ? (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<UserAddOutlined />}
                  onClick={async () => {
                    try {
                      setAssignLoading(true);
                      await adminAssignTicketSelf(r.id, "列表页一键领单");
                      antdMsg.success(`已领单 ${r.ticketNo}`);
                      await fetchData();
                    } catch (e: any) {
                      antdMsg.error("领单失败：" + (e?.response?.data?.message || e.message));
                    } finally {
                      setAssignLoading(false);
                    }
                  }}
                  loading={assignLoading && detail?.id === r.id}
                >
                  领单
                </Button>
              ) : null}
            </Space>
          );
        },
      },
    ],
    [canAssignSelf, assignLoading, detail?.id],
  );

  const pagination: TablePaginationConfig = {
    current: page, pageSize, total,
    showSizeChanger: true, showQuickJumper: true,
    pageSizeOptions: ["10", "20", "50", "100"],
    showTotal: (t) => `共 ${t} 条工单`,
    onChange: (p, s) => { setPage(p); setPageSize(s); },
  };

  if (!canView) {
    return (
      <Empty
        description={
          <Tag icon={<ExclamationCircleFilled />} color="warning">
            你的账号「{me?.role || "未登录"}」无 ticket:view 权限。需要客服/运营/编审/审计或超管。
          </Tag>
        }
      />
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Tabs
          activeKey={activeTab}
          onChange={(k) => { setActiveTab(k as any); setPage(1); setTimeout(fetchData, 0); }}
          items={[
            { key: "all", label: (<Badge status="default" text={<b>全部工单</b>} />) },
            { key: "mine", label: (<Badge status="processing" text={<b>我的工单</b>} />) },
            { key: "unassigned", label: (<Badge status="error" text={<b>待分配 · 未认领</b>} />) },
          ]}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={onSearch}
          style={{ rowGap: 8, columnGap: 12, display: "flex", flexWrap: "wrap" }}
        >
          <Form.Item name="q" label="搜索">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="标题 / 工单号（TKT开头）/ 描述"
              style={{ width: 280 }}
            />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Select allowClear style={{ width: 150 }} placeholder="全部分类">
              {(Object.keys(CATEGORY_META) as TicketCategory[]).map((s) => (
                <Option key={s} value={s}>{CATEGORY_META[s].label}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="priority" label="优先级">
            <Select allowClear style={{ width: 130 }} placeholder="全部优先级">
              {(Object.keys(PRIORITY_META) as TicketPriority[]).map((s) => (
                <Option key={s} value={s}>{PRIORITY_META[s].label}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select allowClear style={{ width: 130 }} placeholder="全部状态">
              {(Object.keys(STATUS_META) as TicketStatus[]).map((s) => (
                <Option key={s} value={s}>{STATUS_META[s].label}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="userId" label="用户ID">
            <Input allowClear placeholder="user_xxx 精确" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="telegramUserId" label="TG UID">
            <Input allowClear placeholder="精确" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="orderNo" label="关联订单">
            <Input allowClear prefix={<FileTextOutlined />} placeholder="INT..." style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="entitlementId" label="权益ID">
            <Input allowClear placeholder="权益精确" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item>
            <Space wrap>
              <Button type="primary" icon={<SearchOutlined />} htmlType="submit">搜索</Button>
              <Button icon={<ReloadOutlined />} onClick={onReset}>重置</Button>
              {canCreate ? (
                <Tooltip title="客服代用户开单（紧急电话沟通 / 补偿工单等），写入审计日志和 created 事件">
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
                    客服代开单
                  </Button>
                </Tooltip>
              ) : null}
            </Space>
          </Form.Item>
        </Form>
      </div>

      <Table<SupportTicketItem>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={pagination}
        scroll={{ x: 1900 }}
        locale={{ emptyText: <Empty description="暂无工单数据。Mini App 用户提交反馈后会自动建档，或用「代开单」手动创建。" /> }}
      />

      <Drawer
        title={
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <Space>
              <MessageOutlined />
              <Title level={4} style={{ margin: 0 }}>
                工单详情
                {detail ? (
                  <Space style={{ marginLeft: 8 }}>
                    <Text code copyable>{detail.ticketNo}</Text>
                    {detail.status ? (
                      <Badge status={STATUS_META[detail.status]?.dot} text={
                        <Tag color={STATUS_META[detail.status]?.color}>
                          {STATUS_META[detail.status]?.label}
                        </Tag>
                      } />
                    ) : null}
                    {detail.category ? <Tag color={CATEGORY_META[detail.category]?.color}>
                      {CATEGORY_META[detail.category]?.label}
                    </Tag> : null}
                    {detail.priority ? <Tag color={PRIORITY_META[detail.priority]?.color}>
                      {PRIORITY_META[detail.priority]?.label}
                    </Tag> : null}
                  </Space>
                ) : null}
              </Title>
            </Space>
            <Space>
              {detail ? (
                <>
                  {canAssignSelf && !detail.assignedToId && detail.status !== "closed" ? (
                    <Button
                      type="primary"
                      ghost
                      size="small"
                      icon={<UserAddOutlined />}
                      loading={assignLoading}
                      onClick={doAssignSelf}
                    >
                      我来领单
                    </Button>
                  ) : null}
                  {canResolve && detail.status !== "resolved" && detail.status !== "closed" ? (
                    <Button
                      size="small"
                      icon={<CheckCircleOutlined />}
                      loading={resolveLoading}
                      onClick={doResolve}
                    >
                      标记解决
                    </Button>
                  ) : null}
                  {canClose && detail.status !== "closed" ? (
                    <Button
                      size="small"
                      danger
                      icon={<CloseCircleOutlined />}
                      loading={closeLoading}
                      onClick={doClose}
                    >
                      关单
                    </Button>
                  ) : null}
                </>
              ) : null}
            </Space>
          </Space>
        }
        placement="right"
        width={960}
        onClose={() => setDetailOpen(false)}
        open={detailOpen}
        destroyOnClose
      >
        {detailLoading ? <div style={{ textAlign: "center", padding: 40 }}><Empty description="加载中..." /></div> :
         !detail ? <Empty description="暂无工单详情" /> : (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Descriptions bordered column={2} size="small" title={<Space><FileTextOutlined />工单概览</Space>}>
              <Descriptions.Item label="工单号">
                <Text copyable code>{detail.ticketNo}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="用户">
                <Avatar size={22} icon={<UserOutlined />} src={detail.user?.avatarUrl || detail.user?.photoUrl || undefined}>
                  {detail.user?.displayName?.slice(0, 1)}
                </Avatar>
                <Text strong style={{ marginLeft: 6 }}>{detail.user?.displayName || "-"}</Text>
                {detail.user?.username ? <Tag style={{ marginLeft: 4 }}>@{detail.user.username}</Tag> : null}
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {detail.user?.telegramUserId ? `TG: ${detail.user.telegramUserId}；` : ""}
                    ID {detail.userId}
                  </Text>
                </div>
              </Descriptions.Item>
              <Descriptions.Item label="分类 / 优先级">
                <Space direction="vertical" size={2}>
                  <Tag color={CATEGORY_META[detail.category]?.color}>
                    {CATEGORY_META[detail.category]?.label || detail.category}
                  </Tag>
                  <Tag color={PRIORITY_META[detail.priority]?.color}>
                    优先级：{PRIORITY_META[detail.priority]?.label || detail.priority}
                  </Tag>
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="处理人">
                {detail.assignedToId ? (
                  <Space>
                    <Avatar size={22} icon={<UserOutlined />}>
                      {(detail.assignedTo?.displayName || detail.assignedToName || "?").slice(0, 1)}
                    </Avatar>
                    <div>
                      <Text>{detail.assignedTo?.displayName || detail.assignedToName || "已分配"}</Text>
                      <div>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          分配于 {detail.assignedAt ? dayjs(detail.assignedAt).format("YYYY-MM-DD HH:mm") : "-"}
                        </Text>
                      </div>
                    </div>
                  </Space>
                ) : <Tag color="warning">待分配，建议点击右上「我来领单」</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="关联订单" span={1}>
                {(() => {
                  const orderNo = detail.sourceOrderNo || detail.sourceOrder?.orderNo;
                  const orderStatus = detail.sourceOrderStatus || detail.sourceOrder?.status;
                  return orderNo ? (
                    <Space>
                      <Text code copyable>{orderNo}</Text>
                      {orderStatus ? <Tag>{orderStatus}</Tag> : null}
                    </Space>
                  ) : <Text type="secondary">- 无关联订单 -</Text>;
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="关联权益" span={1}>
                {(() => {
                  const entId = detail.relatedEntitlementId || detail.entitlementId;
                  const entStatus = detail.relatedEntitlementStatus || detail.entitlement?.status;
                  return entId ? (
                    <Space>
                      <Text code copyable>{entId}</Text>
                      {entStatus ? <Tag>{entStatus}</Tag> : null}
                    </Space>
                  ) : <Text type="secondary">- 无关联权益 -</Text>;
                })()}
              </Descriptions.Item>
              <Descriptions.Item label="工单标题" span={2}>
                {detail.title ? <Text strong>{detail.title}</Text> : <Text type="secondary">(无标题)</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="原始描述" span={2}>
                {detail.description ? (
                  <div style={{ padding: 10, background: "#fafafa", borderRadius: 6, whiteSpace: "pre-wrap" }}>
                    {detail.description}
                  </div>
                ) : <Text type="secondary">(无描述)</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="时间线">
                <div style={{ fontSize: 12 }}>
                  <div>创建 {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm:ss")}</div>
                  <div>更新 {dayjs(detail.updatedAt).format("YYYY-MM-DD HH:mm:ss")}</div>
                  {detail.resolvedAt ? (
                    <div style={{ color: "#52c41a" }}>
                      ✅ 解决于 {dayjs(detail.resolvedAt).format("YYYY-MM-DD HH:mm:ss")}
                    </div>
                  ) : null}
                  {detail.closedAt ? (
                    <div style={{ color: "#8c8c8c" }}>
                      🚪 关单于 {dayjs(detail.closedAt).format("YYYY-MM-DD HH:mm:ss")}
                    </div>
                  ) : null}
                </div>
              </Descriptions.Item>
              <Descriptions.Item label="截止时间">
                {detail.dueAt ? (
                  <div>
                    <Text>{dayjs(detail.dueAt).format("YYYY-MM-DD HH:mm:ss")}</Text>
                    {dayjs(detail.dueAt).isBefore(dayjs()) && detail.status !== "closed" && detail.status !== "resolved" ? (
                      <Tag color="red">已逾期</Tag>
                    ) : null}
                  </div>
                ) : <Text type="secondary">- 未设期限 -</Text>}
              </Descriptions.Item>
            </Descriptions>

            {canNote ? (
              <div
                style={{
                  border: "1px solid #d9d9d9",
                  borderRadius: 6,
                  padding: 12,
                  background: detail.status === "closed" ? "#fff7f7" : "#fafafa",
                }}
              >
                <Divider orientation="left" plain style={{ margin: "0 0 8px" }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>
                    <FormOutlined /> 追加备注 / 回复
                    {detail.status === "closed" ? (
                      <Tag color="red" style={{ marginLeft: 8 }}>⚠ 已关单，提交将返回 409</Tag>
                    ) : null}
                  </span>
                </Divider>
                <Form form={noteForm} layout="vertical" onFinish={doAddNote}>
                  <Space style={{ marginBottom: 8 }} wrap>
                    <Form.Item name="noteType" initialValue="note_internal" noStyle>
                      <Select style={{ width: 230 }}>
                        <Option value="note_internal">🔒 内部备注（用户不可见）</Option>
                        <Option value="note_public">📣 公开回复（用户可见）</Option>
                      </Select>
                    </Form.Item>
                    <Form.Item name="reason" noStyle>
                      <Input placeholder="简要原因（审计日志用）" style={{ width: 280 }} maxLength={200} />
                    </Form.Item>
                    <Space>
                      <Button
                        type="primary"
                        htmlType="submit"
                        loading={noteLoading}
                        disabled={detail.status === "closed"}
                      >
                        提交备注
                      </Button>
                      <Button onClick={() => noteForm.resetFields()} disabled={noteLoading}>
                        清空
                      </Button>
                    </Space>
                  </Space>
                  <Form.Item
                    name="noteText"
                    rules={[
                      { required: true, message: "备注内容不能为空" },
                      { min: 1, message: "至少 1 个字符" },
                      { max: 5000, message: "最长 5000 字符" },
                    ]}
                    noStyle
                  >
                    <FormTextArea
                      rows={3}
                      maxLength={5000}
                      showCount
                      placeholder={
                        detail.status === "closed"
                          ? "⚠ 工单已关单，不可追加备注"
                          : "公开回复会同步给用户；内部备注仅团队可见，用来贴补偿方案 / 协商结果 / 交接记录等。"
                      }
                      disabled={detail.status === "closed"}
                    />
                  </Form.Item>
                </Form>
              </div>
            ) : null}

            <Divider orientation="left" plain style={{ margin: "-4px 0 0" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                <MessageOutlined /> 工单事件 Timeline（事件数：{detail.events?.length ?? 0}）
              </span>
            </Divider>
            <div style={{ padding: "0 4px 12px 0" }}>
              {!detail.events || detail.events.length === 0 ? (
                <Empty description="暂无事件记录（不太正常，创建工单时应有 created 事件，刷新详情再看看）" />
              ) : (
                <AntTimeline
                  mode="left"
                  items={[...detail.events]
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                    .map((ev: TicketEventItem) => {
                      const meta = EVENT_META[ev.type] || { label: ev.type, color: "default" };
                      const color =
                        ev.type === "note_internal"
                          ? "gray"
                          : ev.type === "resolved"
                          ? "green"
                          : ev.type === "closed"
                          ? "#8c8c8c"
                          : ev.type === "action_taken"
                          ? "magenta"
                          : meta.color;
                      const author = (
                        <Space size={4}>
                          {ev.authorType === "admin" ? (
                            <>
                              <Avatar size={18} icon={<UserOutlined />}>
                                {(ev.authorAdmin?.displayName || ev.authorAdminName || (ev.authorAdminId || "A").slice(0, 1) || "A").slice(0, 1)}
                              </Avatar>
                              <Text strong>
                                {ev.authorAdmin?.displayName || ev.authorAdminName || `admin ${(ev.authorAdminId || "").slice(0, 8)}`}
                              </Text>
                              <Tag color="purple" style={{ margin: 0 }}>Admin</Tag>
                            </>
                          ) : ev.authorType === "user" ? (
                            <>
                              <Avatar size={18} icon={<UserOutlined />}
                                      src={ev.authorUser?.avatarUrl || ev.authorUser?.photoUrl || ev.authorUserAvatar || undefined}>
                                {(ev.authorUser?.displayName || ev.authorUserName || "U").slice(0, 1)}
                              </Avatar>
                              <Text strong>
                                {ev.authorUser?.displayName || ev.authorUserName || `user ${(ev.authorUserId || "").slice(0, 8)}`}
                              </Text>
                              <Tag style={{ margin: 0 }}>用户</Tag>
                            </>
                          ) : (
                            <>
                              <Avatar size={18}>S</Avatar>
                              <Text strong>系统</Text>
                              <Tag color="default" style={{ margin: 0 }}>System</Tag>
                            </>
                          )}
                        </Space>
                      );
                      const title = (
                        <Space wrap>
                          <Tag color={meta.color as any}>{meta.label}</Tag>
                          {ev.oldStatus || ev.newStatus ? (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              状态：
                              {ev.oldStatus ? <Tag>{ev.oldStatus}</Tag> : ""} → {ev.newStatus ? <Tag>{ev.newStatus}</Tag> : ""}
                            </Text>
                          ) : null}
                          {ev.actionRef ? (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              关联操作：<Text code>{ev.actionRef}</Text>
                            </Text>
                          ) : null}
                        </Space>
                      );
                      const body = ev.content || ev.note;
                      return {
                        color,
                        label: (
                          <div style={{ fontSize: 12 }}>
                            <div>{dayjs(ev.createdAt).format("YYYY-MM-DD HH:mm:ss")}</div>
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {ev.id?.slice(0, 8)}…
                            </Text>
                          </div>
                        ),
                        children: (
                          <Space direction="vertical" size={2} style={{ width: "100%" }}>
                            <Space wrap>{author}{title}</Space>
                            {body ? (
                              <div
                                style={{
                                  padding: 10,
                                  borderRadius: 6,
                                  fontSize: 13,
                                  whiteSpace: "pre-wrap",
                                  background:
                                    ev.type === "note_public"
                                      ? "#e6fffb"
                                      : ev.type === "note_internal"
                                      ? "#f5f5f5"
                                      : ev.type === "action_taken"
                                      ? "#fff0f6"
                                      : "#fafafa",
                                  borderLeft: `3px solid ${color}`,
                                }}
                              >
                                {body}
                              </div>
                            ) : null}
                            {ev.metadata && Object.keys((ev.metadata as any) || {}).length > 0 ? (
                              <List
                                size="small"
                                bordered
                                dataSource={Object.entries(ev.metadata as any)}
                                style={{ fontSize: 11 }}
                                renderItem={([k, v]: any) => (
                                  <List.Item>
                                    <Text type="secondary">{k}：</Text>
                                    <Text>{typeof v === "string" ? v : JSON.stringify(v)}</Text>
                                  </List.Item>
                                )}
                              />
                            ) : null}
                          </Space>
                        ),
                      };
                    })}
                />
              )}
            </div>
          </Space>
        )}
      </Drawer>

      <Modal
        title={<Space><PlusOutlined /><b>客服代开单（写入审计日志 + created 事件）</b></Space>}
        open={createModalOpen}
        onCancel={() => { setCreateModalOpen(false); createForm.resetFields(); }}
        onOk={doCreate}
        okText="确认开单"
        okButtonProps={{ danger: false, type: "primary" }}
        cancelText="取消"
        confirmLoading={createSubmitting}
        destroyOnClose
        width={640}
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            label={<b>反馈用户（必填，搜索并选择）</b>}
            name="selectedUserId"
            rules={[{ required: true, message: "请先搜索并选择用户" }]}
          >
            <Select
              showSearch
              filterOption={false}
              placeholder="按姓名 / 用户名 / TG UID 搜索"
              style={{ width: "100%" }}
              onSearch={handleUserSearch}
              loading={userSearchLoading}
              notFoundContent={userSearchLoading ? <span>搜索中…</span> : <span>请输入关键词搜索用户</span>}
              options={userSearchOptions}
            />
          </Form.Item>
          <Form.Item
            label={<b>工单分类（必填，影响筛选 / SLA）</b>}
            name="category"
            initialValue="other"
            rules={[{ required: true, message: "请选择分类" }]}
          >
            <Select>
              {(Object.keys(CATEGORY_META) as TicketCategory[]).map((s) => (
                <Option key={s} value={s}>
                  {CATEGORY_META[s].label}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={<b>优先级（必填）</b>}
            name="priority"
            initialValue="normal"
            rules={[{ required: true, message: "请选择优先级" }]}
          >
            <Select>
              {(Object.keys(PRIORITY_META) as TicketPriority[]).map((s) => (
                <Option key={s} value={s}>
                  {PRIORITY_META[s].label}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label="工单标题（必填，列表快速识别）"
            name="title"
            rules={[
              { required: true, message: "请填写标题" },
              { min: 2, message: "至少 2 个字符" },
              { max: 200, message: "最长 200 字符" },
            ]}
          >
            <Input placeholder="例如：用户误操作购买想退款 / 会员到期后仍无法看内容 / 频道无法加入" maxLength={200} />
          </Form.Item>
          <Form.Item
            label="工单描述（可选，作为原始描述写入 created 事件）"
            name="description"
          >
            <FormTextArea rows={2} maxLength={5000} showCount
              placeholder="电话 / IM 沟通的原始问题描述、用户反馈要点等，存入 description 字段作为工单底稿。" />
          </Form.Item>
          <Form.Item
            label="初始公开备注（可选，用户可见；建议写你已做了什么 / 下一步）"
            name="initialPublicNote"
            extra="用户端会看到该备注；如只是内部讨论，请不要填在这里，开单后在详情页追加「内部备注」。"
          >
            <FormTextArea rows={2} maxLength={5000} showCount
              placeholder="例如：已协助生成新频道邀请，请查收；或：财务已发起退款，24 小时内原路返回" />
          </Form.Item>
          <Divider style={{ margin: "8px 0" }} />
          <Form.Item
            label={<Space><ExclamationCircleFilled style={{ color: "#faad14" }} /><b>开单原因（必填，写入审计日志，永久保留）</b></Space>}
            name="reason"
            rules={[
              { required: true, message: "请说明为什么代用户开单" },
              { min: 2, message: "至少 2 个字符" },
              { max: 1000, message: "最长 1000 字符" },
            ]}
          >
            <FormTextArea rows={3} autoFocus maxLength={1000} showCount
              placeholder="例如：用户 TG 私聊客服反馈支付成功但权益未到账，电话确认订单号 INTxxxx；或：用户邮箱反馈退款，已核实订单情况属实，开补偿工单" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default SupportTicketsPage;
