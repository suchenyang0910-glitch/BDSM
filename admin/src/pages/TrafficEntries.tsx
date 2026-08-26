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
  Segmented,
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
  createAdminTrafficEntry,
  errMsg,
  listAdminCategories,
  listAdminContents,
  listAdminPackages,
  listAdminTrafficEntries,
  updateAdminTrafficEntry,
} from "../api/client";
import type {
  AdminMe,
  AdminTrafficEntryItem,
  CategoryItem,
  ContentItem,
  CreateAdminTrafficEntryInput,
  TrafficEntryDestinationType,
  TrafficEntryStatus,
  TrafficEntryType,
  UpdateAdminTrafficEntryInput,
} from "../api/types";

const { Title, Text } = Typography;

const ENTRY_TYPE_LABEL: Record<TrafficEntryType, string> = {
  telegram_channel: "Telegram 频道",
  telegram_bot: "Telegram Bot",
  web: "网页外链",
  facebook: "Facebook",
  x: "X",
  partner: "合作方",
};

const DESTINATION_TYPE_LABEL: Record<TrafficEntryDestinationType, string> = {
  content: "内容详情",
  category: "分类页",
  package: "内容包",
  membership: "会员页",
};

const STATUS_LABEL: Record<TrafficEntryStatus, string> = {
  active: "启用",
  inactive: "停用",
};

type PackageOption = { id: string; title: string };

const TrafficEntriesPage: React.FC = () => {
  const [preset, setPreset] = React.useState<"7d" | "30d">("7d");
  const [statusFilter, setStatusFilter] = React.useState<TrafficEntryStatus | "all">("all");
  const [query, setQuery] = React.useState("");
  const [rows, setRows] = React.useState<AdminTrafficEntryItem[]>([]);
  const [summary, setSummary] = React.useState<{ total: number; active: number; opens: number; paymentsConfirmed: number } | null>(null);
  const [privacy, setPrivacy] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminTrafficEntryItem | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [me, setMe] = React.useState<AdminMe | null>(null);
  const [contents, setContents] = React.useState<ContentItem[]>([]);
  const [categories, setCategories] = React.useState<CategoryItem[]>([]);
  const [packages, setPackages] = React.useState<PackageOption[]>([]);
  const [form] = Form.useForm<CreateAdminTrafficEntryInput>();

  const canEdit = React.useMemo(() => !!me && ["super_admin", "operator", "editor"].includes(me.role), [me]);
  const destinationType = Form.useWatch("destinationType", form) as TrafficEntryDestinationType | undefined;

  const loadMeta = React.useCallback(async () => {
    try {
      const [meResp, contentResp, categoryResp, packageResp] = await Promise.allSettled([
        adminMe(),
        listAdminContents({ page: 1, limit: 100 }),
        listAdminCategories(),
        listAdminPackages(),
      ]);
      if (meResp.status === "fulfilled") setMe(meResp.value);
      if (contentResp.status === "fulfilled") setContents(contentResp.value.data || []);
      if (categoryResp.status === "fulfilled") setCategories(categoryResp.value.data || []);
      if (packageResp.status === "fulfilled") {
        setPackages((packageResp.value.data || []).map((item) => ({ id: item.id, title: item.title })));
      }
    } catch {
      // 由主列表加载统一报错
    }
  }, []);

  const loadList = React.useCallback(async () => {
    setLoading(true);
    try {
      const resp = await listAdminTrafficEntries({
        preset,
        q: query.trim() || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
      });
      setRows(resp.items);
      setSummary(resp.summary);
      setPrivacy(resp.privacy);
    } catch (e) {
      message.error(errMsg(e, "加载流量入口失败"));
    } finally {
      setLoading(false);
    }
  }, [preset, query, statusFilter]);

  React.useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  React.useEffect(() => {
    void loadList();
  }, [loadList]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      status: "active",
      entryType: "web",
      destinationType: "content",
      destinationId: undefined,
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: AdminTrafficEntryItem) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      code: row.code,
      status: row.status,
      entryType: row.entryType,
      destinationType: row.destinationType,
      destinationId: row.destinationType === "membership" ? undefined : row.destinationId,
      note: row.note || undefined,
    });
    setDrawerOpen(true);
  };

  const submitDrawer = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload: CreateAdminTrafficEntryInput | UpdateAdminTrafficEntryInput = {
        ...values,
        destinationId: values.destinationType === "membership" ? null : values.destinationId || null,
        reason: editing ? `更新流量入口：${values.name}` : `创建流量入口：${values.name}`,
      };
      if (editing) {
        await updateAdminTrafficEntry(editing.id, payload);
        message.success("流量入口已更新");
      } else {
        await createAdminTrafficEntry(payload);
        message.success("流量入口已创建");
      }
      setDrawerOpen(false);
      void loadList();
    } catch (e) {
      message.error(errMsg(e, editing ? "更新失败" : "创建失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const renderDestinationSelect = () => {
    if (destinationType === "membership") {
      return <Alert type="info" showIcon message="会员页无需额外目标 ID，系统会生成会员落地链接。" />;
    }
    if (destinationType === "content") {
      return (
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="选择要落地的内容"
          options={contents.map((item) => ({ value: item.id, label: `${item.title} (${item.status})` }))}
        />
      );
    }
    if (destinationType === "category") {
      return (
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="选择目标分类"
          options={categories.map((item) => ({ value: item.id, label: item.name }))}
        />
      );
    }
    return (
      <Select
        showSearch
        optionFilterProp="label"
        placeholder="选择目标内容包"
        options={packages.map((item) => ({ value: item.id, label: item.title }))}
      />
    );
  };

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>流量入口</Title>
          <Text type="secondary">配置渠道代码、生成投放链接，并按匿名会话查看入口转化。</Text>
        </div>
        <Space wrap>
          <Segmented value={preset} options={[{ label: "近 7 天", value: "7d" }, { label: "近 30 天", value: "30d" }]} onChange={(v) => setPreset(v as "7d" | "30d")} />
          <Button icon={<PlusOutlined />} type="primary" onClick={openCreate} disabled={!canEdit}>新建入口</Button>
        </Space>
      </div>

      {privacy && <Alert type="info" showIcon message={privacy} />}

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}><Card><Statistic title="入口总数" value={summary?.total || 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="启用中" value={summary?.active || 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="入口打开" value={summary?.opens || 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="确认支付" value={summary?.paymentsConfirmed || 0} /></Card></Col>
      </Row>

      <Card
        title={<Title level={5} style={{ margin: 0 }}>渠道配置与归因</Title>}
        extra={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="搜索名称、代码、备注"
              style={{ width: 260 }}
              onSearch={(value) => setQuery(value)}
              onChange={(event) => setQuery(event.target.value)}
              value={query}
            />
            <Select
              value={statusFilter}
              style={{ width: 140 }}
              onChange={(value) => setStatusFilter(value)}
              options={[
                { value: "all", label: "全部状态" },
                { value: "active", label: "仅启用" },
                { value: "inactive", label: "仅停用" },
              ]}
            />
          </Space>
        }
      >
        <Table<AdminTrafficEntryItem>
          rowKey="id"
          loading={loading}
          size="middle"
          scroll={{ x: 1480 }}
          dataSource={rows}
          locale={{ emptyText: <Empty description="还没有配置流量入口" /> }}
          pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 个入口` }}
          columns={[
            {
              title: "入口",
              key: "entry",
              width: 220,
              render: (_, row) => (
                <Space direction="vertical" size={2}>
                  <Text strong>{row.name}</Text>
                  <Text code copyable>{row.code}</Text>
                  <Space size={4} wrap>
                    <Tag color={row.status === "active" ? "green" : "default"}>{STATUS_LABEL[row.status]}</Tag>
                    <Tag>{ENTRY_TYPE_LABEL[row.entryType]}</Tag>
                  </Space>
                </Space>
              ),
            },
            {
              title: "落地目标",
              key: "destination",
              width: 220,
              render: (_, row) => (
                <Space direction="vertical" size={2}>
                  <Text>{DESTINATION_TYPE_LABEL[row.destinationType]}</Text>
                  <Text type="secondary">{row.destinationLabel}</Text>
                </Space>
              ),
            },
            {
              title: "链接生成",
              key: "links",
              width: 320,
              render: (_, row) => (
                <Space direction="vertical" size={2}>
                  <Text code copyable={{ text: row.links.h5 }} style={{ fontSize: 12 }}>H5 链接</Text>
                  <Text code copyable={{ text: row.links.miniApp }} style={{ fontSize: 12 }}>Mini App 链接</Text>
                </Space>
              ),
            },
            { title: "打开", dataIndex: ["metrics", "opens"], width: 80 },
            { title: "详情打开", dataIndex: ["metrics", "contentOpened"], width: 90 },
            { title: "试看开始", dataIndex: ["metrics", "previewStarted"], width: 90 },
            { title: "收银台", dataIndex: ["metrics", "checkoutOpen"], width: 90 },
            { title: "确认支付", dataIndex: ["metrics", "paymentConfirmed"], width: 90 },
            { title: "首次完整播放", dataIndex: ["metrics", "playbackStarted"], width: 110 },
            {
              title: "更新时间",
              dataIndex: "updatedAt",
              width: 140,
              render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm"),
            },
            {
              title: "操作",
              key: "actions",
              fixed: "right",
              width: 100,
              render: (_, row) => (
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} disabled={!canEdit}>
                  编辑
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={editing ? `编辑入口：${editing.name}` : "新建流量入口"}
        width={520}
        open={drawerOpen}
        onClose={() => !submitting && setDrawerOpen(false)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)} disabled={submitting}>取消</Button>
            <Button type="primary" loading={submitting} onClick={submitDrawer} disabled={!canEdit}>
              {editing ? "保存" : "创建"}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="name" label="入口名称" rules={[{ required: true, message: "请输入入口名称" }]}>
            <Input placeholder="例如：Telegram 频道头图 2026Q3" maxLength={120} />
          </Form.Item>
          <Form.Item
            name="code"
            label="渠道代码"
            rules={[
              { required: true, message: "请输入渠道代码" },
              { pattern: /^[a-z0-9][a-z0-9_-]{1,63}$/, message: "仅允许小写字母、数字、下划线、短横线" },
            ]}
          >
            <Input placeholder="例如：tg_channel_q3_launch" maxLength={64} />
          </Form.Item>
          <Space size={16} style={{ width: "100%" }}>
            <Form.Item name="entryType" label="入口类型" style={{ flex: 1 }} rules={[{ required: true, message: "请选择入口类型" }]}>
              <Select options={(Object.keys(ENTRY_TYPE_LABEL) as TrafficEntryType[]).map((value) => ({ value, label: ENTRY_TYPE_LABEL[value] }))} />
            </Form.Item>
            <Form.Item name="status" label="状态" style={{ flex: 1 }} rules={[{ required: true, message: "请选择状态" }]}>
              <Select options={(Object.keys(STATUS_LABEL) as TrafficEntryStatus[]).map((value) => ({ value, label: STATUS_LABEL[value] }))} />
            </Form.Item>
          </Space>
          <Form.Item name="destinationType" label="落地目标类型" rules={[{ required: true, message: "请选择落地目标类型" }]}>
            <Select options={(Object.keys(DESTINATION_TYPE_LABEL) as TrafficEntryDestinationType[]).map((value) => ({ value, label: DESTINATION_TYPE_LABEL[value] }))} />
          </Form.Item>
          <Form.Item
            name="destinationId"
            label="落地目标"
            rules={destinationType === "membership" ? [] : [{ required: true, message: "请选择落地目标" }]}
          >
            {renderDestinationSelect()}
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={4} placeholder="记录投放位置、素材版本、合作方说明等" maxLength={500} showCount />
          </Form.Item>
        </Form>
      </Drawer>
    </Space>
  );
};

export default TrafficEntriesPage;
