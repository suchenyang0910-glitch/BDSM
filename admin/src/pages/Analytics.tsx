import React from "react";
import { Alert, Card, Col, Empty, Progress, Row, Segmented, Space, Spin, Statistic, Table, Tag, Typography } from "antd";
import { BarChartOutlined, ReloadOutlined, UserOutlined, VideoCameraOutlined, WalletOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { errMsg, getAdminAnalyticsOverview, getAdminGoogleAnalyticsIntegration } from "../api/client";
import type { AdminAnalyticsOverview, AdminGoogleAnalyticsIntegration } from "../api/types";

const { Title, Text } = Typography;

const EVENT_LABEL: Record<string, string> = {
  session_started: "建立会话",
  content_opened: "打开视频详情",
  preview_started: "开始试看",
  preview_completed: "试看结束",
  checkout_open: "打开收银台",
  payment_confirmed: "确认支付",
  playback_started: "首次完整播放",
};

const PLATFORM_LABEL: Record<string, string> = { h5: "H5", telegram_mini_app: "Telegram Mini App", server: "服务端", unknown: "未知" };

const AnalyticsPage: React.FC = () => {
  const [preset, setPreset] = React.useState<"7d" | "30d">("7d");
  const [data, setData] = React.useState<AdminAnalyticsOverview | null>(null);
  const [googleIntegration, setGoogleIntegration] = React.useState<AdminGoogleAnalyticsIntegration | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [overview, integration] = await Promise.all([getAdminAnalyticsOverview(preset), getAdminGoogleAnalyticsIntegration()]);
      setData(overview); setGoogleIntegration(integration);
    }
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
      {googleIntegration && <Card title="Google Analytics 集成">
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Space wrap><Text>网页标签：{googleIntegration.webTag.measurementId}</Text><Tag color={googleIntegration.webTag.configured ? "success" : "warning"}>{googleIntegration.webTag.configured ? "已启用" : "未配置"}</Tag></Space>
          <Space wrap><Text>Measurement Protocol API 密钥</Text><Tag color={googleIntegration.measurementProtocol.configured ? "success" : "warning"}>{googleIntegration.measurementProtocol.configured ? "已配置" : "待配置"}</Tag><Text type="secondary">仅服务端环境变量保存</Text></Space>
          <Text type="secondary">{googleIntegration.message}</Text>
        </Space>
      </Card>}
      {data && <>
        <Alert type="info" showIcon message={data.privacy} />
        <Row gutter={[16, 16]}>
          <Col xs={12} lg={6}><Card><Statistic title="会话数" value={data.totals.sessions} prefix={<UserOutlined />} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="视频详情打开" value={data.totals.contentOpened} prefix={<VideoCameraOutlined />} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="确认支付" value={data.totals.paymentsConfirmed} prefix={<WalletOutlined />} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="采集事件" value={data.totals.eventCount} prefix={<BarChartOutlined />} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="视频浏览" value={data.totals.videoOpened} prefix={<VideoCameraOutlined />} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="完整播放率" value={data.totals.videoPlayRate} suffix="%" /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="文章查看" value={data.totals.articleViews} /></Card></Col>
        </Row>
        <Card title="用户转化漏斗" extra={<Text type="secondary">基于去重会话；从试看到完整播放按统一收银台口径汇总</Text>}>
          <Row gutter={[16, 16]}>{data.funnel.map((item) => <Col xs={24} md={12} lg={8} key={item.eventName}><Card size="small"><Space direction="vertical" style={{ width: "100%" }} size={4}><Text strong>{EVENT_LABEL[item.eventName] || item.eventName}</Text><Statistic value={item.value} /><Progress percent={item.conversionFromStart} size="small" format={(v) => `${v}%`} /></Space></Card></Col>)}</Row>
        </Card>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card title="播放体验聚合">
              <Row gutter={[16, 16]}>
                <Col xs={12}><Statistic title="首帧样本" value={data.playback.firstFrame.total} /></Col>
                <Col xs={12}><Statistic title="预取命中率" value={data.playback.prefetch.hitRate} suffix="%" /></Col>
                <Col xs={12}><Statistic title="缓冲开始" value={data.playback.buffering.starts} /></Col>
                <Col xs={12}><Statistic title="缓冲结束" value={data.playback.buffering.ends} /></Col>
              </Row>
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card title="预取结果">
              <Space wrap>
                <Card size="small"><Statistic title="命中" value={data.playback.prefetch.hit} /></Card>
                <Card size="small"><Statistic title="未命中" value={data.playback.prefetch.miss} /></Card>
                <Card size="small"><Statistic title="错误" value={data.playback.prefetch.error} /></Card>
              </Space>
            </Card>
          </Col>
        </Row>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}><Card title="用户来源"><Table rowKey="source" size="small" pagination={false} dataSource={data.sources} locale={{ emptyText: <Empty description="尚无来源会话" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[{ title: "来源", dataIndex: "source" }, { title: "去重用户", dataIndex: "users" }, { title: "去重会话", dataIndex: "sessions" }]} /></Card></Col>
          <Col xs={24} lg={12}><Card title="文章查看 Top 20"><Table rowKey="articleSlug" size="small" pagination={{ pageSize: 8 }} dataSource={data.articleViews} locale={{ emptyText: <Empty description="尚无文章查看" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[{ title: "文章", dataIndex: "articleSlug" }, { title: "查看", dataIndex: "views" }, { title: "去重读者", dataIndex: "readers" }]} /></Card></Col>
        </Row>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}><Card title="每日趋势"><Table rowKey="date" size="small" pagination={false} dataSource={data.trend} locale={{ emptyText: <Empty description="尚无采集数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[{ title: "日期", dataIndex: "date" }, { title: "会话", dataIndex: "sessions" }, { title: "打开详情", dataIndex: "contentOpened" }, { title: "确认支付", dataIndex: "paymentsConfirmed" }]} /></Card></Col>
          <Col xs={24} lg={12}><Card title="用户偏好聚合"><Table rowKey={(r) => `${r.preferenceType}:${r.valueKey}`} size="small" pagination={{ pageSize: 8 }} dataSource={data.preferences} locale={{ emptyText: <Empty description="用户尚未提交偏好" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[{ title: "偏好类型", dataIndex: "preferenceType" }, { title: "选项", dataIndex: "valueKey" }, { title: "选择用户数", dataIndex: "selectedUsers" }]} /></Card></Col>
        </Row>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}><Card title="首帧时间分桶"><Table rowKey="bucket" size="small" pagination={false} dataSource={data.playback.firstFrame.buckets} locale={{ emptyText: <Empty description="尚无首帧样本" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[{ title: "分桶", dataIndex: "bucket" }, { title: "次数", dataIndex: "value" }]} /></Card></Col>
          <Col xs={24} lg={12}><Card title="卡顿时长分桶"><Table rowKey="bucket" size="small" pagination={false} dataSource={data.playback.buffering.buckets} locale={{ emptyText: <Empty description="尚无卡顿样本" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[{ title: "分桶", dataIndex: "bucket" }, { title: "次数", dataIndex: "value" }]} /></Card></Col>
        </Row>
        <Card title="清晰度切换 Top 8"><Table rowKey="transition" size="small" pagination={false} dataSource={data.playback.qualityChanges} locale={{ emptyText: <Empty description="尚无清晰度切换数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} columns={[{ title: "切换路径", dataIndex: "transition" }, { title: "次数", dataIndex: "value" }]} /></Card>
        <Card title="入口与设备"><Space wrap>{data.platforms.length ? data.platforms.map((row) => <Card size="small" key={row.platform}><Statistic title={PLATFORM_LABEL[row.platform] || row.platform} value={row.eventCount} suffix="事件" /></Card>) : <Empty description="尚无入口数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />}</Space></Card>
        <Text type="secondary">统计区间：{dayjs(data.period.from).format("YYYY-MM-DD HH:mm")} 至 {dayjs(data.period.to).format("YYYY-MM-DD HH:mm")}</Text>
      </>}
    </Space>
  </Spin>;
};

export default AnalyticsPage;
