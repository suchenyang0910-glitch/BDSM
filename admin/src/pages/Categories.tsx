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
  Slider,
  Upload,
  Alert,
} from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined, UploadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import {
  listAdminCategories,
  createAdminCategory,
  updateAdminCategory,
  deleteAdminCategory,
  adminMe,
  errMsg,
  initAdminBannerImageUpload,
  completeAdminBannerImageUpload,
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
  const [iconPreviewUrl, setIconPreviewUrl] = React.useState<string | null>(null);
  const [iconUploading, setIconUploading] = React.useState(false);
  const [cropOpen, setCropOpen] = React.useState(false);
  const [cropFile, setCropFile] = React.useState<File | null>(null);
  const [cropSourceUrl, setCropSourceUrl] = React.useState<string | null>(null);
  const [cropImageSize, setCropImageSize] = React.useState({ width: 0, height: 0 });
  const [cropZoom, setCropZoom] = React.useState(1);
  const [cropOffset, setCropOffset] = React.useState({ x: 0, y: 0 });
  const cropObjectUrlRef = React.useRef<string | null>(null);

  const cropPreviewGeometry = React.useMemo(() => {
    const stage = 300;
    if (!cropImageSize.width || !cropImageSize.height) return null;
    const scale = Math.max(stage / cropImageSize.width, stage / cropImageSize.height) * cropZoom;
    const width = cropImageSize.width * scale;
    const height = cropImageSize.height * scale;
    return {
      width,
      height,
      offsetX: cropOffset.x * Math.max(0, (width - stage) / 2),
      offsetY: cropOffset.y * Math.max(0, (height - stage) / 2),
    };
  }, [cropImageSize, cropOffset, cropZoom]);

  const closeCrop = React.useCallback(() => {
    setCropOpen(false);
    setCropFile(null);
    setCropSourceUrl(null);
    setCropImageSize({ width: 0, height: 0 });
    setCropZoom(1);
    setCropOffset({ x: 0, y: 0 });
    if (cropObjectUrlRef.current) {
      URL.revokeObjectURL(cropObjectUrlRef.current);
      cropObjectUrlRef.current = null;
    }
  }, []);

  React.useEffect(() => () => {
    if (cropObjectUrlRef.current) URL.revokeObjectURL(cropObjectUrlRef.current);
  }, []);

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
    setIconPreviewUrl(null);
    closeCrop();
    form.resetFields();
    form.setFieldsValue({
      status: "active",
      sortOrder: 0,
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: CategoryItem) => {
    setEditing(row);
    setIconPreviewUrl(row.iconUrl || null);
    closeCrop();
    form.resetFields();
    form.setFieldsValue({
      name: row.name,
      slug: row.slug,
      sortOrder: row.sortOrder,
      status: row.status,
    });
    setDrawerOpen(true);
  };

  const startIconCrop = (file: File) => {
    if (!canEdit) return Upload.LIST_IGNORE;
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type || "")) {
      message.error("分类图标仅支持 JPG、PNG 或 WebP 图片");
      return Upload.LIST_IGNORE;
    }
    if (file.size > 20 * 1024 * 1024) {
      message.error("分类图标不能超过 20MB");
      return Upload.LIST_IGNORE;
    }
    closeCrop();
    const objectUrl = URL.createObjectURL(file);
    cropObjectUrlRef.current = objectUrl;
    setCropFile(file);
    setCropSourceUrl(objectUrl);
    setCropOpen(true);
    return Upload.LIST_IGNORE;
  };

  const createSquareCropFile = async (): Promise<File> => {
    if (!cropFile || !cropSourceUrl || !cropImageSize.width || !cropImageSize.height) {
      throw new Error("category_icon_crop_not_ready");
    }
    const outputSize = 512;
    const image = new Image();
    image.src = cropSourceUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("category_icon_decode_failed"));
    });
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("category_icon_canvas_unavailable");
    const scale = Math.max(outputSize / image.naturalWidth, outputSize / image.naturalHeight) * cropZoom;
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const maxX = Math.max(0, (width - outputSize) / 2);
    const maxY = Math.max(0, (height - outputSize) / 2);
    const x = (outputSize - width) / 2 + cropOffset.x * maxX;
    const y = (outputSize - height) / 2 + cropOffset.y * maxY;
    context.drawImage(image, x, y, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("category_icon_crop_failed")), "image/jpeg", 0.9);
    });
    const stem = cropFile.name.replace(/\.[^.]+$/, "") || "category-icon";
    return new File([blob], `${stem}-square.jpg`, { type: "image/jpeg" });
  };

  const uploadCroppedIcon = async () => {
    setIconUploading(true);
    let assetId: string | null = null;
    try {
      const file = await createSquareCropFile();
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
        xhr.onerror = () => reject(new Error("object_storage_upload_failed"));
        xhr.send(file);
      });
      const completed = await completeAdminBannerImageUpload(assetId, { ok: true, reportedContentLength: file.size });
      if (!completed.ok || completed.status !== "ready" || !completed.publicUrl) throw new Error("category_icon_verify_failed");
      form.setFieldValue("iconAssetId", assetId);
      setIconPreviewUrl(completed.publicUrl);
      message.success("分类图标已裁剪、上传并校验完成");
      closeCrop();
    } catch (e) {
      if (assetId) {
        try { await completeAdminBannerImageUpload(assetId, { ok: false, error: "category_icon_upload_failed" }); } catch { /* best effort */ }
      }
      message.error(errMsg(e, "分类图标上传失败"));
    } finally {
      setIconUploading(false);
    }
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
          <Form.Item name="iconAssetId" hidden><Input /></Form.Item>
          <Form.Item label="分类图标（1:1 裁剪）" extra="在热门类型与分类入口中按方形图标展示；上传后请在裁剪框内调整主体位置。">
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              {iconPreviewUrl ? (
                <img
                  src={iconPreviewUrl}
                  alt="分类图标预览"
                  style={{ width: 96, height: 96, borderRadius: 16, objectFit: "cover", border: "1px solid #f0f0f0" }}
                />
              ) : <Alert type="info" showIcon message="暂未上传图标" description="不上传不影响分类使用，但前台会使用默认样式。" />}
              <Upload accept="image/jpeg,image/png,image/webp" showUploadList={false} beforeUpload={startIconCrop} disabled={!canEdit || iconUploading}>
                <Button icon={<UploadOutlined />} loading={iconUploading} disabled={!canEdit}>
                  {iconPreviewUrl ? "更换并裁剪图标" : "上传并裁剪图标"}
                </Button>
              </Upload>
            </Space>
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

      <Modal
        title="裁剪分类图标"
        open={cropOpen}
        onCancel={() => !iconUploading && closeCrop()}
        onOk={uploadCroppedIcon}
        okText="确认裁剪并上传"
        cancelText="取消"
        confirmLoading={iconUploading}
        okButtonProps={{ disabled: !cropImageSize.width || !cropImageSize.height }}
        destroyOnClose
      >
        <Alert type="info" showIcon message="展示比例：1:1" description="拖动位置与缩放，重要主体请放在方框中央。" style={{ marginBottom: 16 }} />
        <div style={{ width: 300, height: 300, margin: "0 auto", overflow: "hidden", borderRadius: 18, background: "#171717", position: "relative" }}>
          {cropSourceUrl && (
            <img
              src={cropSourceUrl}
              alt="待裁剪分类图标"
              onLoad={(event) => setCropImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              style={cropPreviewGeometry ? {
                position: "absolute",
                left: `calc(50% + ${cropPreviewGeometry.offsetX}px)`,
                top: `calc(50% + ${cropPreviewGeometry.offsetY}px)`,
                width: cropPreviewGeometry.width,
                height: cropPreviewGeometry.height,
                maxWidth: "none",
                transform: "translate(-50%, -50%)",
                userSelect: "none",
              } : { width: "100%", height: "100%", objectFit: "cover", userSelect: "none" }}
            />
          )}
        </div>
        <Space direction="vertical" size={4} style={{ width: "100%", marginTop: 16 }}>
          <span>缩放</span>
          <Slider min={1} max={3} step={0.05} value={cropZoom} onChange={setCropZoom} />
          <span>左右位置</span>
          <Slider min={-1} max={1} step={0.05} value={cropOffset.x} onChange={(x) => setCropOffset((value) => ({ ...value, x }))} />
          <span>上下位置</span>
          <Slider min={-1} max={1} step={0.05} value={cropOffset.y} onChange={(y) => setCropOffset((value) => ({ ...value, y }))} />
        </Space>
      </Modal>
    </Space>
  );
};

export default CategoriesPage;
