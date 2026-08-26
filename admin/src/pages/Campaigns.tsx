import React from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Form,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { EditOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import {
  adminMe,
  createAdminCampaign,
  errMsg,
  listAdminBanners,
  listAdminCampaigns,
  listAdminTrafficEntries,
  updateAdminCampaign,
} from "../api/client";
import type {
  AdminCampaignItem,
  AdminMe,
  AdminTrafficEntryItem,
  BannerItem,
  CampaignStatus,
  CreateAdminCampaignInput,
  UpdateAdminCampaignInput,
} from "../api/types";

const { Title, Text } = Typography;

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "草稿",
  scheduled: "待投放",
  active: "进行中",
  paused: "已暂停",
  archived: "已归档",
};

const STATUS_COLOR: Record<CampaignStatus, string> = {
  draft: "default",
  scheduled: "processing",
  active: "green",
  paused: "warning",
  archived: "default",
};

function toDatetimeLocal(value: string | null | undefined) {
  return value ? dayjs(value).format("YYYY-MM-DDTHH:mm") : undefined;
}

const CampaignsPage: React.FC = () => {
  const [rows, setRows] = React.useState<AdminCampaignItem[]>([]);
  const [summary, setSummary] = React.useState<{ total: number; active: number; scheduled: number; paymentsConfirmed: number } | null>(null);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<CampaignStatus | "all">("all");
  const [loading, setLoading] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminCampaignItem | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [me, setMe] = React.useState<AdminMe | null>(null);
  const [banners, setBanners] = React.useState<BannerItem[]>([]);
  const [trafficEntries, setTrafficEntries] = React.useState<AdminTrafficEntryItem[]>([]);
  const [form] = Form.useForm<CreateAdminCampaignInput>();

  const canEdit = React.useMemo(() => !!me && ["super_admin", "operator", "editor"].includes(me.role), [me]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const resp = await listAdminCampaigns({
        q: query.trim() || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
      });
      setRows(resp.items);
      setSummary(resp.summary);
    } catch (e) {
      message.error(errMsg(e, "加载活动管理失败"));
    } finally {
      setLoading(false);
    }
  }, [query, statusFilter]);

  const loadPickers = React.useCallback(async () => {
    try {
      const [meResp, bannerResp, trafficResp] = await Promise.all([
        adminMe(),
        listAdminBanners(),
        listAdminTrafficEntries(),
      ]);
      setMe(meResp);
      setBanners(bannerResp.data || []);
      setTrafficEntries(trafficResp.items || []);
    } catch {
      // ignore picker failure; main save path会给出报错
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    void loadPickers();
  }, [loadPickers]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      status: "draft",
      bannerIds: [],
      trafficEntryIds: [],
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: AdminCampaignItem) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      code: row.code,
      status: row.status,
      summary: row.summary || undefined,
      startsAt: toDatetimeLocal(row.startsAt),
      endsAt: toDatetimeLocal(row.endsAt),
      bannerIds: row.banners.map((item) => item.id),
      trafficEntryIds: row.trafficEntries.map((item) => item.id),
    });
    setDrawerOpen(true);
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      if (values.startsAt && values.endsAt && dayjs(values.startsAt).isAfter(dayjs(values.endsAt))) {
        message.error("活动开始时间不能晚于结束时间");
        return;
      }
      setSubmitting(true);
      const payload: CreateAdminCampaignInput | UpdateAdminCampaignInput = {
        name: values.name,
        code: values.code,
        status: values.status,
        summary: values.summary || null,
        startsAt: values.startsAt ? dayjs(values.startsAt).toISOString() : null,
        endsAt: values.endsAt ? dayjs(values.endsAt).toISOString() : null,
        bannerIds: values.bannerIds || [],
        trafficEntryIds: values.trafficEntryIds || [],
        reason: editing ? `更新活动：${values.name}` : `创建活动：${values.name}`,
      };
      if (editing) {
        await updateAdminCampaign(editing.id, payload);
        message.success("活动已更新");
      } else {
        await createAdminCampaign(payload);
        message.success("活动已创建");
      }
      setDrawerOpen(false);
      void load();
    } catch (e) {
      message.error(errMsg(e, editing ? "更新活动失败" : "创建活动失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>活动管理</Title>
          <Text type="secondary">把 Banner 和流量入口收拢到同一个活动容器里，按活动维度看投放效果。</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!canEdit}>新建活动</Button>
      </div>

      <Alert type="info" showIcon message="活动口径说明" description="活动归因基于所绑定的 TrafficEntry 聚合；Banner 仅作为投放资源编组，不单独生成转化。" />

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}><Card><Statistic title="活动总数" value={summary?.total || 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="进行中" value={summary?.active || 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="待投放" value={summary?.scheduled || 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="确认支付" value={summary?.paymentsConfirmed || 0} /></Card></Col>
      </Row>

      <Card
        extra={
          <Space wrap>
            <Input.Search
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onSearch={() => void load()}
              placeholder="搜索活动名称、代码、摘要"
              allowClear
              style={{ width: 260 }}
            />
            <Select
              value={statusFilter}
              onChange={(value) => setStatusFilter(value)}
              style={{ width: 140 }}
              options={[
                { value: "all", label: "全部状态" },
                { value: "draft", label: "草稿" },
                { value: "scheduled", label: "待投放" },
                { value: "active", label: "进行中" },
                { value: "paused", label: "已暂停" },
                { value: "archived", label: "已归档" },
              ]}
            />
          </Space>
        }
      >
        <Table<AdminCampaignItem>
          rowKey="id"
          loading={loading}
          dataSource={rows}
          locale={{ emptyText: <Empty description="还没有活动配置" /> }}
          scroll={{ x: 1480 }}
          pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 个活动` }}
          columns={[
            {
              title: "活动",
              width: 220,
              render: (_: unknown, row) => (
                <Space direction="vertical" size={2}>
                  <Text strong>{row.name}</Text>
                  <Text code copyable>{row.code}</Text>
                  <Tag color={STATUS_COLOR[row.status]}>{STATUS_LABEL[row.status]}</Tag>
                </Space>
              ),
            },
            {
              title: "时间窗口",
              width: 180,
              render: (_: unknown, row) => (
                <Space direction="vertical" size={2}>
                  <Text>{row.startsAt ? dayjs(row.startsAt).format("YYYY-MM-DD HH:mm") : "未设置开始"}</Text>
                  <Text type="secondary">{row.endsAt ? dayjs(row.endsAt).format("YYYY-MM-DD HH:mm") : "未设置结束"}</Text>
                </Space>
              ),
            },
            {
              title: "Banner 编组",
              width: 240,
              render: (_: unknown, row) => row.banners.length ? (
                <Space wrap>{row.banners.map((item) => <Tag key={item.id}>{item.title}</Tag>)}</Space>
              ) : "未绑定",
            },
            {
              title: "流量入口",
              width: 260,
              render: (_: unknown, row) => row.trafficEntries.length ? (
                <Space wrap>{row.trafficEntries.map((item) => <Tag key={item.id}>{item.name}</Tag>)}</Space>
              ) : "未绑定",
            },
            { title: "入口打开", dataIndex: ["metrics", "opens"], width: 90 },
            { title: "详情打开", dataIndex: ["metrics", "contentOpened"], width: 90 },
            { title: "收银台", dataIndex: ["metrics", "checkoutOpen"], width: 90 },
            { title: "确认支付", dataIndex: ["metrics", "paymentConfirmed"], width: 90 },
            { title: "首次完整播放", dataIndex: ["metrics", "playbackStarted"], width: 110 },
            { title: "更新时间", dataIndex: "updatedAt", width: 150, render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm") },
            {
              title: "操作",
              width: 100,
              fixed: "right",
              render: (_: unknown, row) => (
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} disabled={!canEdit}>
                  编辑
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={editing ? `编辑活动：${editing.name}` : "新建活动"}
        open={drawerOpen}
        width={560}
        destroyOnClose
        onClose={() => !submitting && setDrawerOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)} disabled={submitting}>取消</Button>
            <Button type="primary" loading={submitting} onClick={submit} disabled={!canEdit}>
              {editing ? "保存" : "创建"}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="活动名称" rules={[{ required: true, message: "请输入活动名称" }]}>
            <Input maxLength={120} placeholder="例如：Q3 Stars 限时转化活动" />
          </Form.Item>
          <Form.Item
            name="code"
            label="活动代码"
            rules={[
              { required: true, message: "请输入活动代码" },
              { pattern: /^[a-z0-9][a-z0-9_-]{1,63}$/, message: "仅允许小写字母、数字、下划线、短横线" },
            ]}
          >
            <Input maxLength={64} placeholder="例如：q3_stars_conversion" />
          </Form.Item>
          <Form.Item name="status" label="活动状态" rules={[{ required: true, message: "请选择活动状态" }]}>
            <Select options={(Object.keys(STATUS_LABEL) as CampaignStatus[]).map((value) => ({ value, label: STATUS_LABEL[value] }))} />
          </Form.Item>
          <Form.Item name="summary" label="活动摘要">
            <Input.TextArea rows={4} maxLength={500} showCount placeholder="记录活动目标、人群、素材版本与执行说明" />
          </Form.Item>
          <Form.Item name="startsAt" label="开始时间">
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="endsAt" label="结束时间">
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item name="bannerIds" label="关联 Banner">
            <Select
              mode="multiple"
              optionFilterProp="label"
              placeholder="选择要纳入活动的 Banner"
              options={banners.map((item) => ({ value: item.id, label: `${item.title} (${item.status})` }))}
            />
          </Form.Item>
          <Form.Item name="trafficEntryIds" label="关联流量入口">
            <Select
              mode="multiple"
              optionFilterProp="label"
              placeholder="选择要归属到该活动的流量入口"
              options={trafficEntries.map((item) => ({ value: item.id, label: `${item.name} (${item.code})` }))}
            />
          </Form.Item>
        </Form>
      </Drawer>
    </Space>
  );
};

export default CampaignsPage;
