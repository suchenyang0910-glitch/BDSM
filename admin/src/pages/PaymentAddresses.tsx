import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  approveAdminPaymentAddress,
  createAdminPaymentAddress,
  errMsg,
  getUsdtMonitorStatus,
  listAdminPaymentAddresses,
  releaseExpiredAdminPaymentAddresses,
  revealAdminPaymentAddress,
  retireAdminPaymentAddress,
} from "../api/client";
import type {
  AdminRole,
  PaymentAddressItem,
  PaymentAddressStatus,
  UsdtMonitorStatusResp,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";

dayjs.extend(relativeTime);

const { Text, Title } = Typography;

const VIEW_ROLES: AdminRole[] = ["finance", "super_admin"];
const REVEAL_ROLES: AdminRole[] = ["super_admin"];

const STATUS_META: Record<PaymentAddressStatus, { label: string; color: string }> = {
  pending_approval: { label: "待复核", color: "processing" },
  available: { label: "可用", color: "green" },
  assigned: { label: "订单占用", color: "gold" },
  retired: { label: "已停用", color: "default" },
};

const MONITOR_META: Record<UsdtMonitorStatusResp["monitor"]["status"], { label: string; color: string }> = {
  normal: { label: "正常", color: "success" },
  delayed: { label: "延迟", color: "warning" },
  unavailable: { label: "不可用", color: "error" },
};

const PaymentAddressesPage: React.FC = () => {
  const { me } = useAuth();
  const canView = !!me && VIEW_ROLES.includes(me.role);
  const canReveal = !!me && REVEAL_ROLES.includes(me.role);
  const canManage = canView;

  const [filterForm] = Form.useForm();
  const [createForm] = Form.useForm();
  const [retireForm] = Form.useForm();

  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [addresses, setAddresses] = useState<PaymentAddressItem[]>([]);
  const [monitor, setMonitor] = useState<UsdtMonitorStatusResp | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [retireTarget, setRetireTarget] = useState<PaymentAddressItem | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; address: string } | null>(null);

  const load = useCallback(async () => {
    if (!canView) return;
    const values = filterForm.getFieldsValue();
    setLoading(true);
    try {
      const [listRes, monitorRes] = await Promise.all([
        listAdminPaymentAddresses({
          page,
          pageSize,
          status: values.status,
          addressKeyword: values.addressKeyword?.trim() || undefined,
          network: "tron_trc20",
        }),
        getUsdtMonitorStatus(),
      ]);
      setAddresses(listRes.items);
      setTotal(listRes.pagination.total);
      setMonitor(monitorRes);
    } catch (err) {
      message.error("USDT 收款地址加载失败：" + errMsg(err, "未知错误"));
    } finally {
      setLoading(false);
    }
  }, [canView, filterForm, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = useMemo<ColumnsType<PaymentAddressItem>>(
    () => [
      {
        title: "地址",
        dataIndex: "addressMasked",
        render: (value: string, row) => (
          <Space direction="vertical" size={2}>
            <Text code>{revealed?.id === row.id ? revealed.address : value}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              USDT-TRC20
            </Text>
          </Space>
        ),
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 120,
        render: (status: PaymentAddressStatus) => (
          <Tag color={STATUS_META[status].color}>{STATUS_META[status].label}</Tag>
        ),
      },
      {
        title: "占用订单 / 时间",
        key: "assignment",
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2}>
            <Text>{row.assignedOrderId || "未占用"}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              生效：{row.activationReadyAt ? dayjs(row.activationReadyAt).format("MM-DD HH:mm:ss") : "—"}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              分配：{row.assignedAt ? dayjs(row.assignedAt).format("MM-DD HH:mm:ss") : "—"}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              释放：{row.releaseAt ? dayjs(row.releaseAt).format("MM-DD HH:mm:ss") : "—"}
            </Text>
          </Space>
        ),
      },
      {
        title: "停用信息",
        key: "retire",
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2}>
            <Text type="secondary">{row.retiredAt ? dayjs(row.retiredAt).format("MM-DD HH:mm:ss") : "—"}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.retireReason || "—"}
            </Text>
          </Space>
        ),
      },
      {
        title: "操作",
        key: "actions",
        width: 240,
        render: (_: unknown, row) => (
          <Space wrap>
            {canReveal ? (
              <Popconfirm
                title="短暂查看地址明文？"
                description="仅 super_admin 可查看；不要截图、不要复制到群聊。"
                onConfirm={async () => {
                  try {
                    const res = await revealAdminPaymentAddress(row.id);
                    setRevealed({ id: row.id, address: res.address });
                    message.success("地址明文仅在当前页面短暂显示。");
                  } catch (err) {
                    message.error("查看明文失败：" + errMsg(err, "未知错误"));
                  }
                }}
              >
                <Button size="small">查看明文</Button>
              </Popconfirm>
            ) : null}
            {me?.role === "super_admin" && row.status === "pending_approval" ? (
              <Popconfirm
                title="批准该收款地址？"
                description="批准后至少 10 分钟冷却期，期间不会用于新订单。"
                onConfirm={async () => {
                  try {
                    await approveAdminPaymentAddress(row.id);
                    message.success("已批准，地址将在冷却期后投入地址池。");
                    await load();
                  } catch (err) {
                    message.error("批准失败：" + errMsg(err, "未知错误"));
                  }
                }}
              >
                <Button size="small" type="primary">批准</Button>
              </Popconfirm>
            ) : null}
            <Button size="small" danger disabled={!canManage} onClick={() => {
              setRetireTarget(row);
              retireForm.setFieldsValue({
                reason: "停用失效或高风险收款地址",
                forceReleaseAssigned: false,
                forceCancelActiveOrder: false,
              });
            }}>
              停用
            </Button>
          </Space>
        ),
      },
    ],
    [canManage, canReveal, revealed, retireForm],
  );

  if (!canView) {
    return <Alert type="error" showIcon message="403 无权限" description="仅 finance / super_admin 可访问 USDT 收款地址页。" />;
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="只录入公开收款地址"
        description="此页只能添加 USDT-TRC20 公共收款地址。绝不录入私钥、助记词、交易签名能力或任何链上出账能力。"
      />

      <Space size={16} style={{ display: "flex", marginBottom: 16 }} wrap>
        <Card><Statistic title="待复核地址数" value={monitor?.counts.pendingApproval ?? 0} /></Card>
        <Card><Statistic title="可用地址数" value={monitor?.counts.available ?? 0} /></Card>
        <Card><Statistic title="占用地址数" value={monitor?.counts.assigned ?? 0} /></Card>
        <Card><Statistic title="已停用地址数" value={monitor?.counts.retired ?? 0} /></Card>
        <Card style={{ minWidth: 280 }}>
          <Space direction="vertical" size={4}>
            <Text strong>TRC-20 监听状态</Text>
            {monitor ? (
              <>
                <Tag color={MONITOR_META[monitor.monitor.status].color}>{MONITOR_META[monitor.monitor.status].label}</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  最后成功扫描：{monitor.monitor.lastSuccessAt ? dayjs(monitor.monitor.lastSuccessAt).fromNow() : "未成功"}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  最近错误：{monitor.monitor.lastErrorClass || "无"}
                </Text>
              </>
            ) : (
              <Text type="secondary">加载中…</Text>
            )}
          </Space>
        </Card>
      </Space>

      {monitor?.availableLow ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message="可用地址少于 3 个" description="请尽快补充新的 TRON 收款地址，避免 USDT 下单池耗尽。" />
      ) : null}

      <Card style={{ marginBottom: 16 }}>
        <Title level={5}>添加收款地址</Title>
        <Form
          form={createForm}
          layout="inline"
          onFinish={async (values) => {
            setCreating(true);
            try {
              await createAdminPaymentAddress({
                address: values.address,
                network: "tron_trc20",
              });
              message.success("收款地址已提交，等待不同 super_admin 复核。");
              createForm.resetFields();
              await load();
            } catch (err) {
              message.error("新增地址失败：" + errMsg(err, "未知错误"));
            } finally {
              setCreating(false);
            }
          }}
        >
          <Form.Item
            name="address"
            label="TRON 地址"
            rules={[
              { required: true, message: "请输入 T 开头的 TRON 收款地址" },
              { pattern: /^T[1-9A-HJ-NP-Za-km-z]{25,48}$/, message: "地址格式必须是 TRON Base58 公共地址" },
            ]}
            style={{ minWidth: 420 }}
          >
            <Input placeholder="T..." autoComplete="off" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={creating}>
              添加地址
            </Button>
          </Form.Item>
          <Form.Item>
            <Button
              loading={releasing}
              onClick={async () => {
                setReleasing(true);
                try {
                  const res = await releaseExpiredAdminPaymentAddresses();
                  message.success(`已回收过期地址 ${res.released} 个，失败 ${res.errors} 个。`);
                  await load();
                } catch (err) {
                  message.error("回收失败：" + errMsg(err, "未知错误"));
                } finally {
                  setReleasing(false);
                }
              }}
            >
              立即回收过期地址
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card>
        <Form
          form={filterForm}
          layout="inline"
          style={{ marginBottom: 16 }}
          onFinish={() => {
            setPage(1);
            void load();
          }}
        >
          <Form.Item name="status" label="状态">
            <Select allowClear style={{ width: 160 }} options={[
              { value: "pending_approval", label: "待复核" },
              { value: "available", label: "可用" },
              { value: "assigned", label: "订单占用" },
              { value: "retired", label: "已停用" },
            ]} />
          </Form.Item>
          <Form.Item name="addressKeyword" label="关键词">
            <Input allowClear placeholder="地址关键词" style={{ width: 220 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">筛选</Button>
              <Button onClick={() => {
                filterForm.resetFields();
                setPage(1);
                void load();
              }}>
                重置
              </Button>
            </Space>
          </Form.Item>
        </Form>

        <Table<PaymentAddressItem>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={addresses}
          locale={{ emptyText: <Empty description="暂无 USDT 收款地址" /> }}
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

      <Modal
        open={!!retireTarget}
        title="停用收款地址"
        onCancel={() => !retiring && setRetireTarget(null)}
        onOk={async () => {
          if (!retireTarget) return;
          const values = await retireForm.validateFields();
          setRetiring(true);
          try {
            await retireAdminPaymentAddress(retireTarget.id, values);
            message.success("地址已停用。");
            setRetireTarget(null);
            await load();
          } catch (err) {
            message.error("停用失败：" + errMsg(err, "未知错误"));
          } finally {
            setRetiring(false);
          }
        }}
        confirmLoading={retiring}
        okText="确认停用"
      >
        <Form form={retireForm} layout="vertical">
          <Form.Item label="地址">
            <Text code>{retireTarget?.addressMasked}</Text>
          </Form.Item>
          <Form.Item name="reason" label="停用原因" rules={[{ required: true, min: 2, max: 128 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="forceReleaseAssigned" valuePropName="checked">
            <label><input type="checkbox" checked={!!retireForm.getFieldValue("forceReleaseAssigned")} onChange={(e) => retireForm.setFieldsValue({ forceReleaseAssigned: e.target.checked })} /> 强制释放已占用地址</label>
          </Form.Item>
          <Form.Item name="forceCancelActiveOrder" valuePropName="checked">
            <label><input type="checkbox" checked={!!retireForm.getFieldValue("forceCancelActiveOrder")} onChange={(e) => retireForm.setFieldsValue({ forceCancelActiveOrder: e.target.checked })} /> 如仍绑定有效待支付订单，则一并取消该订单</label>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default PaymentAddressesPage;
