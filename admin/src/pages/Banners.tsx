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
  Select,
  Radio,
  message,
  Modal,
  Image,
  Upload,
} from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined, UploadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import {
  listAdminBanners,
  createAdminBanner,
  updateAdminBanner,
  deleteAdminBanner,
  adminMe,
  listAdminContents,
  errMsg,
  listAdminBannerImageAssets,
  initAdminBannerImageUpload,
  completeAdminBannerImageUpload,
} from "../api/client";
import type { BannerItem, BannerStatus, BannerTargetType, AdminMe, ContentItem, BannerImageAsset } from "../api/types";

const { Title } = Typography;
const { Option } = Select;
const STATUS_TAG: Record<BannerStatus, { color: string; label: string }> = {
  draft: { color: "default", label: "草稿" },
  scheduled: { color: "geekblue", label: "定时投放" },
  active: { color: "green", label: "投放中" },
  inactive: { color: "warning", label: "已停止" },
  archived: { color: "grey", label: "归档" },
};

const TARGET_TYPE_OPTIONS: { value: BannerTargetType; label: string; hint: string }[] = [
  { value: "content", label: "站内视频详情", hint: "选择一个已发布视频" },
  { value: "external", label: "外网链接", hint: "填写合规 HTTPS 链接" },
];

const BannersPage: React.FC = () => {
  const [rows, setRows] = React.useState<BannerItem[]>([]);
  const [loading, setLoading] = React.useState(false);

  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BannerItem | null>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = React.useState(false);
  const [me, setMe] = React.useState<AdminMe | null>(null);

  const [contents, setContents] = React.useState<ContentItem[]>([]);
  const [pickLoading, setPickLoading] = React.useState(false);
  const [imageAssets, setImageAssets] = React.useState<BannerImageAsset[]>([]);
  const [imageUploading, setImageUploading] = React.useState(false);

  const targetType = Form.useWatch("targetType", form);
  const selectedImageAssetId = Form.useWatch("imageAssetId", form);

  const fetchList = React.useCallback(async () => {
    setLoading(true);
    try {
      const resp = await listAdminBanners();
      setRows(resp.data);
    } catch (e) {
      message.error(errMsg(e, "加载 Banner 失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPickers = React.useCallback(async () => {
    setPickLoading(true);
    try {
      // 与服务端分页契约保持一致，单次请求最大 100 条。
      const tResp = await listAdminContents({ limit: 100 });
      setContents(tResp.data.filter((item) => item.status === "published"));
    } catch {
      // ignore
    } finally {
      setPickLoading(false);
    }
  }, []);

  const fetchImageAssets = React.useCallback(async () => {
    try {
      const resp = await listAdminBannerImageAssets();
      setImageAssets(resp.data);
      return resp.data;
    } catch (e) {
      message.error(errMsg(e, "加载 Banner 图片库失败"));
      return [] as BannerImageAsset[];
    }
  }, []);

  React.useEffect(() => {
    fetchList();
    adminMe().then(setMe).catch(() => {});
  }, [fetchList]);

  React.useEffect(() => {
    if (!drawerOpen) return;
    void fetchPickers();
    void fetchImageAssets();
  }, [drawerOpen, fetchPickers, fetchImageAssets]);

  const canEdit = React.useMemo(() => {
    if (!me) return false;
    return ["super_admin", "operator", "editor"].includes(me.role);
  }, [me]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      targetType: "content",
      title: "首页运营图",
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: BannerItem) => {
    setEditing(row);
    form.setFieldsValue({
      title: row.title,
      imageAssetId: undefined,
      targetType: row.targetType,
      targetId: row.targetId,
      externalUrl: row.externalUrl,
    });
    setDrawerOpen(true);
  };

  const selectedImage = imageAssets.find((asset) => asset.id === selectedImageAssetId) || null;
  const imagePreviewUrl = selectedImage?.imageUrl || editing?.imageUrl || null;

  const uploadBannerImage = async (file: File) => {
    if (!canEdit) {
      message.error("当前角色无 homepage:edit 权限，不能上传 Banner 图片");
      return Upload.LIST_IGNORE;
    }
    if (!/^image\/(jpeg|png|webp|jpg)$/i.test(file.type || "")) {
      message.error("仅支持 JPG、PNG 或 WebP 图片");
      return Upload.LIST_IGNORE;
    }
    if (file.size > 20 * 1024 * 1024) {
      message.error("Banner 图片不能超过 20MB");
      return Upload.LIST_IGNORE;
    }
    setImageUploading(true);
    let assetId: string | null = null;
    try {
      const init = await initAdminBannerImageUpload({
        originalFilename: file.name,
        mimeType: file.type,
        contentLength: file.size,
      });
      assetId = init.mediaAssetId;
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", init.uploadUrl, true);
        Object.entries(init.expectedHttpHeaders || {}).forEach(([key, value]) => {
          try { xhr.setRequestHeader(key, value); } catch { /* browser restricted header */ }
        });
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
        xhr.onerror = () => reject(new Error("网络错误：上传到对象存储失败"));
        xhr.send(file);
      });
      const completed = await completeAdminBannerImageUpload(assetId, { ok: true, reportedContentLength: file.size });
      if (!completed.ok || completed.status !== "ready") throw new Error("banner_image_verify_failed");
      const latest = await fetchImageAssets();
      if (!latest.some((asset) => asset.id === assetId)) throw new Error("banner_image_not_ready");
      form.setFieldValue("imageAssetId", assetId);
      message.success("Banner 图片上传并校验完成，已自动选中");
    } catch (e) {
      if (assetId) {
        try { await completeAdminBannerImageUpload(assetId, { ok: false, error: "banner_image_upload_failed" }); } catch { /* best effort */ }
      }
      message.error(errMsg(e, "Banner 图片上传失败"));
    } finally {
      setImageUploading(false);
    }
    return Upload.LIST_IGNORE;
  };

  const onDrawerSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload: any = {
        title: values.title,
        imageAssetId: values.imageAssetId || undefined,
        targetType: values.targetType,
        targetId: values.targetId || null,
        externalUrl: values.externalUrl || null,
        reason: editing ? `编辑 Banner：${editing.title}` : `新建 Banner：${values.title}`,
      };
      if (!editing) Object.assign(payload, {
        actionLabel: "查看详情",
        slot: "home_primary",
        status: "active",
        sortOrder: 0,
      });
      if (editing) {
        await updateAdminBanner(editing.id, payload);
        message.success("Banner 已更新");
      } else {
        await createAdminBanner(payload);
        message.success("Banner 已创建");
      }
      setDrawerOpen(false);
      fetchList();
    } catch (e) {
      message.error(errMsg(e, editing ? "更新失败" : "创建失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = (row: BannerItem) => {
    Modal.confirm({
      title: "删除 Banner",
      content: `确定删除 Banner「${row.title}」？此操作不可恢复。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await deleteAdminBanner(row.id, `管理员删除 Banner：${row.title}`);
          message.success("已删除");
          fetchList();
        } catch (e) {
          message.error(errMsg(e, "删除失败"));
        }
      },
    });
  };

  const columns: ColumnsType<BannerItem> = [
    {
      title: "标题",
      dataIndex: "title",
      key: "title",
      width: 200,
      render: (t: string, r) => (
        <Space direction="vertical" size={2}>
          <Space>
            {r.imageUrl && <Image width={32} height={18} src={r.imageUrl} preview={false} style={{ borderRadius: 2, objectFit: "cover" }} />}
            <span style={{ fontWeight: 500 }}>{t}</span>
          </Space>
          {r.description && <span style={{ color: "#999", fontSize: 12 }}>{r.description.slice(0, 30)}</span>}
        </Space>
      ),
    },
    {
      title: "跳转目标",
      key: "target",
      width: 200,
      render: (_: any, r) => {
        const m = TARGET_TYPE_OPTIONS.find((o) => o.value === r.targetType);
        const label = m ? m.label : r.targetType;
        const val = r.targetType === "external" ? r.externalUrl : r.targetId;
        return (
          <Space direction="vertical" size={0}>
            <Tag color="blue">{label}</Tag>
            {val && <span style={{ fontSize: 12, color: "#666" }}>{val.slice(0, 28)}{val.length > 28 ? "…" : ""}</span>}
          </Space>
        );
      },
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (s: BannerStatus) => (
        <Tag color={STATUS_TAG[s]?.color || "default"}>{STATUS_TAG[s]?.label || s}</Tag>
      ),
    },
    {
      title: "更新",
      dataIndex: "updatedAt",
      key: "updatedAt",
      width: 140,
      render: (t: string) => dayjs(t).format("MM-DD HH:mm"),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 160,
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
            disabled={!canEdit}
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
      <Card>
        只需三步：上传或选择封面图片 → 选择站内视频，或填写外网链接 → 创建即显示在首页。最多保留 3 张；私密邀请与支付链接不能作为 Banner 跳转目标。
      </Card>
      <Card
        title={<Title level={5} style={{ margin: 0 }}>Banner 运营位</Title>}
        extra={
          <Button icon={<PlusOutlined />} type="primary" onClick={openCreate} disabled={!canEdit}>
            新建 Banner
          </Button>
        }
      >
        <Table<BannerItem>
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条 Banner` }}
          locale={{ emptyText: <Empty description="暂无 Banner 配置，点击右上角「新建 Banner」开始配置首页运营位" /> }}
        />
      </Card>

      <Drawer
        title={editing ? `编辑 Banner：${editing.title}` : "新建 Banner"}
        open={drawerOpen}
        onClose={() => !submitting && setDrawerOpen(false)}
        width={680}
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
          <Form.Item name="title" label="后台备注名称" rules={[{ required: true, message: "请输入便于识别的名称" }]} extra="仅用于后台识别；前台以图片为主展示。">
            <Input placeholder="例如：本周主推视频" maxLength={200} />
          </Form.Item>
          <Form.Item
            name="imageAssetId"
            label="Banner 图片（推荐 16:9，≥ 1280×720）"
            rules={editing ? [] : [{ required: true, message: "请上传或从素材库选择 Banner 图片" }]}
            extra={editing && !selectedImageAssetId && editing.imageUrl ? "这是历史 Banner 图片；如需更换，请重新上传或从素材库选择。" : "图片上传后会自动进入素材库；不需要、也不能手填图片 URL。"}
          >
            <Select
              showSearch
              allowClear={!!editing}
              loading={imageUploading}
              placeholder="从已上传封面图片中选择"
              optionFilterProp="label"
              dropdownRender={(menu) => (
                <>
                  <div style={{ padding: 8 }}>
                    <Upload accept="image/jpeg,image/png,image/webp,image/jpg" showUploadList={false} beforeUpload={(file) => uploadBannerImage(file as File)}>
                      <Button icon={<UploadOutlined />} loading={imageUploading} disabled={!canEdit}>上传新 Banner 图片</Button>
                    </Upload>
                  </div>
                  {menu}
                </>
              )}
            >
              {imageAssets.map((asset) => (
                <Option key={asset.id} value={asset.id} label={asset.originalFilename}>
                  <Space>
                    <Image src={asset.imageUrl} width={72} height={40} preview={false} style={{ borderRadius: 4, objectFit: "cover" }} />
                    <span>{asset.originalFilename}</span>
                    {asset.widthPixels && asset.heightPixels ? <Tag>{asset.widthPixels}×{asset.heightPixels}</Tag> : null}
                  </Space>
                </Option>
              ))}
            </Select>
          </Form.Item>
          {imagePreviewUrl ? <Image src={imagePreviewUrl} width={240} height={135} preview style={{ objectFit: "cover", borderRadius: 8, marginBottom: 16 }} /> : null}
          <Form.Item name="targetType" label="点击 Banner 后跳转到" rules={[{ required: true }]}>
            <Radio.Group options={TARGET_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
          </Form.Item>

          {targetType === "content" && (
            <Form.Item
              name="targetId"
              label="选择跳转内容"
              rules={[{ required: true, message: "请选择内容" }]}
              extra={pickLoading ? "加载内容列表中…" : "搜索框支持搜索标题"}
            >
              <Select showSearch filterOption={(input, option) => ((option?.label || "") as string).toLowerCase().includes(input.toLowerCase())}>
                {contents.map((c) => (
                  <Option key={c.id} value={c.id} label={c.title}>
                    <Space direction="vertical" size={0}>
                      <span>{c.title}</span>
                      <span style={{ fontSize: 12, color: "#999" }}>ID: {c.id.slice(0, 8)}… · {c.status}</span>
                    </Space>
                  </Option>
                ))}
              </Select>
            </Form.Item>
          )}

          {targetType === "external" && (
            <Form.Item
              name="externalUrl"
              label="外部 URL"
              rules={[
                { required: true, message: "请填写外部 URL" },
                { pattern: /^https:\/\//i, message: "必须为 https:// 开头" },
              ]}
              extra="允许公开 Telegram 链接（如 https://t.me/InTune_bdsm）；禁止私密邀请链接、支付链接。"
            >
              <Input placeholder="https://..." />
            </Form.Item>
          )}

        </Form>
      </Drawer>
    </Space>
  );
};

export default BannersPage;
