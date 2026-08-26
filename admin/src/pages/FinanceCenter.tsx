import React from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Form,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import {
  buildAdminFinanceExportUrl,
  errMsg,
  getAdminFinanceAddressPool,
  getAdminFinanceOverview,
  getAdminFinanceReconciliation,
  getAdminFinanceTrends,
} from "../api/client";
import type {
  AdminRole,
  FinanceAddressPoolResp,
  FinanceFilterPreset,
  FinanceOverviewResp,
  FinancePaymentMethod,
  FinanceQuery,
  FinanceReconciliationReasonCode,
  FinanceReconciliationResp,
  FinanceTrendRow,
  FinanceTrendsResp,
  OrderStatus,
  ProductType,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

const VIEW_ROLES: AdminRole[] = ["finance", "super_admin"];

const METHOD_LABEL: Record<string, string> = {
  telegram_stars: "Telegram Stars",
  usdt_trc20: "USDT-TRC20",
  manual: "人工补单",
};

const RECON_REASON_LABEL: Record<FinanceReconciliationReasonCode, string> = {
  paid_without_confirmed_tx: "已支付但无确认交易",
  confirmed_tx_without_paid_order: "已确认交易但订单未 paid",
  paid_without_active_entitlement: "已支付但无生效权益",
  refunded_without_refunded_tx: "已退款但无退款交易记录",
};

function formatMethodAmount(amount: string, method: FinancePaymentMethod) {
  try {
    const raw = BigInt(amount || "0");
    if (method === "telegram_stars") {
      const stars = raw > 0n && raw >= 1_000_000n && raw % 1_000_000n === 0n ? raw / 1_000_000n : raw;
      return `${stars.toString()} Stars`;
    }
    if (method === "usdt_trc20") {
      const sign = raw < 0n ? "-" : "";
      const absolute = raw < 0n ? -raw : raw;
      const whole = absolute / 1_000_000n;
      const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
      return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ""} USDT`;
    }
    return `${raw.toString()} 人工补单`;
  } catch {
    return "—";
  }
}

function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function openExport(kind: "overview" | "orders" | "reconciliation", query: FinanceQuery) {
  window.open(buildAdminFinanceExportUrl(kind, query), "_blank", "noopener,noreferrer");
}

const FinanceCenterPage: React.FC = () => {
  const { me } = useAuth();
  const canView = !!me && VIEW_ROLES.includes(me.role);
  const [form] = Form.useForm();
  const [view, setView] = React.useState<"overview" | "trends" | "address_pool" | "reconciliation">("overview");
  const [loading, setLoading] = React.useState(false);
  const [query, setQuery] = React.useState<FinanceQuery>({ preset: "30d" });
  const [overview, setOverview] = React.useState<FinanceOverviewResp | null>(null);
  const [trends, setTrends] = React.useState<FinanceTrendsResp | null>(null);
  const [addressPool, setAddressPool] = React.useState<FinanceAddressPoolResp | null>(null);
  const [reconciliation, setReconciliation] = React.useState<FinanceReconciliationResp | null>(null);

  const load = React.useCallback(async (nextQuery: FinanceQuery) => {
    if (!canView) return;
    setLoading(true);
    try {
      const [overviewResp, trendsResp, addressPoolResp, reconciliationResp] = await Promise.all([
        getAdminFinanceOverview(nextQuery),
        getAdminFinanceTrends(nextQuery),
        getAdminFinanceAddressPool(),
        getAdminFinanceReconciliation(nextQuery),
      ]);
      setOverview(overviewResp);
      setTrends(trendsResp);
      setAddressPool(addressPoolResp);
      setReconciliation(reconciliationResp);
    } catch (e) {
      message.error(errMsg(e, "加载财务数据中心失败"));
    } finally {
      setLoading(false);
    }
  }, [canView]);

  React.useEffect(() => {
    void load(query);
  }, [load, query]);

  if (!canView) {
    return <Alert type="error" showIcon message="403 无权限" description="仅 finance / super_admin 可访问财务数据中心。" />;
  }

  const submitFilters = async () => {
    const values = form.getFieldsValue();
    const nextQuery: FinanceQuery = {
      preset: values.preset as FinanceFilterPreset,
      paymentMethod: values.paymentMethod as FinancePaymentMethod | undefined,
      status: values.status as OrderStatus | undefined,
      productType: values.productType as ProductType | undefined,
    };
    if (values.preset === "custom" && values.range?.[0] && values.range?.[1]) {
      nextQuery.from = values.range[0].toISOString();
      nextQuery.to = values.range[1].toISOString();
    }
    setQuery(nextQuery);
  };

  const renderOverview = () => {
    if (!overview) return <Empty description="暂无财务总览" />;
    const metrics = overview.metrics;
    return (
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} lg={6}><Card><Statistic title="已支付订单" value={metrics.paidOrderCount} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="付费用户" value={metrics.paidUserCount} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="支付成功率" value={(metrics.paymentSuccessRateBps / 100).toFixed(1)} suffix="%" /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="待处理订单" value={metrics.pendingOrderCount} /></Card></Col>
        </Row>
        <Row gutter={[16, 16]}>
          {(["telegram_stars", "usdt_trc20", "manual"] as FinancePaymentMethod[]).map((method) => (
            <Col xs={24} lg={8} key={method}>
              <Card title={METHOD_LABEL[method]}>
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><Text type="secondary">确认 GMV</Text><Text strong>{formatMethodAmount(metrics.confirmedGmv[method], method)}</Text></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><Text type="secondary">退款金额</Text><Text strong>{formatMethodAmount(metrics.refundedAmount[method], method)}</Text></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><Text type="secondary">净收入</Text><Text strong>{formatMethodAmount(metrics.netRevenue[method], method)}</Text></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><Text type="secondary">客单价</Text><Text strong>{formatMethodAmount(metrics.averageOrderValueByMethod[method], method)}</Text></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><Text type="secondary">已支付笔数</Text><Text strong>{metrics.paidOrderCountByMethod[method]}</Text></div>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={8}><Card><Statistic title="待确认 USDT 金额" value={formatMethodAmount(metrics.pendingUsdtAmount, "usdt_trc20")} /></Card></Col>
          <Col xs={24} lg={8}><Card><Statistic title="USDT 平均确认耗时" value={formatDuration(metrics.usdtAverageConfirmMs)} /></Card></Col>
          <Col xs={24} lg={8}><Card><Statistic title="Stars 平均成功耗时" value={formatDuration(metrics.starsAverageSuccessMs)} /></Card></Col>
        </Row>
      </Space>
    );
  };

  const renderTrends = () => (
    <Table
      rowKey="date"
      size="small"
      dataSource={trends?.rows || []}
      locale={{ emptyText: <Empty description="当前筛选下没有趋势数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
      pagination={{ pageSize: 10, hideOnSinglePage: true }}
      columns={[
        { title: "日期", dataIndex: "date", width: 120 },
        { title: "订单数", dataIndex: "orderCount", width: 90 },
        {
          title: "确认收入",
          render: (_: unknown, row: FinanceTrendRow) => (
            <Space direction="vertical" size={0}>
              <Text>{formatMethodAmount(row.confirmedAmount.telegram_stars, "telegram_stars")}</Text>
              <Text>{formatMethodAmount(row.confirmedAmount.usdt_trc20, "usdt_trc20")}</Text>
              <Text>{formatMethodAmount(row.confirmedAmount.manual, "manual")}</Text>
            </Space>
          ),
        },
        {
          title: "退款",
          render: (_: unknown, row: FinanceTrendRow) => (
            <Space direction="vertical" size={0}>
              <Text>{formatMethodAmount(row.refundedAmount.telegram_stars, "telegram_stars")}</Text>
              <Text>{formatMethodAmount(row.refundedAmount.usdt_trc20, "usdt_trc20")}</Text>
              <Text>{formatMethodAmount(row.refundedAmount.manual, "manual")}</Text>
            </Space>
          ),
        },
        {
          title: "净收入",
          render: (_: unknown, row: FinanceTrendRow) => (
            <Space direction="vertical" size={0}>
              <Text>{formatMethodAmount(row.netRevenue.telegram_stars, "telegram_stars")}</Text>
              <Text>{formatMethodAmount(row.netRevenue.usdt_trc20, "usdt_trc20")}</Text>
              <Text>{formatMethodAmount(row.netRevenue.manual, "manual")}</Text>
            </Space>
          ),
        },
      ]}
    />
  );

  const renderAddressPool = () => (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {addressPool?.globalAlerts.lowAvailableAddresses ? (
        <Alert type="error" showIcon message="可用地址不足" description="当前可直接分配的 USDT 地址少于安全阈值，请尽快补池。" />
      ) : null}
      {addressPool?.globalAlerts.monitorScanStale24h ? (
        <Alert type="warning" showIcon message="监听扫描已超过 24 小时未成功" description="建议先检查 USDT 监听 Worker 状态，再继续人工放单或地址复用。" />
      ) : null}
      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}><Card><Statistic title="地址总数" value={addressPool?.rows.length || 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="最近成功扫描" value={addressPool?.globalAlerts.runtimeLastSuccessAt ? dayjs(addressPool.globalAlerts.runtimeLastSuccessAt).format("MM-DD HH:mm") : "—"} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="连续失败次数" value={addressPool?.globalAlerts.runtimeConsecutiveFailures || 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="异常地址数" value={(addressPool?.rows || []).filter((row) => row.abnormalFlags.length > 0).length} /></Card></Col>
      </Row>
      <Table
        rowKey="id"
        size="small"
        dataSource={addressPool?.rows || []}
        locale={{ emptyText: <Empty description="暂无地址池数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={{ pageSize: 10 }}
        columns={[
          { title: "地址", dataIndex: "addressMasked", width: 180, render: (value: string) => <Text code>{value}</Text> },
          { title: "状态", dataIndex: "status", width: 110, render: (value: string) => <Tag>{value}</Tag> },
          { title: "分配订单", dataIndex: "assignedOrderCount", width: 90 },
          { title: "已确认", dataIndex: "confirmedOrderCount", width: 90 },
          { title: "确认中", dataIndex: "confirmingOrderCount", width: 90 },
          { title: "过期释放", dataIndex: "expiredReleasedCount", width: 90 },
          { title: "退款", dataIndex: "refundedCount", width: 70 },
          { title: "最近使用", dataIndex: "lastUsedAt", width: 140, render: (value: string | null) => value ? dayjs(value).format("MM-DD HH:mm") : "—" },
          { title: "监听成功", dataIndex: "lastMonitorSuccessAt", width: 140, render: (value: string | null) => value ? dayjs(value).format("MM-DD HH:mm") : "—" },
          { title: "异常标记", dataIndex: "abnormalFlags", render: (values: string[]) => values.length ? <Space wrap>{values.map((value) => <Tag color="red" key={value}>{value}</Tag>)}</Space> : "—" },
        ]}
      />
    </Space>
  );

  const renderReconciliation = () => {
    if (!reconciliation) return <Empty description="暂无对账数据" />;
    return (
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} lg={6}><Card><Statistic title="订单总数" value={reconciliation.totals.orderCount} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="已支付订单" value={reconciliation.totals.paidOrderCount} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="确认交易数" value={reconciliation.totals.confirmedTransactionCount} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="有效权益数" value={reconciliation.totals.activeEntitlementCount} /></Card></Col>
        </Row>
        <Row gutter={[16, 16]}>
          {(Object.keys(reconciliation.differences) as FinanceReconciliationReasonCode[]).map((key) => (
            <Col xs={24} lg={12} key={key}>
              <Card title={RECON_REASON_LABEL[key]}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <Text type="secondary">异常订单数</Text>
                  <Text strong>{reconciliation.differences[key].count}</Text>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                  <Text type="secondary">涉及金额</Text>
                  <Space direction="vertical" size={0} align="end">
                    {(["telegram_stars", "usdt_trc20", "manual"] as FinancePaymentMethod[]).map((method) => (
                      <Text key={method}>{formatMethodAmount(reconciliation.differences[key].amount[method], method)}</Text>
                    ))}
                  </Space>
                </div>
              </Card>
            </Col>
          ))}
        </Row>
        <Table
          rowKey={(row) => `${row.orderNoMasked}-${row.paymentMethod}`}
          size="small"
          dataSource={reconciliation.rows || []}
          locale={{ emptyText: <Empty description="当前筛选下没有异常或抽样数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          pagination={{ pageSize: 12 }}
          columns={[
            { title: "订单号", dataIndex: "orderNoMasked", width: 120 },
            { title: "支付方式", dataIndex: "paymentMethod", width: 120, render: (value: string) => METHOD_LABEL[value] || value },
            { title: "状态", dataIndex: "orderStatus", width: 100 },
            { title: "金额", dataIndex: "orderAmountMinor", width: 140, render: (value: string, row: FinanceReconciliationResp["rows"][number]) => formatMethodAmount(value, row.paymentMethod) },
            { title: "确认时间", dataIndex: "confirmedAt", width: 140, render: (value: string | null) => value ? dayjs(value).format("MM-DD HH:mm") : "—" },
            { title: "确认耗时", dataIndex: "confirmDurationMs", width: 100, render: (value: number | null) => formatDuration(value) },
            { title: "地址", dataIndex: "addressMasked", width: 150, render: (value: string | null) => value ? <Text code>{value}</Text> : "—" },
            { title: "异常原因", dataIndex: "reasonCodes", render: (values: FinanceReconciliationReasonCode[]) => values.length ? <Space wrap>{values.map((value) => <Tag color="red" key={value}>{RECON_REASON_LABEL[value]}</Tag>)}</Space> : <Tag color="green">正常</Tag> },
          ]}
        />
      </Space>
    );
  };

  return (
    <Spin spinning={loading} tip="加载财务数据中心中…">
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>财务数据中心</Title>
            <Text type="secondary">按支付方式拆分 GMV、退款、对账异常与地址池状态，避免把 Stars 和 USDT 混成一锅账。</Text>
          </div>
          <Space wrap>
            <Button icon={<DownloadOutlined />} onClick={() => openExport("overview", query)}>导出总览</Button>
            <Button icon={<DownloadOutlined />} onClick={() => openExport("orders", query)}>导出订单</Button>
            <Button icon={<DownloadOutlined />} onClick={() => openExport("reconciliation", query)}>导出对账</Button>
            <Button icon={<ReloadOutlined />} onClick={() => void load(query)}>刷新</Button>
          </Space>
        </div>

        <Alert type="info" showIcon message="财务口径说明" description="所有金额均保留为最小货币单位字符串；Stars、USDT、人工补单分别展示，避免跨币种误汇总。" />

        <Card>
          <Form form={form} layout="inline" initialValues={{ preset: "30d" }} onFinish={submitFilters}>
            <Form.Item name="preset" label="统计周期">
              <Select
                style={{ width: 140 }}
                options={[
                  { value: "today", label: "今天" },
                  { value: "7d", label: "近 7 天" },
                  { value: "30d", label: "近 30 天" },
                  { value: "custom", label: "自定义" },
                ]}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, next) => prev.preset !== next.preset}>
              {({ getFieldValue }) => getFieldValue("preset") === "custom" ? (
                <Form.Item name="range" label="时间范围" rules={[{ required: true, message: "请选择时间范围" }]}>
                  <RangePicker showTime />
                </Form.Item>
              ) : null}
            </Form.Item>
            <Form.Item name="paymentMethod" label="支付方式">
              <Select allowClear style={{ width: 160 }} options={[
                { value: "telegram_stars", label: "Telegram Stars" },
                { value: "usdt_trc20", label: "USDT-TRC20" },
                { value: "manual", label: "人工补单" },
              ]} />
            </Form.Item>
            <Form.Item name="status" label="订单状态">
              <Select allowClear style={{ width: 160 }} options={[
                { value: "pending", label: "待支付" },
                { value: "processing", label: "处理中" },
                { value: "paid", label: "已支付" },
                { value: "failed", label: "失败" },
                { value: "refunded", label: "已退款" },
                { value: "cancelled", label: "已取消" },
                { value: "expired", label: "已过期" },
              ]} />
            </Form.Item>
            <Form.Item name="productType" label="商品类型">
              <Select allowClear style={{ width: 150 }} options={[
                { value: "single", label: "单条内容" },
                { value: "package", label: "内容包" },
                { value: "membership", label: "会员" },
              ]} />
            </Form.Item>
            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit">筛选</Button>
                <Button onClick={() => {
                  form.resetFields();
                  form.setFieldsValue({ preset: "30d" });
                  setQuery({ preset: "30d" });
                }}>
                  重置
                </Button>
              </Space>
            </Form.Item>
          </Form>
        </Card>

        <Segmented
          value={view}
          onChange={(value) => setView(value as typeof view)}
          options={[
            { value: "overview", label: "总览页" },
            { value: "trends", label: "趋势页" },
            { value: "address_pool", label: "地址池页" },
            { value: "reconciliation", label: "对账页" },
          ]}
        />

        <Card>
          {view === "overview" && renderOverview()}
          {view === "trends" && renderTrends()}
          {view === "address_pool" && renderAddressPool()}
          {view === "reconciliation" && renderReconciliation()}
        </Card>
      </Space>
    </Spin>
  );
};

export default FinanceCenterPage;
