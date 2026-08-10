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
  Divider,
  List,
} from "antd";
import {
  SearchOutlined,
  EyeOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
  PlusOutlined,
  LinkOutlined,
  ExclamationCircleFilled,
} from "@ant-design/icons";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import dayjs from "dayjs";
import {
  listAdminEntitlements,
  getAdminEntitlement,
  adminResendEntitlementInvite,
  adminGrantEntitlement,
  listAdminUsers,
} from "../api/client";
import type {
  EntitlementItem,
  EntitlementStatus,
  ResourceType,
  AdminRole,
  AdminUserItem,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";

const { Text, Title } = Typography;
const { Option } = Select;

const ROLE_LABEL: Record<AdminRole, string> = {
  super_admin: "超级管理员",
  operator: "运营",
  editor: "内容编审",
  customer_service: "客服",
  finance: "财务",
  auditor: "审计",
};

const ENTITLEMENT_STATUS_META: Record<EntitlementStatus, { label: string; color: string; badge: any }> = {
  active: { label: "有效", color: "green", badge: "success" },
  revoked: { label: "已回收", color: "default", badge: "default" },
  expired: { label: "已过期", color: "orange", badge: "warning" },
};

const RESOURCE_TYPE_LABEL: Record<ResourceType, string> = {
  content: "单条内容权益",
  package: "内容包权益",
  membership_channel: "会员频道权益",
};

const VIEW_ROLES: AdminRole[] = ["super_admin", "customer_service", "operator", "finance", "auditor"];
const RESEND_INVITE_ROLES: AdminRole[] = ["super_admin", "customer_service"];
const GRANT_ROLES: AdminRole[] = ["super_admin"];

const EntitlementsPage: React.FC = () => {
  const { me } = useAuth();
  const canView = !!me && VIEW_ROLES.includes(me.role);
  const canResendInvite = !!me && RESEND_INVITE_ROLES.includes(me.role);
  const canGrant = !!me && GRANT_ROLES.includes(me.role);

  const [form] = Form.useForm<{
    status?: EntitlementStatus;
    resourceType?: ResourceType;
    userId?: string;
    telegramUserId?: string;
    orderNo?: string;
    resourceId?: string;
  }>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<EntitlementItem[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<EntitlementItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [grantModalOpen, setGrantModalOpen] = useState(false);
  const [grantForm] = Form.useForm<{
    searchUser: string;
    selectedUserId: string | null;
    resourceType: ResourceType;
    resourceId: string;
    durationDays?: number;
    reason: string;
  }>();
  const [grantSubmitting, setGrantSubmitting] = useState(false);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [userSearchOptions, setUserSearchOptions] = useState<
    Array<{ value: string; label: React.ReactNode; item: AdminUserItem }>
  >([]);

  const fetchData = useCallback(async () => {
    const v = form.getFieldsValue();
    setLoading(true);
    try {
      const res = await listAdminEntitlements({
        page,
        pageSize,
        status: v.status,
        resourceType: v.resourceType,
        userId: v.userId?.trim() || undefined,
        telegramUserId: v.telegramUserId?.trim() || undefined,
        orderNo: v.orderNo?.trim() || undefined,
        resourceId: v.resourceId?.trim() || undefined,
      });
      setRows(res.items);
      setTotal(res.pagination.total);
    } catch (e: any) {
      antdMsg.error("权益列表加载失败：" + (e?.response?.data?.message || e.message));
    } finally {
      setLoading(false);
    }
  }, [form, page, pageSize]);

  React.useEffect(() => { fetchData(); }, [fetchData]);

  const onSearch = () => { setPage(1); setTimeout(fetchData, 0); };
  const onReset = () => { form.resetFields(); setPage(1); setTimeout(fetchData, 0); };

  const openDetail = async (e: EntitlementItem) => {
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const latest = await getAdminEntitlement(e.id);
      setDetail(latest);
    } catch (e: any) {
      antdMsg.error("权益详情加载失败：" + (e?.response?.data?.message || e.message));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleResendInvite = async (e: EntitlementItem) => {
    if (!canResendInvite || e.resourceType !== "membership_channel" || e.status !== "active") return;
    setResending(true);
    try {
      const r = await adminResendEntitlementInvite(e.id, "客服补发频道邀请（权益详情）");
      antdMsg.success(
        r.invite.inviteLink
          ? `已生成新邀请：${r.invite.inviteLink}（到期 ${dayjs(r.invite.expiresAt).format("MM-DD HH:mm")}）`
          : "已写入邀请链接",
      );
      const latest = await getAdminEntitlement(e.id);
      setDetail(latest);
      await fetchData();
    } catch (err: any) {
      const s = err?.response?.status;
      const body = err?.response?.data;
      if (s === 403) antdMsg.error("你没有补发邀请的权限，需要客服或超管");
      else if (s === 409) antdMsg.error(body?.message || "当前权益不满足补发条件");
      else if (s === 502) antdMsg.error("Telegram API 失败：" + (body?.message || "请稍后重试"));
      else antdMsg.error("补发失败：" + (body?.message || body?.error || err.message));
    } finally {
      setResending(false);
    }
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
              <Text type="secondary">
                权益 {u.activeEntitlementsCount}/{u.entitlementsCount}
              </Text>
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

  const doGrant = async () => {
    const v = await grantForm.validateFields();
    if (!v.selectedUserId) return;
    setGrantSubmitting(true);
    try {
      const r = await adminGrantEntitlement({
        userId: v.selectedUserId,
        resourceType: v.resourceType,
        resourceId: v.resourceId,
        durationDays: v.durationDays,
        reason: v.reason,
      });
      antdMsg.success(
        "已直接发放权益 " +
          (r.telegramInvite && !(r.telegramInvite as any).error
            ? `，已生成频道邀请：${(r.telegramInvite as any).inviteLink}`
            : (r.telegramInvite as any)?.error
            ? `，但频道邀请失败：${(r.telegramInvite as any).error}`
            : ""),
      );
      setGrantModalOpen(false);
      grantForm.resetFields();
      await fetchData();
    } catch (e: any) {
      const s = e?.response?.status;
      const body = e?.response?.data;
      if (s === 403) antdMsg.error("你没有直授权益的权限，需要客服或超管");
      else if (s === 400) antdMsg.error("参数错误：" + (body?.message || JSON.stringify(body?.details || {})));
      else if (s === 404) antdMsg.error(body?.message || "用户或资源不存在");
      else antdMsg.error("发放失败：" + (body?.message || body?.error || e.message));
    } finally {
      setGrantSubmitting(false);
    }
  };

  const columns = useMemo<ColumnsType<EntitlementItem>>(
    () => [
      {
        title: "权益 ID",
        dataIndex: "id",
        key: "id",
        width: 220,
        fixed: "left",
        render: (v: string, r: EntitlementItem) => (
          <Space>
            <Text code copyable style={{ fontSize: 12 }}>
              {v.slice(0, 12)}…
            </Text>
            <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => openDetail(r)}>
              详情
            </Button>
          </Space>
        ),
      },
      {
        title: "用户",
        key: "user",
        width: 220,
        render: (_: unknown, r: EntitlementItem) => (
          <div>
            <div>
              <Text strong>{r.user?.displayName || "-"}</Text>
              {r.user?.username ? <Tag style={{ marginLeft: 4 }}>@{r.user.username}</Tag> : null}
            </div>
            {r.user?.telegramUserId ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                TG: {r.user.telegramUserId}
              </Text>
            ) : null}
          </div>
        ),
      },
      {
        title: "类型 / 资源",
        key: "rtype",
        render: (_: unknown, r: EntitlementItem) => (
          <Space direction="vertical" size={2}>
            <Tag color="geekblue">{RESOURCE_TYPE_LABEL[r.resourceType]}</Tag>
            <Text copyable style={{ fontSize: 12 }} code>
              {r.resourceId}
            </Text>
          </Space>
        ),
      },
      {
        title: "来源订单",
        key: "order",
        width: 180,
        render: (_: unknown, r: EntitlementItem) =>
          r.sourceOrder ? (
            <Space direction="vertical" size={2}>
              <Text code copyable style={{ fontSize: 12 }}>
                {r.sourceOrder.orderNo}
              </Text>
              <Tag color={r.sourceOrder.status === "paid" ? "green" : "default"}>{r.sourceOrder.status}</Tag>
              {r.sourceOrder.amountMinor ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {r.sourceOrder.amountMinor} XTR
                </Text>
              ) : null}
            </Space>
          ) : (
            <Tag>无订单（客服直授 / 补偿）</Tag>
          ),
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 140,
        render: (s: EntitlementStatus) => {
          const m = ENTITLEMENT_STATUS_META[s];
          return (
            <Badge status={m.badge} text={<Tag color={m.color}>{m.label}</Tag>} />
          );
        },
      },
      {
        title: "周期",
        key: "t",
        width: 260,
        render: (_: unknown, r: EntitlementItem) => (
          <div style={{ fontSize: 12 }}>
            <div>
              <Text type="secondary">起：</Text>
              {dayjs(r.startsAt).format("YYYY-MM-DD HH:mm")}
            </div>
            <div>
              <Text type="secondary">止：</Text>
              {r.expiresAt ? dayjs(r.expiresAt).format("YYYY-MM-DD HH:mm") : "永久有效"}
              {r.expiresAt && dayjs(r.expiresAt).isBefore(dayjs()) && r.status === "active" ? (
                <Tag color="orange">逻辑过期待扫</Tag>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        title: "频道邀请",
        key: "inv",
        width: 180,
        render: (_: unknown, r: EntitlementItem) =>
          r.resourceType !== "membership_channel" ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              N/A
            </Text>
          ) : r.channelInvite ? (
            <Space direction="vertical" size={2}>
              {r.channelInvite.inviteLink ? (
                <a href={r.channelInvite.inviteLink} target="_blank" rel="noreferrer">
                  <LinkOutlined /> 打开链接
                </a>
              ) : null}
              {r.channelInvite.expiresAt ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  到期 {dayjs(r.channelInvite.expiresAt).format("MM-DD HH:mm")}
                </Text>
              ) : null}
              {r.channelInvite.usedAt ? (
                <Tag color="green">已使用 {dayjs(r.channelInvite.usedAt).format("MM-DD HH:mm")}</Tag>
              ) : (
                <Tag color="blue">未使用</Tag>
              )}
            </Space>
          ) : (
            <Tag>暂无邀请</Tag>
          ),
      },
      {
        title: "操作",
        key: "act",
        fixed: "right",
        width: 260,
        render: (_: unknown, r: EntitlementItem) => {
          const canResend =
            canResendInvite && r.resourceType === "membership_channel" && r.status === "active";
          return (
            <Space wrap>
              <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(r)}>
                查看
              </Button>
              <Tooltip
                title={
                  !canResendInvite
                    ? `仅客服或超管可补发邀请（当前${me?.role ? ROLE_LABEL[me.role] : "未登录"}）`
                    : !canResend
                    ? "仅 active 状态的会员频道权益可补发邀请"
                    : "为该权益重新生成频道邀请链接，写入审计日志"
                }
              >
                <Button
                  size="small"
                  type="primary"
                  ghost
                  disabled={!canResend}
                  loading={resending && detail?.id === r.id}
                  icon={<SendOutlined />}
                  onClick={() => handleResendInvite(r)}
                >
                  补发邀请
                </Button>
              </Tooltip>
            </Space>
          );
        },
      },
    ],
    [canResendInvite, me?.role, resending, detail?.id],
  );

  const pagination: TablePaginationConfig = {
    current: page, pageSize, total,
    showSizeChanger: true, showQuickJumper: true,
    pageSizeOptions: ["10", "20", "50", "100"],
    showTotal: (t) => `共 ${t} 条权益`,
    onChange: (p, s) => { setPage(p); setPageSize(s); },
  };

  if (!canView) {
    return (
      <Empty
        description={
          <Tag icon={<ExclamationCircleFilled />} color="warning">
            你的账号「{me?.role || "未登录"}」无 entitlement:view 权限。需要客服/运营/财务/审计或超管。
          </Tag>
        }
      />
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={onSearch}
          style={{ rowGap: 8, columnGap: 12, display: "flex", flexWrap: "wrap" }}
        >
          <Form.Item name="status" label="状态">
            <Select allowClear style={{ width: 130 }} placeholder="全部状态">
              {(Object.keys(ENTITLEMENT_STATUS_META) as EntitlementStatus[]).map((s) => (
                <Option key={s} value={s}>{ENTITLEMENT_STATUS_META[s].label}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="resourceType" label="类型">
            <Select allowClear style={{ width: 170 }} placeholder="全部类型">
              {(Object.keys(RESOURCE_TYPE_LABEL) as ResourceType[]).map((s) => (
                <Option key={s} value={s}>{RESOURCE_TYPE_LABEL[s]}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="userId" label="用户ID">
            <Input allowClear placeholder="user_xxx 精确" style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="telegramUserId" label="TG UID">
            <Input allowClear placeholder="1000000001" style={{ width: 150 }} />
          </Form.Item>
          <Form.Item name="orderNo" label="订单号">
            <Input allowClear prefix={<SearchOutlined />} placeholder="INT..." style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="resourceId" label="资源ID">
            <Input allowClear placeholder="内容/包 ID" style={{ width: 170 }} />
          </Form.Item>
          <Form.Item>
            <Space wrap>
              <Button type="primary" icon={<SearchOutlined />} htmlType="submit">搜索</Button>
              <Button icon={<ReloadOutlined />} onClick={onReset}>重置</Button>
              {canGrant ? (
                <Tooltip title="客服/超管：直接为指定用户发放权益（补偿、赠送等），写入审计日志">
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setGrantModalOpen(true)}>
                    发放权益
                  </Button>
                </Tooltip>
              ) : null}
            </Space>
          </Form.Item>
        </Form>
      </div>

      <Table<EntitlementItem>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={pagination}
        scroll={{ x: 1600 }}
        locale={{ emptyText: <Empty description="暂无权益数据。让用户在 Mini App 完成支付或使用「发放权益」直接补偿。" /> }}
      />

      <Drawer
        title={<Title level={4} style={{ margin: 0 }}>权益详情 {detail?.id ? `「${detail.id.slice(0, 12)}…」` : ""}</Title>}
        placement="right" width={680}
        onClose={() => setDetailOpen(false)} open={detailOpen}
        destroyOnClose
        extra={
          detail ? (
            <Space>
              {canResendInvite && detail.resourceType === "membership_channel" && detail.status === "active" ? (
                <Button
                  size="small"
                  type="primary"
                  icon={<SendOutlined />}
                  loading={resending}
                  onClick={() => handleResendInvite(detail)}
                >
                  补发邀请
                </Button>
              ) : null}
            </Space>
          ) : null
        }
      >
        {detailLoading ? <div style={{ textAlign: "center", padding: 40 }}><Empty description="加载中..." /></div> :
         !detail ? <Empty description="暂无权益详情" /> : (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Descriptions bordered column={1} size="small" title={<Space><SafetyCertificateOutlined />权益快照</Space>}>
              <Descriptions.Item label="权益 ID">
                <Text copyable code>{detail.id}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="用户">
                {detail.user?.displayName || "未知"}
                {detail.user?.username ? <Tag style={{ marginLeft: 6 }}>@{detail.user.username}</Tag> : null}
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {detail.user?.telegramUserId ? `TG UID: ${detail.user.telegramUserId}` : "无 Telegram 绑定"}
                  </Text>
                </div>
              </Descriptions.Item>
              <Descriptions.Item label="类型">
                <Tag color="geekblue">{RESOURCE_TYPE_LABEL[detail.resourceType]}</Tag>
                <Text code copyable style={{ marginLeft: 8, fontSize: 12 }}>
                  {detail.resourceId}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={ENTITLEMENT_STATUS_META[detail.status].color}>
                  {ENTITLEMENT_STATUS_META[detail.status].label}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="生效时间">
                <div>开始 {dayjs(detail.startsAt).format("YYYY-MM-DD HH:mm:ss")}</div>
                <div>到期 {detail.expiresAt ? dayjs(detail.expiresAt).format("YYYY-MM-DD HH:mm:ss") : "永久"}</div>
              </Descriptions.Item>
              <Descriptions.Item label="创建 / 更新">
                <div>创建 {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm:ss")}</div>
                <div>更新 {dayjs(detail.updatedAt).format("YYYY-MM-DD HH:mm:ss")}</div>
              </Descriptions.Item>
              <Descriptions.Item label="来源订单">
                {detail.sourceOrder ? (
                  <Space direction="vertical" size={2}>
                    <Text code copyable>{detail.sourceOrder.orderNo}</Text>
                    <Tag>{detail.sourceOrder.status}</Tag>
                    {detail.sourceOrder.amountMinor ? (
                      <Text type="secondary">{detail.sourceOrder.amountMinor} XTR ({detail.sourceOrder.currency || "未知币种"})</Text>
                    ) : null}
                  </Space>
                ) : <Tag>无订单（客服直授 / 补偿 / 邀请赠送等）</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="最新频道邀请">
                {detail.channelInvite ? (
                  <Space direction="vertical" size={2}>
                    {detail.channelInvite.inviteLink ? (
                      <a href={detail.channelInvite.inviteLink} target="_blank" rel="noreferrer">
                        <LinkOutlined /> 打开邀请链接
                      </a>
                    ) : null}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      到期：{detail.channelInvite.expiresAt ? dayjs(detail.channelInvite.expiresAt).format("YYYY-MM-DD HH:mm") : "不限时"}
                      {detail.channelInvite.usedAt ? `；已使用 ${dayjs(detail.channelInvite.usedAt).format("YYYY-MM-DD HH:mm")}` : "；未使用"}
                    </Text>
                  </Space>
                ) : detail.resourceType === "membership_channel" ? (
                  <Tag>尚未生成任何邀请（点「补发邀请」立即生成）</Tag>
                ) : <Text type="secondary">非会员频道权益不生成邀请</Text>}
              </Descriptions.Item>
            </Descriptions>
          </Space>
        )}
      </Drawer>

      <Modal
        title={<Space><PlusOutlined /><b>直接发放权益（客服 / 超管）</b></Space>}
        open={grantModalOpen}
        onCancel={() => { setGrantModalOpen(false); grantForm.resetFields(); }}
        onOk={doGrant}
        okText="确认发放权益"
        okButtonProps={{ danger: false, type: "primary" }}
        cancelText="取消"
        confirmLoading={grantSubmitting}
        destroyOnClose
        width={620}
      >
        <Form form={grantForm} layout="vertical">
          <Form.Item
            label={<Space><SafetyCertificateOutlined /><b>选择用户（按姓名/用户名/TG ID 搜索，必填）</b></Space>}
            name="selectedUserId"
            rules={[{ required: true, message: "请搜索并选择要发放的用户" }]}
          >
            <Select
              showSearch
              filterOption={false}
              placeholder="搜索用户：用户名 / 显示名 / TG UID"
              style={{ width: "100%" }}
              onSearch={handleUserSearch}
              loading={userSearchLoading}
              notFoundContent={userSearchLoading ? <span>搜索中…</span> : <span>请输入关键词搜索</span>}
              options={userSearchOptions}
            />
          </Form.Item>
          <Form.Item
            label={<b>权益类型</b>}
            name="resourceType"
            initialValue="membership_channel"
            rules={[{ required: true, message: "请选择权益类型" }]}
          >
            <Select>
              <Option value="membership_channel">会员频道 (membership_channel · membership-main)</Option>
              <Option value="content">单条内容（需提供具体 Content ID）</Option>
              <Option value="package">内容包（需提供具体 ContentPackage ID）</Option>
            </Select>
          </Form.Item>
          <Form.Item noStyle dependencies={["resourceType"]}>
            {({ getFieldValue }) => {
              const rt = getFieldValue("resourceType") as ResourceType;
              let placeholder = "请输入资源 ID";
              let help: React.ReactNode = null;
              if (rt === "membership_channel") {
                placeholder = "membership-main（或具体产品 ID）";
                help = "主会员频道固定填 membership-main；如果有其它 membership 产品，填 Product ID。";
              } else if (rt === "content") {
                placeholder = "content_xxx";
                help = "填入内容管理页中的具体内容 ID；该内容会对用户立即解锁。";
              } else if (rt === "package") {
                placeholder = "pkg_xxx";
                help = "填入内容包 ID；包内所有内容会立即解锁。";
              }
              return (
                <Form.Item
                  label={<b>资源 ID</b>}
                  name="resourceId"
                  initialValue={rt === "membership_channel" ? "membership-main" : ""}
                  rules={[
                    { required: true, message: "请输入资源 ID" },
                    { min: 1, message: "至少 1 个字符" },
                    { max: 120, message: "最长 120 字符" },
                  ]}
                  extra={help}
                >
                  <Input placeholder={placeholder} />
                </Form.Item>
              );
            }}
          </Form.Item>
          <Form.Item
            label="有效期天数（留空=永久）"
            name="durationDays"
            extra="会员权益强烈建议填 30 / 90 / 365。单条内容一般留空（永久）。"
          >
            <Input type="number" min={1} max={3650} placeholder="例：30" />
          </Form.Item>
          <Divider style={{ margin: "8px 0" }} />
          <Form.Item
            label={<Space><ExclamationCircleFilled style={{ color: "#faad14" }} /><b>发放说明（必填，写入审计日志，永久保留）</b></Space>}
            name="reason"
            rules={[
              { required: true, message: "请填写发放说明，让审计能解释为什么无订单直接发放权益" },
              { min: 2, message: "至少 2 个字符" },
              { max: 1000, message: "最长 1000 字符" },
            ]}
          >
            <Input.TextArea rows={3} autoFocus maxLength={1000} showCount
              placeholder="例如：补偿会员工单 TKTxxxx，用户误操作后协商赠送 30 天；或：渠道合作/KOL 合作发放；或：春节抽奖中奖 1 年会员" />
          </Form.Item>
          <Form.Item noStyle dependencies={["resourceType"]}>
            {({ getFieldValue }) => {
              const rt = getFieldValue("resourceType");
              if (rt !== "membership_channel") return null;
              return (
                <div style={{ padding: 12, background: "#f6ffed", border: "1px solid #b7eb8f", borderRadius: 6, fontSize: 12 }}>
                  <Text type="success">
                    <b>📢 发放后行为：</b>DB 事务写入权益 + 审计 → 如果该用户有 Telegram UID，会立即向 <u>主会员频道</u> 创建 1 人/24h 临时邀请链接并返回。
                    Bot API 失败不影响 DB（不回滚），会在响应里标注 telegramInvite.error，可手动在详情页再次「补发邀请」。
                  </Text>
                </div>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default EntitlementsPage;
