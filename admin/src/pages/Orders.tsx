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
  List,
  Timeline,
} from "antd";
import {
  SearchOutlined,
  EyeOutlined,
  CheckCircleOutlined,
  DollarOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
  FileTextOutlined,
  ExclamationCircleFilled,
} from "@ant-design/icons";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import dayjs from "dayjs";
import {
  listAdminOrders,
  getAdminOrder,
  adminMarkOrderPaid,
  getAdminOrderAuditLogs,
  adminCancelOrder,
  adminRefundOrder,
  adminResendEntitlementInvite,
} from "../api/client";
import type {
  OrderItem,
  OrderStatus,
  Entitlement,
  ProductType,
  ResourceType,
  AdminAuditLog,
  AdminRole,
  EntitlementItem,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";

const { Text, Title } = Typography;
const { Option } = Select;

const ORDER_STATUS_META: Record<OrderStatus, { label: string; color: string }> = {
  pending: { label: "待支付", color: "orange" },
  processing: { label: "处理中", color: "blue" },
  paid: { label: "已支付", color: "green" },
  failed: { label: "失败", color: "red" },
  refunded: { label: "已退款", color: "purple" },
  cancelled: { label: "已取消", color: "default" },
  expired: { label: "已过期", color: "default" },
};

const ROLE_LABEL: Record<AdminRole, string> = {
  super_admin: "超级管理员",
  operator: "运营",
  editor: "内容编审",
  customer_service: "客服",
  finance: "财务",
  auditor: "审计",
};

const MARK_PAID_ROLES: AdminRole[] = ["super_admin", "operator", "finance"];
const CANCEL_ROLES: AdminRole[] = ["super_admin", "operator"];
const REFUND_ROLES: AdminRole[] = ["super_admin", "finance"];
const RESEND_INVITE_ROLES: AdminRole[] = ["super_admin", "customer_service"];

function normalizeXtrMinor(value: string | number | null | undefined): bigint {
  const raw = BigInt(String(value ?? "0"));
  if (raw > 0n && raw >= 1_000_000n && raw % 1_000_000n === 0n) return raw / 1_000_000n;
  return raw;
}

function formatAmountDisplay(value: string | null | undefined, currency?: string | null): string {
  const code = String(currency || "").toUpperCase();
  if (!value) return "—";
  if (code === "XTR") return `${normalizeXtrMinor(value).toString()} Stars`;
  if (code === "USDT") return `${(Number(value) / 1_000_000).toFixed(6).replace(/\.?0+$/, "")} USDT`;
  return `${value} ${currency || ""}`.trim();
}

const CANCELLABLE_STATUSES: OrderStatus[] = ["pending", "processing", "expired", "failed"];
const REFUNDABLE_STATUSES: OrderStatus[] = ["paid"];

const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  single: "单条内容",
  package: "内容包",
  membership: "会员",
};

const RESOURCE_TYPE_LABEL: Record<ResourceType, string> = {
  content: "单条内容权益",
  package: "内容包权益",
  membership_channel: "会员频道权益",
};

const ACTION_LABEL: Record<string, string> = {
  "admin.order.mark_paid": "人工补单 · 标记已支付",
  "admin.order.cancel": "客服/运营 · 取消订单",
  "admin.order.refund": "财务 · 订单退款",
  "admin.auth.login": "管理员登录",
};

const PAYABLE_STATUSES: OrderStatus[] = ["pending", "processing"];

const OrdersPage: React.FC = () => {
  const { me } = useAuth();
  const canMarkPaid = !!me && MARK_PAID_ROLES.includes(me.role);
  const canCancel = !!me && CANCEL_ROLES.includes(me.role);
  const canRefund = !!me && REFUND_ROLES.includes(me.role);
  const canResendInvite = !!me && RESEND_INVITE_ROLES.includes(me.role);

  const [form] = Form.useForm<{
    status?: OrderStatus;
    orderNo?: string;
    telegramUserId?: string;
  }>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<OrderItem[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<OrderItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null);
  const [markPaidModal, setMarkPaidModal] = useState<{ open: boolean; order: OrderItem | null }>({
    open: false,
    order: null,
  });
  const [cancelModal, setCancelModal] = useState<{ open: boolean; order: OrderItem | null }>({
    open: false,
    order: null,
  });
  const [refundModal, setRefundModal] = useState<{ open: boolean; order: OrderItem | null }>({
    open: false,
    order: null,
  });
  const [markForm] = Form.useForm<{ reason: string }>();
  const [cancelForm] = Form.useForm<{ reason: string }>();
  const [refundForm] = Form.useForm<{ reason: string }>();

  const fetchData = useCallback(async () => {
    const values = form.getFieldsValue();
    setLoading(true);
    try {
      const res = await listAdminOrders({
        page,
        pageSize,
        status: values.status,
        orderNo: values.orderNo?.trim() || undefined,
        telegramUserId: values.telegramUserId?.trim() || undefined,
      });
      setRows(res.items);
      setTotal(res.pagination.total);
    } catch (e: any) {
      antdMsg.error("订单列表加载失败：" + (e?.response?.data?.message || e.message || "未知错误"));
    } finally {
      setLoading(false);
    }
  }, [form, page, pageSize]);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  const onSearch = () => {
    setPage(1);
    setTimeout(fetchData, 0);
  };

  const onReset = () => {
    form.resetFields();
    setPage(1);
    setTimeout(fetchData, 0);
  };

  const fetchAudit = useCallback(async (orderNo: string) => {
    setAuditLoading(true);
    try {
      const res = await getAdminOrderAuditLogs(orderNo);
      setAuditLogs(res.items);
    } catch (e: any) {
      antdMsg.error("审计记录加载失败：" + (e?.response?.data?.message || e.message));
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const openDetail = async (o: OrderItem) => {
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const latest = await getAdminOrder(o.orderNo);
      setDetail(latest);
    } catch (e: any) {
      antdMsg.error("订单详情加载失败：" + (e?.response?.data?.message || e.message));
    } finally {
      setDetailLoading(false);
    }
    fetchAudit(o.orderNo);
  };

  const triggerMarkPaid = (o: OrderItem) => {
    if (!canMarkPaid) return;
    markForm.resetFields();
    setMarkPaidModal({ open: true, order: o });
  };

  const triggerCancel = (o: OrderItem) => {
    if (!canCancel) return;
    if (!CANCELLABLE_STATUSES.includes(o.status)) return;
    cancelForm.resetFields();
    setCancelModal({ open: true, order: o });
  };

  const triggerRefund = (o: OrderItem) => {
    if (!canRefund) return;
    if (!REFUNDABLE_STATUSES.includes(o.status)) return;
    refundForm.resetFields();
    setRefundModal({ open: true, order: o });
  };

  const doCancel = async () => {
    const values = await cancelForm.validateFields();
    const order = cancelModal.order;
    if (!order) return;
    setCancelling(true);
    try {
      const r = await adminCancelOrder(order.orderNo, values.reason);
      if (r.idempotent) {
        antdMsg.info(`订单 ${order.orderNo} 之前已取消（idempotent=true）`);
      } else {
        antdMsg.success(`订单已取消：${order.orderNo}。审计记录已写入。`);
      }
      setCancelModal({ open: false, order: null });
      setDetailOpen(false);
      setDetail(null);
      await fetchData();
    } catch (e: any) {
      handleGenericOrderApiError(e, "取消订单失败");
    } finally {
      setCancelling(false);
    }
  };

  const doRefund = async () => {
    const values = await refundForm.validateFields();
    const order = refundModal.order;
    if (!order) return;
    setRefunding(true);
    try {
      const r = await adminRefundOrder(order.orderNo, values.reason);
      if (r.idempotent) {
        antdMsg.info(
          `订单 ${order.orderNo} 之前已退款（idempotent=true）。撤销 ${r.revokedEntitlements.length} 条权益。`,
        );
      } else {
        const msgs: string[] = [`退款成功：已撤销 ${r.revokedEntitlements.length} 条权益。`];
        if (r.channelKicks.length > 0) {
          const okC = r.channelKicks.filter((k) => k.success).length;
          msgs.push(`频道踢人成功 ${okC}/${r.channelKicks.length}。`);
        }
        if (!r.userNotified) msgs.push(`用户通知失败：${r.notifyError || "未知"}`);
        antdMsg.success(msgs.join(" "));
      }
      setRefundModal({ open: false, order: null });
      setDetailOpen(false);
      setDetail(null);
      await fetchData();
    } catch (e: any) {
      handleGenericOrderApiError(e, "退款失败");
    } finally {
      setRefunding(false);
    }
  };

  const handleGenericOrderApiError = (e: any, fallbackTitle: string) => {
    const status = e?.response?.status;
    const body = e?.response?.data;
    if (status === 400) {
      antdMsg.error(
        "参数错误：" +
          (body?.message ||
            (body?.details && Array.isArray(body.details)
              ? body.details.map((d: any) => d.message).join("；")
              : "") ||
            "请检查必填项"),
      );
    } else if (status === 409) {
      antdMsg.error(body?.message || "当前订单状态不允许该操作");
    } else if (status === 404) {
      antdMsg.error("订单不存在");
    } else if (status === 403) {
      antdMsg.error("当前账号没有执行该操作的权限");
    } else {
      antdMsg.error(fallbackTitle + "：" + (body?.message || body?.error || e.message));
    }
  };

  const doResendInviteInline = async (e: Entitlement | EntitlementItem) => {
    if (!canResendInvite) return;
    if (e.resourceType !== "membership_channel" || e.status !== "active") {
      antdMsg.warning("仅 active 状态的会员频道权益可补发邀请");
      return;
    }
    setResendingInviteId(e.id);
    try {
      const r = await adminResendEntitlementInvite(e.id, "订单详情 · 行内补发邀请（客服操作）");
      antdMsg.success(
        r.invite?.expiresAt
          ? `已重新生成私密邀请，并通过受控渠道发送（到期 ${dayjs(r.invite.expiresAt).format("MM-DD HH:mm")}）`
          : "已重新生成私密邀请，并通过受控渠道发送",
      );
      if (detail && detail.orderNo) {
        const latest = await getAdminOrder(detail.orderNo);
        setDetail(latest);
      }
    } catch (e: any) {
      handleGenericOrderApiError(e, "补发邀请失败");
    } finally {
      setResendingInviteId(null);
    }
  };

  const doMarkPaid = async () => {
    const values = await markForm.validateFields();
    if (!markPaidModal.order) return;
    const order = markPaidModal.order;
    setMarkingPaid(true);
    try {
      const res = await adminMarkOrderPaid(order.orderNo, values.reason);
      if (res.idempotent) {
        antdMsg.success(
          `已跳过重复补单（idempotent=true）。订单 ${order.orderNo} 之前已经支付并发放权益。`,
        );
      } else {
        antdMsg.success(
          `补单成功：已生成 ${res.entitlements.length} 条权益（${res.entitlements
            .map((e) => RESOURCE_TYPE_LABEL[e.resourceType])
            .join("、")}）。审计记录已写入。`,
        );
      }
      setMarkPaidModal({ open: false, order: null });
      setDetailOpen(false);
      setDetail(null);
      await fetchData();
    } catch (e: any) {
      const status = e?.response?.status;
      const body = e?.response?.data;
      if (status === 400) {
        antdMsg.error(
          "参数错误：" +
            (body?.message ||
              (body?.details && Array.isArray(body.details)
                ? body.details.map((d: any) => d.message).join("；")
                : "") ||
              "请检查必填项"),
        );
      } else if (status === 409) {
        antdMsg.error("无法补单：" + (body?.message || "订单当前状态不允许改为支付"));
      } else if (status === 404) {
        antdMsg.error("订单不存在（可能已被删除）");
      } else if (status === 403) {
        antdMsg.error("当前账号没有 order:mark_paid 权限，无法执行人工补单");
      } else {
        antdMsg.error("补单失败：" + (body?.message || body?.error || e.message));
      }
    } finally {
      setMarkingPaid(false);
    }
  };

  const columns = useMemo<ColumnsType<OrderItem>>(
    () => [
      {
        title: "订单号",
        dataIndex: "orderNo",
        key: "orderNo",
        width: 200,
        fixed: "left",
        render: (v: string, r) => (
          <Space>
            <Text code copyable={{ text: v }}>
              {v}
            </Text>
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => openDetail(r)}>
              详情
            </Button>
          </Space>
        ),
      },
      {
        title: "用户",
        dataIndex: "user",
        key: "user",
        width: 200,
        render: (_: any, r) => (
          <div>
            <div>
              <Text strong>{r.user?.displayName || "未知用户"}</Text>
              {r.user?.username ? (
                <Tag style={{ marginLeft: 6 }}>@{r.user.username}</Tag>
              ) : null}
            </div>
            {r.user?.telegramUserIdMasked ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                TG ID: {r.user.telegramUserIdMasked}
              </Text>
            ) : null}
          </div>
        ),
      },
      {
        title: "商品",
        dataIndex: "product",
        key: "product",
        render: (_: any, r) => (
          <div>
            <div>{r.product?.title || "-"}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {r.product?.type ? PRODUCT_TYPE_LABEL[r.product.type] : ""}
              {r.product?.durationDays ? ` · ${r.product.durationDays} 天` : ""}
            </Text>
          </div>
        ),
      },
      {
        title: "金额",
        dataIndex: "amountMinor",
        key: "amount",
        width: 150,
        align: "right",
        sorter: (a, b) => Number(a.amountMinor) - Number(b.amountMinor),
        render: (v: string, r) => (
          <div>
            <div style={{ fontWeight: 600 }}>{formatAmountDisplay(v, r.currency)}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              原始值：{v}
            </Text>
            {r.currency ? (
              <div>
                <Tag style={{ marginTop: 4 }}>{r.currency}</Tag>
              </div>
            ) : null}
          </div>
        ),
      },
      {
        title: "状态",
        dataIndex: "status",
        key: "status",
        width: 140,
        render: (s: OrderStatus, r) => {
          const meta = ORDER_STATUS_META[s];
          const pendingPaid = PAYABLE_STATUSES.includes(s);
          return (
            <Badge
              status={
                s === "paid"
                  ? "success"
                  : s === "failed" || s === "cancelled" || s === "expired" || s === "refunded"
                  ? "default"
                  : "processing"
              }
              text={
                <Space>
                  <Tag color={meta.color}>{meta.label}</Tag>
                  {pendingPaid && r.entitlements.length === 0 ? (
                    <Tooltip title={canMarkPaid ? "待人工补单" : "待运营或财务人工补单"}>
                      <Tag icon={<DollarOutlined />} color="orange">
                        待补单
                      </Tag>
                    </Tooltip>
                  ) : null}
                </Space>
              }
            />
          );
        },
      },
      {
        title: "支付 / 创建时间",
        key: "time",
        width: 200,
        render: (_: any, r) => (
          <div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                创建：
              </Text>
              {dayjs(r.createdAt).format("YYYY-MM-DD HH:mm")}
            </div>
            {r.paidAt ? (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  到账：
                </Text>
                {dayjs(r.paidAt).format("YYYY-MM-DD HH:mm")}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        title: "操作",
        key: "act",
        width: 500,
        fixed: "right",
        render: (_: any, r) => {
          const payable = PAYABLE_STATUSES.includes(r.status);
          const showBtn = canMarkPaid && payable;
          const cancelable = canCancel && CANCELLABLE_STATUSES.includes(r.status);
          const refundable = canRefund && REFUNDABLE_STATUSES.includes(r.status);
          return (
            <Space wrap>
              <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(r)}>
                查看
              </Button>
              <Tooltip
                title={
                  !canMarkPaid
                    ? `你的角色「${me?.role ? ROLE_LABEL[me.role] : "未知"}」无补单权限；需要运营、财务或超管`
                    : !payable
                    ? `当前状态「${ORDER_STATUS_META[r.status].label}」不可人工补单`
                    : "已真实收到款项 → 标记已支付（生成权益并写入审计，不可撤销）"
                }
              >
                <Button
                  size="small"
                  type="primary"
                  ghost={!!showBtn}
                  danger={false}
                  disabled={!showBtn || markingPaid}
                  icon={<CheckCircleOutlined />}
                  onClick={() => triggerMarkPaid(r)}
                >
                  {canMarkPaid ? "人工标记已支付" : "无补单权限"}
                </Button>
              </Tooltip>
              <Tooltip
                title={
                  !canCancel
                    ? `仅运营或超管可取消订单（角色：${me?.role ? ROLE_LABEL[me.role] : "未知"}）`
                    : !cancelable
                    ? `当前状态「${ORDER_STATUS_META[r.status].label}」不可取消；仅 pending/processing/expired/failed`
                    : "取消订单（未支付）→ 标记 cancelled，写入审计日志"
                }
              >
                <Button
                  size="small"
                  disabled={!cancelable || cancelling}
                  loading={cancelling && cancelModal.order?.orderNo === r.orderNo}
                  onClick={() => triggerCancel(r)}
                >
                  取消订单
                </Button>
              </Tooltip>
              <Tooltip
                title={
                  !canRefund
                    ? `仅财务或超管可退款（角色：${me?.role ? ROLE_LABEL[me.role] : "未知"}）`
                    : !refundable
                    ? `当前状态「${ORDER_STATUS_META[r.status].label}」不可退款；仅 paid`
                    : "退款（已支付）→ 撤销全部权益 + 频道踢人 + 发送退款通知 + 审计"
                }
              >
                <Button
                  size="small"
                  danger
                  type={refundable ? "primary" : "default"}
                  disabled={!refundable || refunding}
                  loading={refunding && refundModal.order?.orderNo === r.orderNo}
                  onClick={() => triggerRefund(r)}
                >
                  退款 + 撤销权益
                </Button>
              </Tooltip>
            </Space>
          );
        },
      },
    ],
    [canMarkPaid, canCancel, canRefund, me?.role, markingPaid, cancelling, refunding, cancelModal, refundModal],
  );

  const pagination: TablePaginationConfig = {
    current: page,
    pageSize,
    total,
    showSizeChanger: true,
    showQuickJumper: true,
    pageSizeOptions: ["10", "20", "50", "100"],
    showTotal: (t) => `共 ${t} 条订单`,
    onChange: (p, s) => {
      setPage(p);
      setPageSize(s);
    },
  };

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={onSearch}
          style={{ rowGap: 8, columnGap: 12, display: "flex", flexWrap: "wrap" }}
        >
          <Form.Item name="orderNo" label="订单号">
            <Input allowClear placeholder="INT..." prefix={<SearchOutlined />} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item name="telegramUserId" label="Telegram UID">
            <Input allowClear placeholder="如 1000000001" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select allowClear placeholder="全部状态" style={{ width: 150 }}>
              {(Object.keys(ORDER_STATUS_META) as OrderStatus[]).map((s) => (
                <Option key={s} value={s}>
                  {ORDER_STATUS_META[s].label}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" icon={<SearchOutlined />} htmlType="submit">
                搜索
              </Button>
              <Button icon={<ReloadOutlined />} onClick={onReset}>
                重置
              </Button>
              {!canMarkPaid ? (
                <Tag icon={<SafetyCertificateOutlined />} color="default">
                  仅{MARK_PAID_ROLES.map((r) => ROLE_LABEL[r]).join("/")}可补单，当前：
                  {me?.role ? ROLE_LABEL[me.role] : "未登录"}
                </Tag>
              ) : null}
            </Space>
          </Form.Item>
        </Form>
      </div>

      <Table<OrderItem>
        rowKey="orderNo"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={pagination}
        scroll={{ x: 1400 }}
        locale={{ emptyText: <Empty description="暂无订单，先让用户在 Mini App 里创建订单" /> }}
      />

      <Modal
        title={
          <Space>
            <CheckCircleOutlined style={{ color: "#52c41a" }} />
            人工补单确认 · 到账后不可撤销
          </Space>
        }
        open={markPaidModal.open}
        onCancel={() => setMarkPaidModal({ open: false, order: null })}
        onOk={doMarkPaid}
        okText="确认到账并补单"
        cancelText="取消"
        okButtonProps={{ danger: true, type: "primary" }}
        confirmLoading={markingPaid}
        destroyOnClose
        width={560}
      >
        {markPaidModal.order ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="订单号">
                <Text code copyable>
                  {markPaidModal.order.orderNo}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="用户">
                {markPaidModal.order.user?.displayName || "未知用户"}
                {markPaidModal.order.user?.telegramUserIdMasked
                  ? `（TG ID: ${markPaidModal.order.user.telegramUserIdMasked}）`
                  : ""}
              </Descriptions.Item>
              <Descriptions.Item label="商品">
                {markPaidModal.order.product?.title || "-"}（
                {markPaidModal.order.product?.type
                  ? PRODUCT_TYPE_LABEL[markPaidModal.order.product.type]
                  : "-"}
                ）
              </Descriptions.Item>
              <Descriptions.Item label="金额">
                <b>{formatAmountDisplay(markPaidModal.order.amountMinor, markPaidModal.order.currency)}</b>{" "}
                <Text type="secondary">（{markPaidModal.order.currency}）</Text>
              </Descriptions.Item>
              <Descriptions.Item label="当前状态">
                <Tag color={ORDER_STATUS_META[markPaidModal.order.status].color}>
                  {ORDER_STATUS_META[markPaidModal.order.status].label}
                </Tag>
              </Descriptions.Item>
            </Descriptions>

            <Form form={markForm} layout="vertical">
              <Form.Item
                label={
                  <Space>
                    <FileTextOutlined />
                    <b>到账说明（必填，至少 2 字，写入审计日志）</b>
                  </Space>
                }
                name="reason"
                rules={[
                  { required: true, message: "请填写到账说明，例：微信转账 ¥29.9 已收" },
                  { min: 2, message: "至少 2 个字符" },
                  { max: 1000, message: "最长 1000 个字符" },
                ]}
              >
                <Input.TextArea
                  rows={4}
                  autoFocus
                  maxLength={1000}
                  showCount
                  placeholder="例如：微信转账 ¥29.9 已收；附言 INT...；时间 2026-08-06 21:30；收款人：XXX"
                />
              </Form.Item>
            </Form>

            <div style={{ padding: 12, background: "#fffbe6", borderRadius: 6, border: "1px solid #ffe58f" }}>
              <Text type="warning" style={{ fontSize: 12 }}>
                ⚠️ 财务红线：请确认款项已经真实到账后再点击「确认到账并补单」。
                <br />
                本操作将：① 把订单状态改为已支付；② 自动生成对应权益（单条 / 内容包 / 会员频道），用户立即在 Mini App 看到已解锁；
            重复调用具备幂等保护（idempotent=true），不会二次发放权益。
              </Text>
            </div>
          </Space>
        ) : null}
      </Modal>

      <Modal
        title={
          <Space>
            <ExclamationCircleFilled style={{ color: "#faad14" }} />
            取消订单确认
          </Space>
        }
        open={cancelModal.open}
        onCancel={() => setCancelModal({ open: false, order: null })}
        onOk={doCancel}
        okText="确认取消订单"
        cancelText="返回"
        okButtonProps={{ danger: false }}
        confirmLoading={cancelling}
        destroyOnClose
        width={560}
      >
        {cancelModal.order ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="订单号">
                <Text code copyable>
                  {cancelModal.order.orderNo}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="用户">
                {cancelModal.order.user?.displayName || "未知用户"}
                {cancelModal.order.user?.telegramUserIdMasked
                  ? `（TG ID: ${cancelModal.order.user.telegramUserIdMasked}）`
                  : ""}
              </Descriptions.Item>
              <Descriptions.Item label="当前状态">
                <Tag color={ORDER_STATUS_META[cancelModal.order.status].color}>
                  {ORDER_STATUS_META[cancelModal.order.status].label}
                </Tag>
                → 取消后：
                <Tag color="default">cancelled 已取消</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="权益影响">
                {cancelModal.order.entitlements.length === 0
                  ? "该订单尚未发放权益，取消仅更新状态并写入审计，不会触发权益回收。"
                  : `该订单已有 ${cancelModal.order.entitlements.length} 条权益。注意：取消通常只用于未支付订单，已支付订单请使用「退款」操作（退款会回收权益）。`}
              </Descriptions.Item>
            </Descriptions>
            <Form form={cancelForm} layout="vertical">
              <Form.Item
                label={<Space><FileTextOutlined /><b>取消说明（必填，写入审计日志）</b></Space>}
                name="reason"
                rules={[
                  { required: true, message: "请填写取消说明，例：用户未在时限内完成支付，超时主动关闭" },
                  { min: 2, message: "至少 2 个字符" },
                  { max: 1000, message: "最长 1000 字符" },
                ]}
              >
                <Input.TextArea rows={3} autoFocus maxLength={1000} showCount
                  placeholder="例如：用户未在 30 分钟时限内完成支付，运营主动关闭；或该订单为测试/误下单；等" />
              </Form.Item>
            </Form>
          </Space>
        ) : null}
      </Modal>

      <Modal
        title={
          <Space>
            <ExclamationCircleFilled style={{ color: "#f5222d" }} />
            退款确认 · 会撤销权益并踢出频道（强副作用）
          </Space>
        }
        open={refundModal.open}
        onCancel={() => setRefundModal({ open: false, order: null })}
        onOk={doRefund}
        okText="确认执行退款"
        cancelText="返回"
        okButtonProps={{ danger: true, type: "primary" }}
        confirmLoading={refunding}
        destroyOnClose
        width={640}
      >
        {refundModal.order ? (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="订单号">
                <Text code copyable>
                  {refundModal.order.orderNo}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="用户">
                {refundModal.order.user?.displayName || "未知用户"}
                {refundModal.order.user?.telegramUserIdMasked
                  ? `（TG ID: ${refundModal.order.user.telegramUserIdMasked}）`
                  : ""}
              </Descriptions.Item>
              <Descriptions.Item label="商品 / 金额">
                {refundModal.order.product?.title || "-"} ·{" "}
                <b>{formatAmountDisplay(refundModal.order.amountMinor, refundModal.order.currency)}</b>（{refundModal.order.currency}）
              </Descriptions.Item>
              <Descriptions.Item label="当前状态">
                <Tag color={ORDER_STATUS_META[refundModal.order.status].color}>
                  {ORDER_STATUS_META[refundModal.order.status].label}
                </Tag>
                → 退款后：
                <Tag color="purple">refunded 已退款</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="将撤销的权益">
                <Space wrap>
                  {refundModal.order.entitlements.length === 0
                    ? "（当前 0 条活跃权益）"
                    : refundModal.order.entitlements.map((e) => (
                        <Tag key={e.id} color={e.status === "active" ? "red" : "default"}>
                          {RESOURCE_TYPE_LABEL[e.resourceType as ResourceType]} · {e.status}
                          {e.status === "active" ? " → revoked" : ""}
                        </Tag>
                      ))}
                </Space>
              </Descriptions.Item>
            </Descriptions>
            <Form form={refundForm} layout="vertical">
              <Form.Item
                label={<Space><FileTextOutlined /><b>退款说明（必填，写入审计日志）</b></Space>}
                name="reason"
                rules={[
                  { required: true, message: "请填写退款说明，例：用户协商后全额退款；客服工单编号 TKTXXXX" },
                  { min: 2, message: "至少 2 个字符" },
                  { max: 1000, message: "最长 1000 字符" },
                ]}
              >
                <Input.TextArea rows={3} autoFocus maxLength={1000} showCount
                  placeholder="例如：用户与客服 TKTxxxx 协商后退款；用户误操作且未开始使用内容；付费频道链接无法使用 1 小时以上" />
              </Form.Item>
            </Form>
            <div style={{ padding: 12, background: "#fff1f0", borderRadius: 6, border: "1px solid #ffa39e" }}>
              <Text type="danger" style={{ fontSize: 12 }}>
                <b>⚠️ 强副作用说明：</b>
                <br />① DB 事务：把该订单下所有 active 权益 → revoked；订单状态 → refunded；写入审计快照（before/after）。
                <br />② 外部副作用（事务后，失败会记入响应但不回滚 DB）：
                对 <u>会员频道权益</u>，尝试把用户踢出收费频道（kickChannelMember），并通过 Bot 私聊发送退款通知。
                外部 API 失败不会撤销 DB 结果，运营请基于响应中的 channelKicks / notifyError 手动补偿。
              </Text>
            </div>
          </Space>
        ) : null}
      </Modal>

      <Drawer
        title={
          <Title level={4} style={{ margin: 0 }}>
            订单详情 {detail?.orderNo ? `「${detail.orderNo}」` : ""}
          </Title>
        }
        placement="right"
        width={720}
        onClose={() => setDetailOpen(false)}
        open={detailOpen}
        destroyOnClose
        extra={
          detail ? (
            <Space wrap>
              <Button size="small" onClick={() => fetchAudit(detail.orderNo)} icon={<ReloadOutlined />}>
                刷新审计
              </Button>
              {canMarkPaid && PAYABLE_STATUSES.includes(detail.status) ? (
                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  loading={markingPaid}
                  onClick={() => triggerMarkPaid(detail)}
                >
                  人工标记已支付
                </Button>
              ) : null}
              {canCancel && CANCELLABLE_STATUSES.includes(detail.status) ? (
                <Button
                  size="small"
                  disabled={cancelling}
                  onClick={() => triggerCancel(detail)}
                >
                  取消订单
                </Button>
              ) : null}
              {canRefund && REFUNDABLE_STATUSES.includes(detail.status) ? (
                <Button
                  size="small"
                  danger
                  type="primary"
                  disabled={refunding}
                  onClick={() => triggerRefund(detail)}
                >
                  退款 + 撤销权益
                </Button>
              ) : null}
            </Space>
          ) : null
        }
      >
        {detailLoading ? (
          <div style={{ textAlign: "center", padding: 40 }}>
            <Empty description="加载中..." />
          </div>
        ) : !detail ? (
          <Empty description="暂无订单详情" />
        ) : (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Descriptions bordered column={1} size="small" title={<Space><EyeOutlined />订单快照</Space>}>
              <Descriptions.Item label="订单号">
                <Text copyable code>
                  {detail.orderNo}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={ORDER_STATUS_META[detail.status].color}>
                  {ORDER_STATUS_META[detail.status].label}
                </Tag>
                {PAYABLE_STATUSES.includes(detail.status) ? (
                  canMarkPaid ? (
                    <Tag color="orange">待人工补单</Tag>
                  ) : (
                    <Tag color="default">当前账号无补单权限</Tag>
                  )
                ) : null}
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm:ss")}
              </Descriptions.Item>
              <Descriptions.Item label="支付时间">
                {detail.paidAt ? dayjs(detail.paidAt).format("YYYY-MM-DD HH:mm:ss") : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="支付方式 / providerOrderId">
                {detail.paymentProvider || "-"}
                {detail.providerOrderId ? ` · ${detail.providerOrderId}` : ""}
              </Descriptions.Item>
              <Descriptions.Item label="用户">
                <Space>
                  <Text strong>{detail.user?.displayName}</Text>
                  {detail.user?.username ? <Tag>@{detail.user.username}</Tag> : null}
                </Space>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <UserOutlined /> Telegram UID: {detail.user?.telegramUserIdMasked || "-"}
                  </Text>
                </div>
              </Descriptions.Item>
              <Descriptions.Item label="商品">
                {detail.product?.title || "-"}
                <div>
                  <Tag>{detail.product?.type ? PRODUCT_TYPE_LABEL[detail.product.type] : "-"}</Tag>
                  {detail.product?.durationDays ? (
                    <Tag color="purple">{detail.product.durationDays} 天</Tag>
                  ) : null}
                </div>
              </Descriptions.Item>
              <Descriptions.Item label="金额">
                <div style={{ fontSize: 16, fontWeight: 700 }}>{formatAmountDisplay(detail.amountMinor, detail.currency)}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  订单原始金额：{detail.amountMinor}（{detail.currency}）
                </Text>
              </Descriptions.Item>
            </Descriptions>

            <div>
              <Title level={5} style={{ marginTop: 0 }}>
                <Space>
                  <SafetyCertificateOutlined />
                  已发放权益（{detail.entitlements.length} 条）
                </Space>
              </Title>
              {detail.entitlements.length === 0 ? (
                <Empty description={<Text type="secondary">此订单尚未生成权益（待支付 / 或对应商品无权益）</Text>} />
              ) : (
                <Table<Entitlement>
                  size="small"
                  pagination={false}
                  rowKey="id"
                  dataSource={detail.entitlements}
                  columns={[
                    {
                      title: "类型",
                      dataIndex: "resourceType",
                      width: 140,
                      render: (t: ResourceType) => (
                        <Tag color="geekblue">{RESOURCE_TYPE_LABEL[t]}</Tag>
                      ),
                    },
                    {
                      title: "资源 ID",
                      dataIndex: "resourceId",
                      ellipsis: true,
                      render: (v: string) => (
                        <Text code copyable={{ text: v }}>
                          {v}
                        </Text>
                      ),
                    },
                    { title: "状态", dataIndex: "status", width: 90 },
                    {
                      title: "开始 / 到期",
                      key: "t",
                      width: 300,
                      render: (_: any, e) => (
                        <div style={{ fontSize: 12 }}>
                          <div>
                            <Text type="secondary">起：</Text>
                            {dayjs(e.startsAt).format("YYYY-MM-DD HH:mm")}
                          </div>
                          <div>
                            <Text type="secondary">止：</Text>
                            {e.expiresAt ? dayjs(e.expiresAt).format("YYYY-MM-DD HH:mm") : "永久"}
                          </div>
                        </div>
                      ),
                    },
                    {
                      title: "客服快捷操作",
                      key: "quick",
                      width: 220,
                      render: (_: any, e) => {
                        const canDo =
                          canResendInvite && e.resourceType === "membership_channel" && e.status === "active";
                        return (
                          <Tooltip
                            title={
                              !canResendInvite
                                ? `仅客服或超管可补发邀请（当前${me?.role ? ROLE_LABEL[me.role] : "未知"}）`
                                : !canDo
                                ? `仅 active 会员频道权益可补发（当前类型=${RESOURCE_TYPE_LABEL[e.resourceType as ResourceType]} / status=${e.status}）`
                                : "重新生成频道邀请链接（每次新链接独立唯一，写入审计）"
                            }
                          >
                            <Button
                              size="small"
                              type="link"
                              disabled={!canDo}
                              loading={resendingInviteId === e.id}
                              onClick={() => doResendInviteInline(e)}
                              icon={<ReloadOutlined />}
                            >
                              补发邀请
                            </Button>
                          </Tooltip>
                        );
                      },
                    },
                  ]}
                />
              )}
            </div>

            <div>
              <Title level={5} style={{ marginTop: 0 }}>
                <Space>
                  <SafetyCertificateOutlined style={{ color: "#52c41a" }} />
                  审计记录（{auditLogs.length} 条，按时间升序）
                  {auditLoading ? <Tag color="blue">刷新中</Tag> : null}
                </Space>
              </Title>
              {!auditLoading && auditLogs.length === 0 ? (
                <Empty description={<Text type="secondary">暂无操作审计记录</Text>} />
              ) : (
                <List
                  loading={auditLoading}
                  dataSource={auditLogs}
                  renderItem={(l) => (
                    <List.Item key={l.id}>
                      <List.Item.Meta
                        avatar={
                          <div
                            style={{
                              width: 40,
                              height: 40,
                              borderRadius: 20,
                              background: "#f0f5ff",
                              color: "#1677ff",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontWeight: 700,
                              fontSize: 14,
                            }}
                          >
                            {(l.admin?.displayName || l.admin?.email || "A").charAt(0).toUpperCase()}
                          </div>
                        }
                        title={
                          <Space>
                            <b>{ACTION_LABEL[l.action] || l.action}</b>
                            <Tag>
                              {l.admin
                                ? `${ROLE_LABEL[l.admin.role]} · ${l.admin.displayName || l.admin.email}`
                                : "未知操作人"}
                            </Tag>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {dayjs(l.createdAt).format("YYYY-MM-DD HH:mm:ss")}
                            </Text>
                          </Space>
                        }
                        description={
                          <Space direction="vertical" size="small" style={{ width: "100%" }}>
                            {l.reason ? (
                              <div>
                                <Text type="secondary">到账说明：</Text>
                                <Text strong>{l.reason}</Text>
                              </div>
                            ) : null}
                            {l.ipAddress ? (
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                IP: {l.ipAddress}
                              </Text>
                            ) : null}
                          </Space>
                        }
                      />
                    </List.Item>
                  )}
                />
              )}
              <div style={{ marginTop: 8 }}>
                <Timeline
                  mode="left"
                  items={auditLogs.map((l) => ({
                    color:
                      l.action === "admin.order.mark_paid" ? "green" :
                      l.action === "admin.auth.login" ? "blue" : "gray",
                    label: dayjs(l.createdAt).format("MM-DD HH:mm"),
                    children: (
                      <div>
                        <b>{ACTION_LABEL[l.action] || l.action}</b> ·{" "}
                        {l.admin
                          ? `${ROLE_LABEL[l.admin.role]} ${l.admin.displayName || l.admin.email}`
                          : "未知"}
                        {l.reason ? (
                          <>
                            {" "}
                            ｜ <Text type="secondary">备注：</Text>
                            <Text strong>{l.reason}</Text>
                          </>
                        ) : null}
                      </div>
                    ),
                  }))}
                />
              </div>
            </div>
          </Space>
        )}
      </Drawer>
    </div>
  );
};

export default OrdersPage;
