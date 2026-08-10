import React from "react";
import {
  Card,
  Typography,
  Empty,
  Tag,
  Space,
  Button,
  Table,
  Input,
  Form,
  Drawer,
  InputNumber,
  Select,
  message,
  Modal,
} from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import {
  listAdminCategories,
  createAdminCategory,
  updateAdminCategory,
  deleteAdminCategory,
  adminMe,
  errMsg,
} from "../api/client";
import type { CategoryItem, AdminMe } from "../api/types";

const { Title } = Typography;
const { Option } = Select;
const { TextArea } = Input;

const STATUS_OPTIONS = [
  { value: "active", label: "启用" },
  { value: "inactive", label: "停用" },
  { value: "archived", label: "归档" },
];

const CategoriesPage: React.FC = () => {
  const [rows, setRows] = React.useState<CategoryItem[]>([]);
  const [loading, setLoading] = React.useState(false);

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CategoryItem | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = React.useState(false);
  const [me, setMe] = React.useState<AdminMe | null>(null);

  const fetchList = React.useCallback(async () => {
    setLoading(true);
    try {
      const resp = await listAdminCategories();
      setRows(resp.data);
    } catch (e) {
      message.error(errMsg(e, "加载分类失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchList();
    adminMe().then(setMe).catch(() => {});
  }, [fetchList]);

  const canEdit = React.useMemo(() => {
    if (!me) return false;
    return ["super_admin", "operator", "editor"].includes(me.role);
  }, [me]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      status: "active",
      sortOrder: 0,
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: CategoryItem) => {
    setEditing(row);
    form.setFieldsValue({
      name: row.name,
      slug: row.slug,
      iconUrl: row.iconUrl,
      sortOrder: row.sortOrder,
      status: row.status,
    });
    setDrawerOpen(true);
  };

  const onDrawerSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        ...values,
        reason: editing ? `编辑分类：${editing.name}` : `新建分类：${values.name}`,
      };
      if (editing) {
        await updateAdminCategory(editing.id, payload);
        message.success("分类已更新");
      } else {
        await createAdminCategory(payload);
        message.success("分类已创建");
      }
      setDrawerOpen(false);
      fetchList();
    } catch (e) {
      message.error(errMsg(e, editing ? "更新失败" : "创建失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = (row: CategoryItem) => {
    Modal.confirm({
      title: "删除分类",
      content:
        row.contentCount > 0
          ? `分类「${row.name}」下仍有 ${row.contentCount} 篇内容，删除将被拒绝。请先解除内容关联。`
          : `确定删除分类「${row.name}」？此操作不可恢复。`,
      okText: "删除",
      okButtonProps: { danger: row.contentCount === 0, disabled: row.contentCount > 0 },
      cancelText: "取消",
      onOk: async () => {
        if (row.contentCount > 0) return;
        try {
          await deleteAdminCategory(row.id, `管理员删除分类：${row.name}`);
          message.success("已删除");
          fetchList();
        } catch (e: any) {
          const code = e?.response?.data?.code;
          if (code === "not_empty") {
            message.error("该分类下仍有内容，无法删除，请先解除内容关联");
          } else {
            message.error(errMsg(e, "删除失败"));
          }
        }
      },
    });
  };

  const columns: ColumnsType<CategoryItem> = [
    { title: "名称", dataIndex: "name", key: "name", width: 200, render: (t, r) => (
      <Space direction="vertical" size={0}>
        <span style={{ fontWeight: 500 }}>{t}</span>
        {r.iconUrl && <Tag color="blue" style={{ marginTop: 4 }}>已设图标</Tag>}
      </Space>
    )},
    { title: "标识符 (slug)", dataIndex: "slug", key: "slug", width: 180, render: (s) => <code style={{ background: "#f5f5f5", padding: "2px 6px", borderRadius: 4 }}>{s}</code> },
    { title: "内容数", dataIndex: "contentCount", key: "contentCount", width: 100, render: (n: number) => n > 0 ? <Tag color="geekblue">{n} 篇</Tag> : <Tag color="default">0 篇</Tag> },
    { title: "排序", dataIndex: "sortOrder", key: "sortOrder", width: 80 },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (s: string) =>
        s === "active" ? <Tag color="green">启用</Tag> : s === "archived" ? <Tag color="grey">归档</Tag> : <Tag color="default">停用</Tag>,
    },
    {
      title: "创建/更新",
      key: "time",
      width: 160,
      render: (_: any, r) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          <span>{dayjs(r.createdAt).format("YYYY-MM-DD")}</span>
          <span style={{ color: "#999" }}>{dayjs(r.updatedAt).format("MM-DD HH:mm")}</span>
        </Space>
      ),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 180,
      render: (_: any, r) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={!canEdit}
            onClick={() => openEdit(r)}
          >
            编辑
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={!canEdit || r.contentCount > 0}
            onClick={() => confirmDelete(r)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title={<Title level={5} style={{ margin: 0 }}>分类与标签</Title>}
        extra={
          <Button icon={<PlusOutlined />} type="primary" onClick={openCreate} disabled={!canEdit}>
            新建分类
          </Button>
        }
      >
        <Table<CategoryItem>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个分类` }}
          locale={{ emptyText: <Empty description="暂无分类，点击右上角「新建分类」开始创建" /> }}
        />
      </Card>

      <Drawer
        title={editing ? `编辑分类：${editing.name}` : "新建分类"}
        open={drawerOpen}
        onClose={() => !submitting && setDrawerOpen(false)}
        width={520}
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
          <Form.Item name="name" label="分类名称" rules={[{ required: true, message: "请输入分类名称" }]}>
            <Input placeholder="例如：正念冥想" maxLength={100} />
          </Form.Item>
          <Form.Item
            name="slug"
            label="标识符（slug）"
            rules={[
              { required: true, message: "请输入标识符" },
              { pattern: /^[a-z0-9][a-z0-9_-]*$/, message: "仅允许小写字母、数字、下划线、短横线，且开头为字母或数字" },
            ]}
          >
            <Input placeholder="例如：meditation（用于 Mini App 路由）" maxLength={80} />
          </Form.Item>
          <Form.Item name="iconUrl" label="图标 URL">
            <Input placeholder="https://...（建议 128×128 SVG/PNG）" />
          </Form.Item>
          <Space size={16} style={{ width: "100%" }}>
            <Form.Item name="sortOrder" label="排序值" style={{ flex: 1 }}>
              <InputNumber style={{ width: "100%" }} placeholder="越小越靠前" />
            </Form.Item>
            <Form.Item name="status" label="状态" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={STATUS_OPTIONS} />
            </Form.Item>
          </Space>
        </Form>
      </Drawer>
    </Space>
  );
};

export default CategoriesPage;
