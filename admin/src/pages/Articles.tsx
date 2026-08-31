import React from "react";
import { Alert, Button, Card, Divider, Drawer, Form, Input, Popconfirm, Select, Space, Table, Tag, Typography, Upload, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, UploadOutlined } from "@ant-design/icons";
import { adminMe, archiveAdminArticle, completeAdminBannerImageUpload, createAdminArticle, errMsg, initAdminBannerImageUpload, listAdminArticles, publishAdminArticle, updateAdminArticle } from "../api/client";
import type { AdminArticleInput, AdminArticleItem, AdminMe } from "../api/types";

const { TextArea } = Input;
const { Text, Title } = Typography;

const EMPTY: AdminArticleInput = {
  slug: "", title: "", summary: "", bodyHtml: "", coverImageUrl: null, sourceName: null, sourceUrl: null,
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
  const [imageUploading, setImageUploading] = React.useState(false);
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
  const uploadArticleImage = async (file: File, mode: "cover" | "inline") => {
    if (!canEdit) return Upload.LIST_IGNORE;
    if (!/^image\/(jpeg|png|webp|jpg)$/i.test(file.type || "")) {
      message.error("仅支持 JPG、PNG 或 WebP 图片");
      return Upload.LIST_IGNORE;
    }
    if (file.size > 20 * 1024 * 1024) {
      message.error("文章图片不能超过 20MB");
      return Upload.LIST_IGNORE;
    }
    setImageUploading(true);
    let assetId: string | null = null;
    try {
      const init = await initAdminBannerImageUpload({ originalFilename: file.name, mimeType: file.type, contentLength: file.size });
      assetId = init.mediaAssetId;
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", init.uploadUrl, true);
        Object.entries(init.expectedHttpHeaders || {}).forEach(([key, value]) => { try { xhr.setRequestHeader(key, value); } catch { /* browser restricted header */ } });
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
        xhr.onerror = () => reject(new Error("网络错误：上传到对象存储失败"));
        xhr.send(file);
      });
      const completed = await completeAdminBannerImageUpload(assetId, { ok: true, reportedContentLength: file.size });
      if (!completed.ok || completed.status !== "ready" || !completed.publicUrl) throw new Error("article_image_verify_failed");
      const current = String(form.getFieldValue("bodyHtml") || "").trimEnd();
      const alt = file.name.replace(/\.[a-z0-9]+$/i, "") || "文章配图";
      if (mode === "cover") {
        form.setFieldValue("coverImageUrl", completed.publicUrl);
        message.success("封面图片已上传，可直接保存文章");
      } else {
        const figure = `<figure><img src="${completed.publicUrl}" alt="${alt}"><figcaption>${alt}</figcaption></figure>`;
        form.setFieldValue("bodyHtml", `${current}${current ? "\n\n" : ""}${figure}`);
        message.success("图片已插入 HTML 正文末尾，可剪切到任意位置");
      }
    } catch (error) {
      if (assetId) {
        try { await completeAdminBannerImageUpload(assetId, { ok: false, error: "article_image_upload_failed" }); } catch { /* best effort */ }
      }
      message.error(errMsg(error, "文章图片上传失败"));
    } finally {
      setImageUploading(false);
    }
    return Upload.LIST_IGNORE;
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
        <Alert type="info" showIcon message="支持封面与 HTML 图文排版" description="封面和正文图片均可上传；正文使用受控 HTML，支持标题、段落、列表、引用、链接和图片。系统会过滤脚本、样式、事件属性及非 HTTPS 资源。引用第三方资料请填写来源名称与链接，不直接搬运未经授权的全文。" />
      </Space>
    </Card>
    <Card title="文章列表" extra={<Space><Button onClick={load}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canEdit} onClick={openCreate}>新建文章</Button></Space>}>
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 980 }} />
    </Card>
    <Drawer title={editing ? "编辑文章" : "新建文章"} width={980} open={drawerOpen} onClose={() => setDrawerOpen(false)} extra={<Button type="primary" loading={saving} onClick={save}>保存</Button>}>
      <Form form={form} layout="vertical" initialValues={EMPTY} preserve={false}>
        <Form.Item name="slug" label="URL 标识" rules={[{ required: true, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: "仅小写英文、数字与连字符，例如 bdsm-safety-guide" }]}><Input maxLength={160} disabled={!canEdit} /></Form.Item>
        <Form.Item name="title" label="文章标题" rules={[{ required: true, min: 2, max: 160 }]}><Input maxLength={160} disabled={!canEdit} /></Form.Item>
        <Form.Item name="summary" label="摘要" rules={[{ required: true, min: 10, max: 500 }]}><TextArea rows={3} maxLength={500} disabled={!canEdit} /></Form.Item>
        <Form.Item name="coverImageUrl" label="文章封面图片" extra={<Space direction="vertical" size={6}><Text type="secondary">建议 16:9、最小 1600×900。封面会显示在文章列表与详情顶部。</Text><Upload accept="image/jpeg,image/png,image/webp,image/jpg" showUploadList={false} beforeUpload={(file) => uploadArticleImage(file as File, "cover")}><Button icon={<UploadOutlined />} loading={imageUploading} disabled={!canEdit}>上传封面图片</Button></Upload></Space>}><Input placeholder="上传后自动填写，也可填写 HTTPS 图片地址" disabled={!canEdit} /></Form.Item>
        <Form.Item noStyle shouldUpdate={(previous, current) => previous.coverImageUrl !== current.coverImageUrl}>{() => form.getFieldValue("coverImageUrl") ? <img src={form.getFieldValue("coverImageUrl")} alt="文章封面预览" style={{ width: "100%", maxWidth: 480, aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 10, marginBottom: 18 }} /> : null}</Form.Item>
        <Form.Item name="bodyHtml" label="正文 HTML" rules={[{ required: true, min: 20, max: 50000 }]} extra={<Space direction="vertical" size={6}><Text type="secondary">可用标签：h2、h3、p、strong、em、ul、ol、li、blockquote、a、figure、img、figcaption、br、hr。图片会插入正文末尾，可剪切调整。</Text><Upload accept="image/jpeg,image/png,image/webp,image/jpg" showUploadList={false} beforeUpload={(file) => uploadArticleImage(file as File, "inline")}><Button icon={<UploadOutlined />} loading={imageUploading} disabled={!canEdit}>上传并插入正文图片</Button></Upload></Space>}><TextArea autoSize={{ minRows: 24, maxRows: 46 }} maxLength={50000} disabled={!canEdit} spellCheck={false} /></Form.Item>
        <Form.Item noStyle shouldUpdate={(previous, current) => previous.bodyHtml !== current.bodyHtml}>{() => <><Divider orientation="left">HTML 安全预览</Divider><iframe title="文章 HTML 预览" sandbox="" style={{ width: "100%", minHeight: 320, border: "1px solid #eee", borderRadius: 10 }} srcDoc={`<style>body{font-family:system-ui,sans-serif;line-height:1.75;padding:20px;color:#211c2d}img{max-width:100%;height:auto;border-radius:12px}figure{margin:20px 0}figcaption{color:#716b7d;font-size:13px;text-align:center}blockquote{margin:18px 0;padding:12px 16px;border-left:3px solid #8d52ff;background:#f6f1ff}a{color:#6d3ae8}</style>${String(form.getFieldValue("bodyHtml") || "")}`} /></>}</Form.Item>
        <Space size={16} style={{ display: "flex" }}>
          <Form.Item name="sourceName" label="来源名称（选填）" style={{ flex: 1 }}><Input maxLength={120} disabled={!canEdit} placeholder="填写后才会在文章正文底部展示" /></Form.Item>
          <Form.Item name="sourceUrl" label="来源链接（选填）" style={{ flex: 1 }} rules={[{ type: "url", message: "请输入完整 https:// 链接" }]}><Input maxLength={500} disabled={!canEdit} placeholder="填写后才会在文章正文底部展示" /></Form.Item>
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
