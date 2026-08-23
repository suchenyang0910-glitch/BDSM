import React from "react";
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import { EditOutlined, PlusOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import {
  adminMe,
  createAdminPackage,
  errMsg,
  listAdminPackages,
  updateAdminPackage,
} from "../api/client";
import type { AdminMe, AdminPackageItem } from "../api/types";

const { Title, Text } = Typography;
const { Option } = Select;

function formatDisplayPrice(priceMinor?: string | null, currency?: string | null): number | null {
  if (!priceMinor) return null;
  const numeric = Number(priceMinor);
  if (!Number.isFinite(numeric)) return null;
  return String(currency || "").toUpperCase() === "USDT" ? numeric / 1_000_000 : numeric;
}

function toMinorString(displayPrice: number, currency: string): string {
  if (currency === "USDT") {
    return String(Math.round(displayPrice * 1_000_000));
  }
  return String(Math.round(displayPrice));
}

const PackagesPage: React.FC = () => {
  const [rows, setRows] = React.useState<AdminPackageItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminPackageItem | null>(null);
  const [me, setMe] = React.useState<AdminMe | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [form] = Form.useForm();

  const canEdit = React.useMemo(() => {
    if (!me) return false;
    return ["super_admin", "operator", "editor"].includes(me.role);
  }, [me]);

  const fetchList = React.useCallback(async () => {
    setLoading(true);
    try {
      const resp = await listAdminPackages();
      setRows(resp.data);
    } catch (error) {
      message.error(errMsg(error, "加载内容包失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchList();
    adminMe().then(setMe).catch(() => {});
  }, [fetchList]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      status: "draft",
      productStatus: "active",
      currency: "XTR",
      displayPrice: 0,
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: AdminPackageItem) => {
    setEditing(row);
    form.setFieldsValue({
      title: row.title,
      coverUrl: row.coverUrl,
      status: row.status,
      productTitle: row.productTitle,
      productStatus: row.productStatus || (row.productActive ? "active" : "inactive"),
      currency: row.currency || "XTR",
      displayPrice: formatDisplayPrice(row.priceMinor, row.currency || "XTR"),
    });
    setDrawerOpen(true);
  };

  const onSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const currency = String(values.currency || "XTR").toUpperCase();
      const payload = {
        title: values.title,
        coverUrl: values.coverUrl || null,
        status: values.status,
        productTitle: values.productTitle,
        productStatus: values.productStatus,
        currency,
        priceMinor: toMinorString(Number(values.displayPrice || 0), currency),
        reason: editing ? `编辑内容包：${editing.title}` : `新建内容包：${values.title}`,
      };
      if (editing) {
        await updateAdminPackage(editing.id, payload);
        message.success("内容包已更新");
      } else {
        await createAdminPackage(payload);
        message.success("内容包已创建");
      }
      setDrawerOpen(false);
      fetchList();
    } catch (error) {
      message.error(errMsg(error, editing ? "更新内容包失败" : "创建内容包失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const columns: ColumnsType<AdminPackageItem> = [
    {
      title: "内容包",
      dataIndex: "title",
      key: "title",
      render: (value: string, row) => (
        <Space direction="vertical" size={0}>
          <Text strong>{value}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {row.productTitle || "未配置商品"}
          </Text>
        </Space>
      ),
    },
    {
      title: "状态",
      key: "status",
      width: 220,
      render: (_: unknown, row) => (
        <Space wrap>
          <Tag color={row.status === "published" ? "green" : row.status === "offline" ? "default" : "orange"}>
            {row.status}
          </Tag>
          <Tag color={row.productActive ? "blue" : "default"}>
            商品 {row.productStatus || (row.productActive ? "active" : "inactive")}
          </Tag>
          <Tag color={row.channelConfigured ? "green" : "red"}>
            {row.channelConfigured ? "已配频道" : "待配频道"}
          </Tag>
        </Space>
      ),
    },
    {
      title: "价格",
      key: "price",
      width: 140,
      render: (_: unknown, row) => {
        const display = formatDisplayPrice(row.priceMinor, row.currency || "XTR");
        return display == null ? "未配置" : `${display} ${row.currency || "XTR"}`;
      },
    },
    {
      title: "内容数",
      dataIndex: "contentsCount",
      key: "contentsCount",
      width: 90,
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 160,
      render: (value: string) => dayjs(value).format("YYYY-MM-DD HH:mm"),
    },
    {
      title: "操作",
      key: "action",
      width: 120,
      render: (_: unknown, row) => (
        <Button icon={<EditOutlined />} size="small" disabled={!canEdit} onClick={() => openEdit(row)}>
          编辑
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card
        title={<Title level={5} style={{ margin: 0 }}>内容包管理</Title>}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!canEdit}>
            新建内容包
          </Button>
        }
      >
        <Table<AdminPackageItem>
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 个内容包` }}
        />
      </Card>

      <Drawer
        title={editing ? `编辑内容包：${editing.title}` : "新建内容包"}
        open={drawerOpen}
        onClose={() => !submitting && setDrawerOpen(false)}
        width={560}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)} disabled={submitting}>取消</Button>
            <Button type="primary" loading={submitting} onClick={onSubmit} disabled={!canEdit}>
              {editing ? "保存" : "创建"}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="title" label="内容包标题" rules={[{ required: true, message: "请输入内容包标题" }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="coverUrl" label="封面 URL">
            <Input placeholder="https://..." />
          </Form.Item>
          <Space style={{ width: "100%" }} size={16} align="start">
            <Form.Item name="status" label="内容包状态" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select>
                <Option value="draft">draft</Option>
                <Option value="published">published</Option>
                <Option value="offline">offline</Option>
              </Select>
            </Form.Item>
            <Form.Item name="productStatus" label="商品状态" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select>
                <Option value="active">active</Option>
                <Option value="inactive">inactive</Option>
              </Select>
            </Form.Item>
          </Space>
          <Form.Item name="productTitle" label="商品标题" rules={[{ required: true, message: "请输入商品标题" }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Space style={{ width: "100%" }} size={16} align="start">
            <Form.Item name="currency" label="币种" rules={[{ required: true }]} style={{ width: 140 }}>
              <Select>
                <Option value="XTR">XTR</Option>
                <Option value="USDT">USDT</Option>
              </Select>
            </Form.Item>
            <Form.Item
              name="displayPrice"
              label="展示价格"
              rules={[{ required: true, message: "请输入价格" }]}
              style={{ flex: 1 }}
              extra="XTR 按整数 Stars 存储；USDT 自动换算为 6 位小数 minor。"
            >
              <InputNumber min={0} precision={6} style={{ width: "100%" }} />
            </Form.Item>
          </Space>
        </Form>
      </Drawer>
    </Space>
  );
};

export default PackagesPage;
