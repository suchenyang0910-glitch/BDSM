import React, { useEffect, useState } from "react";
import { Row, Col, Card, Statistic, Space, Typography, Spin, Alert, Tag, Divider, Tooltip } from "antd";
import {
  UserOutlined,
  DollarOutlined,
  ReloadOutlined,
  ShoppingCartOutlined,
  SendOutlined,
  CustomerServiceOutlined,
  InfoCircleOutlined,
  RocketOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { listAdminDashboard, errMsg } from "../api/client";
import type { AdminDashboardSummary, AdminDashboardGmvByMethod } from "../api/types";

const { Title, Text, Paragraph } = Typography;

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  stars: "Telegram Stars",
  usdt_trc20: "USDT-TRC20",
};

function currencyLabel(currency: string): string {
  if (currency === "USDT") return "USDT";
  if (currency === "XTR") return "XTR (Stars)";
  return currency;
}

function methodLabel(k: string): string {
  return PAYMENT_METHOD_LABEL[k] || k;
}

const GMVDisplay: React.FC<{ byMethod: AdminDashboardGmvByMethod; totalPaidOrders: number }> = ({
  byMethod,
  totalPaidOrders,
}) => {
  const entries = Object.entries(byMethod);
  if (entries.length === 0) {
    return (
      <Space direction="vertical" size={2}>
        <Text type="secondary" style={{ fontSize: 24, fontWeight: 600 }}>
          0
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          当月无支付订单
        </Text>
      </Space>
    );
  }
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{ width: "100%" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <Tag color="blue" style={{ margin: 0 }}>
              {methodLabel(k)}
            </Tag>
            <Space direction="vertical" size={0} align="end">
              <Text strong style={{ fontSize: 20, lineHeight: 1.2 }}>
                {v.amountDisplay} {currencyLabel(v.currency)}
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {v.count} 笔订单
              </Text>
            </Space>
          </div>
        </div>
      ))}
      <Divider style={{ margin: "4px 0" }} />
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <Text type="secondary">当月合计付费订单</Text>
        <Text strong>{totalPaidOrders} 笔</Text>
      </div>
    </Space>
  );
};

const PercentStat: React.FC<{
  percent: number;
  numerator: number;
  denominator: number;
  numeratorLabel: string;
  denominatorLabel: string;
}> = ({ percent, numerator, denominator, numeratorLabel, denominatorLabel }) => (
  <Space direction="vertical" size={4} style={{ width: "100%" }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <Text style={{ fontSize: 28, fontWeight: 700, color: "#1677ff" }}>{percent.toFixed(1)}</Text>
      <Text style={{ fontSize: 16, color: "#1677ff" }}>%</Text>
    </div>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
      <Text type="secondary">
        {numeratorLabel}：<Text strong>{numerator}</Text>
      </Text>
    </div>
    <div style={{ fontSize: 12 }}>
      <Text type="secondary">
        {denominatorLabel}：<Text strong>{denominator}</Text>
      </Text>
    </div>
  </Space>
);

const DashboardPage: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AdminDashboardSummary | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listAdminDashboard();
      setData(r);
    } catch (e) {
      setError(errMsg(e, "加载看板数据失败"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const cards = data?.cards;

  return (
    <Spin spinning={loading} tip="加载运营看板数据中…">
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Space direction="vertical" size={0}>
            <Title level={3} style={{ margin: 0 }}>
              运营看板
              <Tooltip title="数据基于当月已支付订单，仅用于运营参考，不作为财务对账依据。">
                <InfoCircleOutlined style={{ marginLeft: 8, color: "#999" }} />
              </Tooltip>
            </Title>
            <Text type="secondary">
              {data
                ? `${data.period.label} · 统计时点 ${dayjs(data.period.asOf).format("YYYY-MM-DD HH:mm:ss")}`
                : ""}
            </Text>
          </Space>
          <a onClick={load} style={{ cursor: "pointer" }}>
            <Space>
              <ReloadOutlined />
              刷新
            </Space>
          </a>
        </div>

        {error && <Alert message={error} type="error" showIcon closable />}

        {data && cards && (
          <>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={12} lg={8}>
                <Card
                  bordered
                  title={
                    <Space>
                      <UserOutlined style={{ color: "#1677ff" }} />
                      付费用户数
                    </Space>
                  }
                  extra={
                    <Tooltip title="当月至少有 1 笔状态为 paid 订单的去重用户">
                      <InfoCircleOutlined style={{ color: "#bbb" }} />
                    </Tooltip>
                  }
                >
                  <Statistic value={cards.payingUsers.value} suffix={cards.payingUsers.unit} valueStyle={{ color: "#1677ff" }} />
                  <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                    {cards.payingUsers.description}
                  </Paragraph>
                </Card>
              </Col>

              <Col xs={24} sm={12} lg={8}>
                <Card
                  bordered
                  title={
                    <Space>
                      <DollarOutlined style={{ color: "#52c41a" }} />
                      月度 GMV
                    </Space>
                  }
                  extra={
                    <Tooltip title="按支付方式拆分；amountMinor 为最小货币单位字符串，避免浮点数精度丢失。">
                      <InfoCircleOutlined style={{ color: "#bbb" }} />
                    </Tooltip>
                  }
                >
                  <GMVDisplay byMethod={cards.monthlyGmv.byMethod} totalPaidOrders={cards.monthlyGmv.totalPaidOrders} />
                  <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                    {cards.monthlyGmv.description}
                  </Paragraph>
                </Card>
              </Col>

              <Col xs={24} sm={12} lg={8}>
                <Card
                  bordered
                  title={
                    <Space>
                      <ReloadOutlined style={{ color: "#722ed1" }} />
                      会员续费率
                    </Space>
                  }
                  extra={
                    <Tooltip title="本月到期的会员中，在到期日前后 7 天窗口内产生新会员权益的用户比例（近似估算）。">
                      <InfoCircleOutlined style={{ color: "#bbb" }} />
                    </Tooltip>
                  }
                >
                  <PercentStat
                    percent={cards.membershipRenewal.ratePercent}
                    numerator={cards.membershipRenewal.renewedWithin7dUsers}
                    denominator={cards.membershipRenewal.expiringMembershipUsers}
                    numeratorLabel="到期 ±7 天内续费用户"
                    denominatorLabel="本月到期会员用户"
                  />
                  <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                    {cards.membershipRenewal.description}
                  </Paragraph>
                </Card>
              </Col>

              <Col xs={24} sm={12} lg={8}>
                <Card
                  bordered
                  title={
                    <Space>
                      <ShoppingCartOutlined style={{ color: "#fa8c16" }} />
                      内容包购买率
                    </Space>
                  }
                  extra={
                    <Tooltip title="产品类型为 package 的付费订单 / 所有付费订单。">
                      <InfoCircleOutlined style={{ color: "#bbb" }} />
                    </Tooltip>
                  }
                >
                  <PercentStat
                    percent={cards.packagePurchase.ratePercent}
                    numerator={cards.packagePurchase.packagePaidOrders}
                    denominator={cards.packagePurchase.allPaidOrders}
                    numeratorLabel="内容包付费订单"
                    denominatorLabel="所有付费订单"
                  />
                  <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                    {cards.packagePurchase.description}
                  </Paragraph>
                </Card>
              </Col>

              <Col xs={24} sm={12} lg={8}>
                <Card
                  bordered
                  title={
                    <Space>
                      <SendOutlined style={{ color: "#13c2c2" }} />
                      邀请交付成功率
                    </Space>
                  }
                  extra={
                    <Tooltip title="当月创建的 Telegram 邀请记录数 / 当月付费订单数。由于 1 单可能对应多个邀请，指标 ≥100% 时截断为 100%，仅作运营近似参考。">
                      <InfoCircleOutlined style={{ color: "#bbb" }} />
                    </Tooltip>
                  }
                >
                  <PercentStat
                    percent={cards.inviteDelivery.successRatePercent}
                    numerator={cards.inviteDelivery.inviteCreated}
                    denominator={cards.inviteDelivery.paidOrders}
                    numeratorLabel="当月邀请记录数"
                    denominatorLabel="当月付费订单数"
                  />
                  <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                    {cards.inviteDelivery.description}
                  </Paragraph>
                </Card>
              </Col>

              <Col xs={24} sm={12} lg={8}>
                <Card
                  bordered
                  title={
                    <Space>
                      <CustomerServiceOutlined style={{ color: "#f5222d" }} />
                      退款与工单率
                    </Space>
                  }
                  extra={
                    <Tooltip title="(当月已退款订单数 + 当月未关闭/未解决的有效工单数) / 当月付费订单数。越低越好。">
                      <InfoCircleOutlined style={{ color: "#bbb" }} />
                    </Tooltip>
                  }
                >
                  <PercentStat
                    percent={cards.supportAndRefund.ratioPercent}
                    numerator={cards.supportAndRefund.refundedPaidOrders + cards.supportAndRefund.openTickets}
                    denominator={cards.packagePurchase.allPaidOrders}
                    numeratorLabel="退款订单 + 未结工单"
                    denominatorLabel="当月付费订单"
                  />
                  <Row style={{ marginTop: 4 }}>
                    <Col span={12}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        退款订单：
                      </Text>
                      <Text strong style={{ fontSize: 12 }}>
                        {cards.supportAndRefund.refundedPaidOrders}
                      </Text>
                    </Col>
                    <Col span={12}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        未结工单：
                      </Text>
                      <Text strong style={{ fontSize: 12 }}>
                        {cards.supportAndRefund.openTickets}
                      </Text>
                    </Col>
                  </Row>
                  <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                    {cards.supportAndRefund.description}
                  </Paragraph>
                </Card>
              </Col>
            </Row>

            <Alert
              type="info"
              showIcon
              icon={<RocketOutlined />}
              message="阶段二独立 VOD 立项参考阈值"
              description={
                <Space direction="vertical" size={2} style={{ width: "100%" }}>
                  <div>
                    <Tag color="purple">门槛 1</Tag> 稳定付费会员 ≥{" "}
                    <Text strong>{data.stage2Readiness.stablePaidMembershipThreshold}</Text> 人
                  </div>
                  <div>
                    <Tag color="green">门槛 2</Tag> 月 GMV ≥{" "}
                    <Text strong>{data.stage2Readiness.monthlyGmvUsdtThreshold}</Text> USDT（或 Stars 等值换算）
                  </div>
                  <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                    {data.stage2Readiness.note}
                  </Paragraph>
                </Space>
              }
            />
          </>
        )}
      </Space>
    </Spin>
  );
};

export default DashboardPage;
