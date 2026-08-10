import React from "react";
import {
  Card,
  Typography,
  Tag,
  Space,
  Button,
  Table,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  message,
  Modal,
  DatePicker,
} from "antd";
import { PlusOutlined, EditOutlined, SendOutlined, UpCircleOutlined, DownCircleOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import {
  listAdminContents,
  createAdminContent,
  updateAdminContent,
  submitContentForReview,
  publishAdminContent,
  unpublishAdminContent,
  listAdminCategories,
  adminMe,
  errMsg,
} from "../api/client";
import type { ContentItem, ContentStatus, CategoryItem, AdminMe } from "../api/types";

const { Title } = Typography;
const { TextArea } = Input;
const { Option } = Select;

const STATUS_TAG: Record<ContentStatus, { color: string; label: string }> = {
  draft: { color: "default", label: "草稿" },
  in_review: { color: "processing", label: "审核中" },
  scheduled: { color: "geekblue", label: "定时发布" },
  published: { color: "green", label: "已发布" },
  archived: { color: "grey", label: "归档" },
};

const ACCESS_TYPE_OPTIONS = [
  { value: "public", label: "公开免费" },
  { value: "single", label: "单篇购买" },
  { value: "membership", label: "会员专享" },
  { value: "package", label: "打包内含" },
];

const ContentsPage: React.FC = () => {
  const [rows, setRows] = React.useState<ContentItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);
  const [statusFilter, setStatusFilter] = React.useState<ContentStatus | undefined>();
  const [q, setQ] = React.useState("");

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ContentItem | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = React.useState(false);

  const [categories, setCategories] = React.useState<CategoryItem[]>([]);
  const [me, setMe] = React.useState<AdminMe | null>(null);

  const fetchList = React.useCallback(async () => {
    setLoading(true);
    try {
      const resp = await listAdminContents({
        page,
        limit: pageSize,
        status: statusFilter,
        q: q || undefined,
      });
      setRows(resp.data);
      setTotal(resp.total);
    } catch (e) {
      message.error(errMsg(e, "加载内容列表失败"));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter, q]);

  React.useEffect(() => {
    fetchList();
  }, [fetchList]);

  React.useEffect(() => {
    listAdminCategories().then((r) => setCategories(r.data)).catch(() => {});
    adminMe().then(setMe).catch(() => {});
  }, []);

  const canPublish = React.useMemo(() => {
    if (!me) return false;
    return ["super_admin", "editor"].includes(me.role);
  }, [me]);

  const canEdit = React.useMemo(() => {
    if (!me) return false;
    return ["super_admin", "operator", "editor"].includes(me.role);
  }, [me]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      accessType: "public",
      status: "draft",
      sortOrder: 0,
      isRecommended: false,
      isFeatured: false,
      isNewArrival: false,
      tags: [],
      categoryIds: [],
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: ContentItem) => {
    setEditing(row);
    form.setFieldsValue({
      title: row.title,
      description: row.description,
      coverUrl: row.coverUrl,
      thumbnailUrl: row.thumbnailUrl,
      previewUrl: row.previewUrl,
      durationSeconds: row.durationSeconds,
      accessType: row.accessType,
      sortOrder: row.sortOrder,
      isRecommended: row.isRecommended,
      isFeatured: row.isFeatured,
      isNewArrival: row.isNewArrival,
      featuredSort: row.featuredSort,
      tags: row.tags,
      categoryIds: row.categories.map((c) => c.id),
      recommendStartsAt: row.recommendStartsAt ? dayjs(row.recommendStartsAt) : null,
      recommendEndsAt: row.recommendEndsAt ? dayjs(row.recommendEndsAt) : null,
      scheduledAt: row.scheduledAt ? dayjs(row.scheduledAt) : null,
      channelId: row.channelId,
      productId: row.productId,
      packageId: row.packageId,
    });
    setDrawerOpen(true);
  };

  const onDrawerSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload: any = {
        ...values,
        tags: values.tags || [],
        categoryIds: values.categoryIds || [],
        recommendStartsAt: values.recommendStartsAt ? values.recommendStartsAt.toISOString() : null,
        recommendEndsAt: values.recommendEndsAt ? values.recommendEndsAt.toISOString() : null,
        scheduledAt: values.scheduledAt ? values.scheduledAt.toISOString() : null,
        reason: editing ? `编辑内容：${editing.title}` : `新建内容：${values.title}`,
      };
      if (editing) {
        await updateAdminContent(editing.id, payload);
        message.success("内容已更新");
      } else {
        await createAdminContent(payload);
        message.success("内容已创建");
      }
      setDrawerOpen(false);
      fetchList();
    } catch (e) {
      message.error(errMsg(e, editing ? "更新失败" : "创建失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmSubmitReview = (row: ContentItem) => {
    Modal.confirm({
      title: "提交审核",
      content: `确定将「${row.title}」提交审核？提交后状态变更为「审核中」，需 editor 或超管发布。`,
      okText: "提交",
      cancelText: "取消",
      onOk: async () => {
        try {
          await submitContentForReview(row.id, "管理员提交审核");
          message.success("已提交审核");
          fetchList();
        } catch (e) {
          message.error(errMsg(e, "提交审核失败"));
        }
      },
    });
  };

  const confirmPublish = (row: ContentItem) => {
    Modal.confirm({
      title: "发布内容",
      content: `确定发布「${row.title}」？发布后 Mini App 用户立即可见。`,
      okText: "发布",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await publishAdminContent(row.id, "管理员发布内容");
          message.success("已发布");
          fetchList();
        } catch (e) {
          message.error(errMsg(e, "发布失败"));
        }
      },
    });
  };

  const confirmUnpublish = (row: ContentItem) => {
    Modal.confirm({
      title: "下架内容",
      content: `确定下架「${row.title}」？下架后 Mini App 用户不再可见。`,
      okText: "下架",
      cancelText: "取消",
      onOk: async () => {
        try {
          await unpublishAdminContent(row.id, "管理员下架内容");
          message.success("已下架");
          fetchList();
        } catch (e) {
          message.error(errMsg(e, "下架失败"));
        }
      },
    });
  };

  const columns: ColumnsType<ContentItem> = [
    {
      title: "标题",
      dataIndex: "title",
      key: "title",
      width: 240,
      render: (t: string, r) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontWeight: 500 }}>{t}</span>
          {r.description && (
            <span style={{ color: "#999", fontSize: 12 }}>{r.description.slice(0, 40)}{r.description.length > 40 ? "…" : ""}</span>
          )}
        </Space>
      ),
    },
    {
      title: "分类",
      dataIndex: "categories",
      key: "categories",
      width: 160,
      render: (cats: CategoryItem[]) => (
        <Space size={4} wrap>
          {cats.length === 0 ? (
            <Tag color="default">未分类</Tag>
          ) : (
            cats.map((c) => <Tag key={c.id} color="blue">{c.name}</Tag>)
          )}
        </Space>
      ),
    },
    {
      title: "访问类型",
      dataIndex: "accessType",
      key: "accessType",
      width: 100,
      render: (v: string) => {
        const m = ACCESS_TYPE_OPTIONS.find((o) => o.value === v);
        return m ? m.label : v;
      },
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (s: ContentStatus) => (
        <Tag color={STATUS_TAG[s]?.color || "default"}>{STATUS_TAG[s]?.label || s}</Tag>
      ),
    },
    {
      title: "时长",
      dataIndex: "durationSeconds",
      key: "durationSeconds",
      width: 90,
      render: (s: number | null) => {
        if (!s) return "-";
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}分${r > 0 ? `${r}秒` : ""}`;
      },
    },
    { title: "排序", dataIndex: "sortOrder", key: "sortOrder", width: 70 },
    {
      title: "运营标签",
      key: "tags",
      width: 160,
      render: (_: any, r) => (
        <Space size={4} wrap>
          {r.isRecommended && <Tag color="geekblue">推荐</Tag>}
          {r.isFeatured && <Tag color="purple">精选</Tag>}
          {r.isNewArrival && <Tag color="gold">新品</Tag>}
        </Space>
      ),
    },
    {
      title: "发布/更新",
      key: "time",
      width: 160,
      render: (_: any, r) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          <span>{r.publishedAt ? dayjs(r.publishedAt).format("YYYY-MM-DD HH:mm") : "-"}</span>
          <span style={{ color: "#999" }}>{dayjs(r.updatedAt).format("MM-DD HH:mm")}</span>
        </Space>
      ),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 260,
      render: (_: any, r) => (
        <Space size={4} wrap>
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={!canEdit}
            onClick={() => openEdit(r)}
          >
            编辑
          </Button>
          {r.status === "draft" && canEdit && (
            <Button
              size="small"
              icon={<SendOutlined />}
              onClick={() => confirmSubmitReview(r)}
            >
              提交审核
            </Button>
          )}
          {(r.status === "draft" || r.status === "in_review" || r.status === "scheduled") && canPublish && (
            <Button
              size="small"
              type="primary"
              icon={<UpCircleOutlined />}
              onClick={() => confirmPublish(r)}
            >
              发布
            </Button>
          )}
          {r.status === "published" && canPublish && (
            <Button
              size="small"
              danger
              icon={<DownCircleOutlined />}
              onClick={() => confirmUnpublish(r)}
            >
              下架
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title={<Title level={5} style={{ margin: 0 }}>内容列表</Title>}
        extra={
          <Space>
            <Input.Search
              placeholder="搜索标题/描述"
              allowClear
              style={{ width: 220 }}
              onSearch={(v) => { setQ(v); setPage(1); }}
            />
            <Select
              placeholder="状态筛选"
              allowClear
              style={{ width: 140 }}
              value={statusFilter}
              onChange={(v) => { setStatusFilter(v); setPage(1); }}
            >
              {Object.entries(STATUS_TAG).map(([k, v]) => (
                <Option key={k} value={k}>{v.label}</Option>
              ))}
            </Select>
            <Button icon={<PlusOutlined />} type="primary" onClick={openCreate} disabled={!canEdit}>
              新建内容
            </Button>
          </Space>
        }
      >
        <Table<ContentItem>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
        />
      </Card>

      <Drawer
        title={editing ? `编辑内容：${editing.title}` : "新建内容"}
        open={drawerOpen}
        onClose={() => !submitting && setDrawerOpen(false)}
        width={720}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)} disabled={submitting}>取消</Button>
            <Button type="primary" loading={submitting} onClick={onDrawerSubmit} disabled={!canEdit}>
              {editing ? "保存" : "创建"}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
            <Input placeholder="例如：呼吸与身体扫描入门" maxLength={200} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <TextArea rows={3} placeholder="在 Mini App 列表展示的简短描述" maxLength={1000} />
          </Form.Item>
          <Space size={16} style={{ width: "100%" }}>
            <Form.Item name="coverUrl" label="封面图 URL" style={{ flex: 1 }}>
              <Input placeholder="https://..." />
            </Form.Item>
            <Form.Item name="thumbnailUrl" label="缩略图 URL" style={{ flex: 1 }}>
              <Input placeholder="https://..." />
            </Form.Item>
          </Space>
          <Space size={16} style={{ width: "100%" }}>
            <Form.Item name="accessType" label="访问类型" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={ACCESS_TYPE_OPTIONS} />
            </Form.Item>
            <Form.Item name="durationSeconds" label="时长（秒）" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: "100%" }} placeholder="例如：600" />
            </Form.Item>
            <Form.Item name="sortOrder" label="排序值" style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Form.Item name="categoryIds" label="关联分类（可多选）">
            <Select mode="multiple" placeholder="选择分类">
              {categories.map((c) => (
                <Option key={c.id} value={c.id}>{c.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="输入标签后回车" />
          </Form.Item>
          <Space size={16} style={{ width: "100%" }} align="start">
            <Form.Item name="isRecommended" label="推荐位" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch />
            </Form.Item>
            <Form.Item name="isFeatured" label="精选位" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch />
            </Form.Item>
            <Form.Item name="isNewArrival" label="新品标" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch />
            </Form.Item>
            <Form.Item name="featuredSort" label="精选排序" style={{ flex: 1, marginBottom: 0 }}>
              <InputNumber style={{ width: "100%" }} placeholder="越小越靠前" />
            </Form.Item>
          </Space>
          <Space size={16} style={{ width: "100%" }}>
            <Form.Item name="recommendStartsAt" label="推荐开始" style={{ flex: 1 }}>
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="recommendEndsAt" label="推荐结束" style={{ flex: 1 }}>
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="scheduledAt" label="定时发布" style={{ flex: 1 }}>
              <DatePicker showTime style={{ width: "100%" }} />
            </Form.Item>
          </Space>
          <Form.Item name="previewUrl" label="试听/预览 URL">
            <Input placeholder="https://...（公开预览片段）" />
          </Form.Item>
          <Space size={16} style={{ width: "100%" }}>
            <Form.Item name="channelId" label="关联频道 ID" style={{ flex: 1 }}>
              <Input placeholder="Telegram 频道 ID（如 -100xxxx）" />
            </Form.Item>
            <Form.Item name="productId" label="关联产品 ID" style={{ flex: 1 }}>
              <Input placeholder="单篇购买对应产品 ID" />
            </Form.Item>
            <Form.Item name="packageId" label="关联内容包 ID" style={{ flex: 1 }}>
              <Input placeholder="归属内容包 ID" />
            </Form.Item>
          </Space>
        </Form>
      </Drawer>
    </Space>
  );
};

export default ContentsPage;
