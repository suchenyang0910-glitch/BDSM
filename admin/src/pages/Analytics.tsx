import React from "react";
import { Alert, Card, Col, Empty, Progress, Row, Segmented, Space, Spin, Statistic, Table, Typography } from "antd";
import { BarChartOutlined, ReloadOutlined, UserOutlined, VideoCameraOutlined, WalletOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { errMsg, getAdminAnalyticsOverview } from "../api/client";
import type { AdminAnalyticsOverview } from "../api/types";

const { Title, Text } = Typography;

const EVENT_LABEL: Record<string, string> = {
  session_started: "建立会话",
  content_opened: "打开视频详情",
  unlock_clicked: "点击解锁",
  order_created: "创建订单",
  payment_confirmed: "确认支付",
};

const PLATFORM_LABEL: Record<string, string> = { h5: "H5", telegram_mini_app: "Telegram Mini App", server: "服务端", unknown: "未知" };

const AnalyticsPage: React.FC = () => {
  const [preset, setPreset] = React.useState<"7d" | "30d">("7d");
  const [data, setData] = React.useState<AdminAnalyticsOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getAdminAnalyticsOverview(preset)); }
    catch (e) { setError(errMsg(e, "加载数据分析失败")); }
    finally { setLoading(false); }
  }, [preset]);
  React.useEffect(() => { void load(); }, [load]);
  return <Spin spinning={loading} tip="正在汇总匿名运营数据…">
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><Title level={3} style={{ margin: 0 }}>数据分析</Title><Text type="secondary">用户漏斗、入口表现与偏好聚合</Text></div>
        <Segmented value={preset} options={[{ label: "近 7 天", value: "7d" }, { label: "近 30 天", value: "30d" }]} onChange={(v) => setPreset(v as "7d" | "30d")} />
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      {data && <>
        <Alert type="info" showIcon message={data.privacy} />
        <Row gutter={[16, 16]}>
          <Col xs={12} lg={6}><Card><Statistic title="会话数" value={data.totals.sessions} prefix={<UserOutlined />} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="视频详情打开" value={data.totals.contentOpened} prefix={<VideoCameraOutlined />} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="确认支付" value={data.totals.paymentsConfirmed} prefix={<WalletOutlined />} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="采集事件" value={data.totals.eventCount} prefix={<BarChartOutlined />} /></Card></Col>
        </Row>
        <Card title="用户转化漏斗" extra={<Text type="secondary">基于去重会话；支付确认以有效用户会话计算</Text>}>
          <Row gutter={[16, 16]}>{data.funnel.map((item) => <Col xs={24} md={12} lg={8} key={item.eventName}><Card size="small"><Space direction="vertical" style={{ width: "100%" }} size={4}><Text strong>{EVENT_LABEL[item.eventName] || item.eventName}</Text><Statistic value={item.value} /><Progress percent={item.conversionFromStart} size="small" format={(v) => `${v}%`} /></Space></Card></Col>)}</Row>
        </Card>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}><Card title="每日趋势"><Table rowKey="date" size="small" pagination={false} dataSource={data.trend} locale={{ emptyText: <Empty description="尚无采集数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[{ title: "日期", dataIndex: "date" }, { title: "会话", dataIndex: "sessions" }, { title: "打开详情", dataIndex: "contentOpened" }, { title: "确认支付", dataIndex: "paymentsConfirmed" }]} /></Card></Col>
          <Col xs={24} lg={12}><Card title="用户偏好聚合"><Table rowKey={(r) => `${r.preferenceType}:${r.valueKey}`} size="small" pagination={{ pageSize: 8 }} dataSource={data.preferences} locale={{ emptyText: <Empty description="用户尚未提交偏好" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[{ title: "偏好类型", dataIndex: "preferenceType" }, { title: "选项", dataIndex: "valueKey" }, { title: "选择用户数", dataIndex: "selectedUsers" }]} /></Card></Col>
        </Row>
        <Card title="入口与设备"><Space wrap>{data.platforms.length ? data.platforms.map((row) => <Card size="small" key={row.platform}><Statistic title={PLATFORM_LABEL[row.platform] || row.platform} value={row.eventCount} suffix="事件" /></Card>) : <Empty description="尚无入口数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />}</Space></Card>
        <Text type="secondary">统计区间：{dayjs(data.period.from).format("YYYY-MM-DD HH:mm")} 至 {dayjs(data.period.to).format("YYYY-MM-DD HH:mm")}</Text>
      </>}
    </Space>
  </Spin>;
};

export default AnalyticsPage;
