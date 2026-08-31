import React from "react";
import { Alert, Button, Card, Drawer, Form, Input, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined } from "@ant-design/icons";
import { adminMe, archiveAdminArticle, createAdminArticle, errMsg, listAdminArticles, publishAdminArticle, updateAdminArticle } from "../api/client";
import type { AdminArticleInput, AdminArticleItem, AdminMe } from "../api/types";

const { TextArea } = Input;
const { Text, Title } = Typography;

const EMPTY: AdminArticleInput = {
  slug: "", title: "", summary: "", bodyMarkdown: "", sourceName: null, sourceUrl: null,
  topics: [], seoTitle: null, seoDescription: null, seoKeywords: [], geoKeywords: [], status: "draft", reason: "",
};

const statusLabel: Record<AdminArticleItem["status"], string> = { draft: "草稿", published: "已发布", archived: "已下线" };
const statusColor: Record<AdminArticleItem["status"], string> = { draft: "default", published: "green", archived: "orange" };

const ArticlesPage: React.FC = () => {
  const [form] = Form.useForm<AdminArticleInput>();
  const [rows, setRows] = React.useState<AdminArticleItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminArticleItem | null>(null);
  const [me, setMe] = React.useState<AdminMe | null>(null);
  const canEdit = ["super_admin", "operator", "editor"].includes(me?.role || "");
  const canPublish = ["super_admin", "operator", "editor"].includes(me?.role || "");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [result, currentMe] = await Promise.all([listAdminArticles(), adminMe()]);
      setRows(result.items);
      setMe(currentMe);
    } catch (error) {
      message.error(errMsg(error, "加载文章列表失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue(EMPTY);
    setDrawerOpen(true);
  };
  const openEdit = (article: AdminArticleItem) => {
    setEditing(article);
    form.setFieldsValue({ ...article, reason: "" });
    setDrawerOpen(true);
  };
  const save = async () => {
    try {
      const value = await form.validateFields();
      setSaving(true);
      if (editing) await updateAdminArticle(editing.id, value);
      else await createAdminArticle(value);
      message.success(editing ? "文章已保存" : "文章草稿已创建");
      setDrawerOpen(false);
      await load();
    } catch (error) {
      message.error(errMsg(error, "保存文章失败"));
    } finally {
      setSaving(false);
    }
  };
  const publish = async (article: AdminArticleItem) => {
    try { await publishAdminArticle(article.id); message.success("文章已发布，前台文章页将显示它"); await load(); }
    catch (error) { message.error(errMsg(error, "发布文章失败")); }
  };
  const archive = async (article: AdminArticleItem) => {
    try { await archiveAdminArticle(article.id); message.success("文章已下线"); await load(); }
    catch (error) { message.error(errMsg(error, "下线文章失败")); }
  };

  const columns: ColumnsType<AdminArticleItem> = [
    { title: "标题", dataIndex: "title", width: 260, render: (title, row) => <Space direction="vertical" size={0}><Text strong>{title}</Text><Text type="secondary">/{row.slug}</Text></Space> },
    { title: "状态", dataIndex: "status", width: 100, render: (status: AdminArticleItem["status"]) => <Tag color={statusColor[status]}>{statusLabel[status]}</Tag> },
    { title: "主题", dataIndex: "topics", render: (topics: string[]) => <Space size={[4, 4]} wrap>{topics.slice(0, 4).map((topic) => <Tag key={topic}>{topic}</Tag>)}</Space> },
    { title: "更新时间", dataIndex: "updatedAt", width: 180, render: (time) => new Date(time).toLocaleString("zh-CN", { hour12: false }) },
    { title: "操作", width: 220, render: (_, row) => <Space wrap>
      <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>编辑</Button>
      {row.status !== "published" && <Button size="small" type="primary" disabled={!canPublish} onClick={() => publish(row)}>发布</Button>}
      {row.status !== "archived" && <Popconfirm title="确认下线这篇文章？" onConfirm={() => archive(row)}><Button size="small" danger disabled={!canPublish}>下线</Button></Popconfirm>}
    </Space> },
  ];

  return <Space direction="vertical" size={16} style={{ width: "100%" }}>
    <Card>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Title level={5} style={{ margin: 0 }}>文章中心</Title>
        <Text type="secondary">编写平台原创文章或维护经授权的导读。仅“已发布”文章会出现在 H5、Web 和 Mini App 的文章板块。</Text>
        <Alert type="info" showIcon message="正文以安全纯文本分段展示" description="保存为 Markdown / 纯文本；前台会转义 HTML，不执行脚本。引用第三方资料请填写来源名称与链接，不直接搬运未经授权的全文。" />
      </Space>
    </Card>
    <Card title="文章列表" extra={<Space><Button onClick={load}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canEdit} onClick={openCreate}>新建文章</Button></Space>}>
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 980 }} />
    </Card>
    <Drawer title={editing ? "编辑文章" : "新建文章"} width={760} open={drawerOpen} onClose={() => setDrawerOpen(false)} extra={<Button type="primary" loading={saving} onClick={save}>保存</Button>}>
      <Form form={form} layout="vertical" initialValues={EMPTY} preserve={false}>
        <Form.Item name="slug" label="URL 标识" rules={[{ required: true, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: "仅小写英文、数字与连字符，例如 bdsm-safety-guide" }]}><Input maxLength={160} disabled={!canEdit} /></Form.Item>
        <Form.Item name="title" label="文章标题" rules={[{ required: true, min: 2, max: 160 }]}><Input maxLength={160} disabled={!canEdit} /></Form.Item>
        <Form.Item name="summary" label="摘要" rules={[{ required: true, min: 10, max: 500 }]}><TextArea rows={3} maxLength={500} disabled={!canEdit} /></Form.Item>
        <Form.Item name="bodyMarkdown" label="正文" rules={[{ required: true, min: 20, max: 50000 }]} extra="以空行分段；前台会安全转义并保留段落。"><TextArea rows={14} maxLength={50000} disabled={!canEdit} /></Form.Item>
        <Space size={16} style={{ display: "flex" }}>
          <Form.Item name="sourceName" label="来源名称" style={{ flex: 1 }}><Input maxLength={120} disabled={!canEdit} /></Form.Item>
          <Form.Item name="sourceUrl" label="来源链接" style={{ flex: 1 }} rules={[{ type: "url", message: "请输入完整 https:// 链接" }]}><Input maxLength={500} disabled={!canEdit} /></Form.Item>
        </Space>
        <Form.Item name="topics" label="主题标签"><Select mode="tags" tokenSeparators={[",", "，", "\n"]} maxCount={12} disabled={!canEdit} /></Form.Item>
        <Form.Item name="seoTitle" label="SEO 标题"><Input maxLength={160} disabled={!canEdit} /></Form.Item>
        <Form.Item name="seoDescription" label="SEO 描述"><TextArea rows={2} maxLength={300} disabled={!canEdit} /></Form.Item>
        <Form.Item name="seoKeywords" label="SEO 关键词"><Select mode="tags" tokenSeparators={[",", "，", "\n"]} maxCount={30} disabled={!canEdit} /></Form.Item>
        <Form.Item name="geoKeywords" label="GEO 主题词"><Select mode="tags" tokenSeparators={[",", "，", "\n"]} maxCount={30} disabled={!canEdit} /></Form.Item>
        <Form.Item name="status" label="保存状态"><Select disabled={!canEdit} options={[{ value: "draft", label: "草稿" }, { value: "published", label: "已发布" }, { value: "archived", label: "已下线" }]} /></Form.Item>
        <Form.Item name="reason" label="变更原因"><TextArea rows={2} maxLength={500} disabled={!canEdit} placeholder="建议填写，便于后台审计" /></Form.Item>
      </Form>
    </Drawer>
  </Space>;
};

export default ArticlesPage;
