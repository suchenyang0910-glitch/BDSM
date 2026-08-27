import React from "react";
import { Alert, Button, Card, Form, Input, Space, Typography, message } from "antd";
import { adminMe, errMsg, getAdminPlatformMetadata, updateAdminPlatformMetadata } from "../api/client";
import type { AdminMe, PlatformMetadata } from "../api/types";
import DelimitedTagInput from "../components/DelimitedTagInput";
import type { DelimitedInputState } from "../utils/delimitedTagInput";

const { Title, Text } = Typography;
const { TextArea } = Input;

const PlatformMetadataPage: React.FC = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [me, setMe] = React.useState<AdminMe | null>(null);
  const [metadata, setMetadata] = React.useState<PlatformMetadata | null>(null);
  const [fieldStates, setFieldStates] = React.useState<Record<string, DelimitedInputState>>({});

  const canManage = React.useMemo(() => me?.role === "super_admin", [me]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [meta, currentMe] = await Promise.all([getAdminPlatformMetadata(), adminMe()]);
      setMetadata(meta);
      setMe(currentMe);
      form.setFieldsValue({
        seoTitle: meta.seoTitle,
        seoDescription: meta.seoDescription,
        seoKeywords: meta.seoKeywords || [],
        geoKeywords: meta.geoKeywords || [],
        reason: "",
      });
      setFieldStates({});
    } catch (e) {
      message.error(errMsg(e, "加载平台 SEO / GEO 设置失败"));
    } finally {
      setLoading(false);
    }
  }, [form]);

  const updateFieldState = React.useCallback((field: string, state: DelimitedInputState) => {
    setFieldStates((prev) => ({ ...prev, [field]: state }));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const onSubmit = async () => {
    try {
      const values = await form.validateFields();
      const currentIssues = Object.values(fieldStates).flatMap((state) => state.errors);
      if (currentIssues.length > 0) {
        message.error("请先修正 SEO / GEO 关键词中的错误项");
        return;
      }
      setSaving(true);
      const resp = await updateAdminPlatformMetadata({
        seoTitle: values.seoTitle || null,
        seoDescription: values.seoDescription || null,
        seoKeywords: values.seoKeywords || [],
        geoKeywords: values.geoKeywords || [],
        reason: values.reason || undefined,
      });
      setMetadata(resp.platformMetadata);
      message.success("平台 SEO / GEO 已更新");
      form.setFieldValue("reason", "");
    } catch (e) {
      message.error(errMsg(e, "保存平台 SEO / GEO 失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card loading={loading}>
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Title level={5} style={{ margin: 0 }}>平台 SEO / GEO</Title>
          <Text type="secondary">
            H5 当前仍保持 `noindex,nofollow`，这里先提前维护平台默认 SEO 标题、描述、关键词和 GEO 主题词；单个视频未配置时自动继承。
          </Text>
          <Alert
            type={canManage ? "info" : "warning"}
            showIcon
            message={canManage ? "仅 super_admin 可修改；其他角色只读。" : "你当前只有查看权限，无法修改。"}
            description="GEO 仅用于生成式搜索主题词，不收集用户位置。SEO / GEO 关键词不会自动泄露为 Telegram 标签。"
          />
        </Space>
      </Card>

      <Card
        title="默认元信息"
        extra={
          <Space>
            <Button onClick={load} disabled={saving}>刷新</Button>
            <Button type="primary" onClick={onSubmit} loading={saving} disabled={!canManage}>保存</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="seoTitle" label="平台默认 SEO 标题">
            <Input maxLength={120} placeholder="未填则前台回落到页面标题" disabled={!canManage} />
          </Form.Item>
          <Form.Item name="seoDescription" label="平台默认 SEO 描述">
            <TextArea rows={4} maxLength={300} placeholder="未填则前台回落到页面说明" disabled={!canManage} />
          </Form.Item>
          <Form.Item name="seoKeywords" label="平台默认 SEO 关键词">
            <DelimitedTagInput
              mode="keyword"
              disabled={!canManage}
              selectPlaceholder="输入 SEO 关键词后回车"
              textareaPlaceholder="支持直接粘贴逗号分隔关键词；兼容中文逗号、换行、分号。"
              onStateChange={(state) => updateFieldState("seoKeywords", state)}
            />
          </Form.Item>
          <Form.Item name="geoKeywords" label="平台默认 GEO 主题词">
            <DelimitedTagInput
              mode="keyword"
              disabled={!canManage}
              selectPlaceholder="输入 GEO 主题词后回车"
              textareaPlaceholder="支持直接粘贴逗号分隔主题词；词组空格会保留。"
              onStateChange={(state) => updateFieldState("geoKeywords", state)}
            />
          </Form.Item>
          <Form.Item name="reason" label="变更原因">
            <TextArea rows={2} maxLength={500} placeholder="建议填写本次调整的业务原因，便于审计。" disabled={!canManage} />
          </Form.Item>
        </Form>
      </Card>

      {metadata && (
        <Card size="small" title="当前生效快照">
          <Space direction="vertical" size={4}>
            <Text>标题：{metadata.seoTitle || "—"}</Text>
            <Text>描述：{metadata.seoDescription || "—"}</Text>
            <Text>SEO 关键词：{metadata.seoKeywords.join(" / ") || "—"}</Text>
            <Text>GEO 主题词：{metadata.geoKeywords.join(" / ") || "—"}</Text>
            <Text type="secondary">更新时间：{metadata.updatedAt || "—"}</Text>
            <Text type="secondary">更新人：{metadata.updatedBy || "—"}</Text>
          </Space>
        </Card>
      )}
    </Space>
  );
};

export default PlatformMetadataPage;
