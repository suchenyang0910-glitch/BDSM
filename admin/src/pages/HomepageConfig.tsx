import React from "react";
import {
  Card,
  Typography,
  Tag,
  Space,
  Button,
  InputNumber,
  Divider,
  List,
  Row,
  Col,
  Statistic,
  Select,
  Form,
  Input,
  message,
  Modal,
  Alert,
  Empty,
  Tooltip,
} from "antd";
import { SaveOutlined, ReloadOutlined, RocketOutlined, CheckCircleOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import {
  getAdminHomepageDraft,
  getAdminHomepagePublished,
  putAdminHomepageDraft,
  publishAdminHomepage,
  getPublicApiHome,
  listAdminBanners,
  listAdminContents,
  listAdminCategories,
  adminMe,
  errMsg,
} from "../api/client";
import type {
  HomepageVersionItem,
  HomepageConfig,
  BannerItem,
  ContentItem,
  CategoryItem,
  AdminMe,
  ApiHomeResp,
} from "../api/types";

const { Title, Text, Paragraph } = Typography;
const { Option } = Select;
const { TextArea } = Input;

type BannerDict = Record<string, BannerItem>;
type ContentDict = Record<string, ContentItem>;
type CategoryDict = Record<string, CategoryItem>;

const MAX_RECOMMEND = 6;
const MAX_FEATURED = 1;
const MAX_THEMES = 4;

const SECTION_META = {
  banners: { label: "首页 Banner", max: 3, color: "blue", icon: "🖼️" },
  recommend: { label: "最新上架候选", max: MAX_RECOMMEND, color: "geekblue", icon: "🆕" },
  featured: { label: "今日精选", max: MAX_FEATURED, color: "purple", icon: "💎" },
  categories: { label: "本周主题", max: MAX_THEMES, color: "green", icon: "📂" },
} as const;

const HomepageConfigPage: React.FC = () => {
  const [draft, setDraft] = React.useState<HomepageVersionItem | null>(null);
  const [published, setPublished] = React.useState<HomepageVersionItem | null>(null);
  const [homeResp, setHomeResp] = React.useState<ApiHomeResp | null>(null);

  const [banners, setBanners] = React.useState<BannerItem[]>([]);
  const [contents, setContents] = React.useState<ContentItem[]>([]);
  const [categories, setCategories] = React.useState<CategoryItem[]>([]);
  const [me, setMe] = React.useState<AdminMe | null>(null);

  const [loading, setLoading] = React.useState(false);
  const [savingDraft, setSavingDraft] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [refreshingHome, setRefreshingHome] = React.useState(false);

  const [config, setConfig] = React.useState<HomepageConfig>({
    bannerIds: [],
    recommendContentIds: [],
    featuredContentIds: [],
    categoryOrderIds: [],
  });
  const [versionLabel, setVersionLabel] = React.useState<string>("");
  const [note, setNote] = React.useState<string>("");
  const [form] = Form.useForm();

  const bannerDict: BannerDict = React.useMemo(
    () => banners.reduce((acc, b) => { acc[b.id] = b; return acc; }, {} as BannerDict),
    [banners],
  );
  const contentDict: ContentDict = React.useMemo(
    () => contents.reduce((acc, c) => { acc[c.id] = c; return acc; }, {} as ContentDict),
    [contents],
  );
  const categoryDict: CategoryDict = React.useMemo(
    () => categories.reduce((acc, c) => { acc[c.id] = c; return acc; }, {} as CategoryDict),
    [categories],
  );

  const canEdit = React.useMemo(() => {
    if (!me) return false;
    return ["super_admin", "operator", "editor"].includes(me.role);
  }, [me]);

  const canPublish = React.useMemo(() => {
    if (!me) return false;
    return ["super_admin", "editor"].includes(me.role);
  }, [me]);

  const loadAll = React.useCallback(async () => {
    setLoading(true);
    try {
      const [dResp, pResp, bResp, tResp, cResp, mResp] = await Promise.all([
        getAdminHomepageDraft().catch(() => ({ draft: null })),
        getAdminHomepagePublished().catch(() => ({ published: null, recent: [] })),
        listAdminBanners(),
        // 服务端内容列表单次上限为 100；首期首页配置只加载最新 100 条候选内容。
        listAdminContents({ limit: 100 }),
        listAdminCategories(),
        adminMe().catch(() => null as AdminMe | null),
      ]);
      setDraft(dResp.draft);
      setPublished(pResp.published);
      setBanners(bResp.data);
      setContents(tResp.data);
      setCategories(cResp.data);
      setMe(mResp);
      if (dResp.draft) {
        setConfig(dResp.draft.config);
        setVersionLabel(dResp.draft.versionLabel || "");
        setNote(dResp.draft.note || "");
      }
      await refreshPublicHome(false);
    } catch (e) {
      message.error(errMsg(e, "加载首页配置失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  const refreshPublicHome = async (showToast = true) => {
    setRefreshingHome(true);
    try {
      const resp = await getPublicApiHome();
      setHomeResp(resp);
      if (showToast) message.success("已拉取 Mini App 实时渲染数据");
    } catch (e) {
      if (showToast) message.error(errMsg(e, "拉取 /api/home 失败"));
    } finally {
      setRefreshingHome(false);
    }
  };

  const saveDraft = async () => {
    try {
      setSavingDraft(true);
      const resp = await putAdminHomepageDraft({
        versionLabel: versionLabel || null,
        note: note || null,
        config,
        reason: `运营保存首页草稿：${versionLabel || "(无标签)"}`,
      });
      message.success("草稿已保存");
      const fresh = await getAdminHomepageDraft();
      setDraft(fresh.draft);
    } catch (e) {
      message.error(errMsg(e, "保存草稿失败"));
    } finally {
      setSavingDraft(false);
    }
  };

  const openPublishModal = () => {
    form.resetFields();
    form.setFieldsValue({
      versionLabel: versionLabel || undefined,
      publishedNote: undefined,
      reason: undefined,
    });
    Modal.confirm({
      title: "发布首页版本",
      icon: <RocketOutlined />,
      okText: "确认发布",
      okButtonProps: { danger: true },
      cancelText: "取消",
      width: 620,
      content: (
        <Form form={form} layout="vertical" preserve={false}>
          <Alert
            type="warning"
            showIcon
            message="发布后 Mini App 用户将立即看到此首页配置。"
            description="系统会自动将旧 published 版本标记为 archived，保证同时仅有一个生效版本。"
            style={{ marginBottom: 16 }}
          />
          <Form.Item name="versionLabel" label="版本标签（可选）" extra="例如：2025-W13、春日上新 v2">
            <Input placeholder="v1.0 / 2025-W13" maxLength={80} />
          </Form.Item>
          <Form.Item name="publishedNote" label="发布说明（可选）" extra="变更摘要，将记录在版本中">
            <TextArea rows={3} placeholder="本次发布包含的 Banner/推荐/精选变更…" maxLength={2000} />
          </Form.Item>
          <Form.Item
            name="reason"
            label="发布理由（推荐填写，写入审计日志）"
            extra="2~1000 字符，会被 admin_audit_logs 永久记录"
          >
            <TextArea rows={3} placeholder="例如：周度运营迭代，替换春季主题 Banner 与推荐内容" />
          </Form.Item>
        </Form>
      ),
      onOk: async () => {
        try {
          const values = await form.validateFields();
          setPublishing(true);
          const draftId = draft?.id;
          if (!draftId) {
            message.error("当前无草稿，请先保存草稿再发布");
            return;
          }
          const reasonFinal = (values.reason || "").trim() || `管理员发布首页：${values.versionLabel || "(无标签)"}`;
          const resp = await publishAdminHomepage({
            id: draftId,
            versionLabel: (values.versionLabel || versionLabel || null) as string | null,
            publishedNote: (values.publishedNote || null) as string | null,
            reason: reasonFinal,
          });
          message.success(`发布成功！版本 ID：${resp.id.slice(0, 8)}…  发布时间：${dayjs(resp.publishedAt).format("HH:mm:ss")}`);
          const [pResp, dResp] = await Promise.all([
            getAdminHomepagePublished(),
            getAdminHomepageDraft(),
          ]);
          setPublished(pResp.published);
          setDraft(dResp.draft);
          if (dResp.draft) {
            setConfig(dResp.draft.config);
            setVersionLabel(dResp.draft.versionLabel || "");
            setNote(dResp.draft.note || "");
          }
          await refreshPublicHome();
        } catch (e) {
          message.error(errMsg(e, "发布失败"));
          throw e;
        } finally {
          setPublishing(false);
        }
      },
    });
  };

  const diffSummary = React.useMemo(() => {
    if (!published) return { banners: 0, recommend: 0, featured: 0, categories: 0 };
    const pc = published.config;
    return {
      banners: pc.bannerIds.filter((id, i) => id !== config.bannerIds[i]).length + Math.abs(pc.bannerIds.length - config.bannerIds.length),
      featured: pc.featuredContentIds.filter((id, i) => id !== config.featuredContentIds[i]).length + Math.abs(pc.featuredContentIds.length - config.featuredContentIds.length),
      categories: pc.categoryOrderIds.filter((id, i) => id !== config.categoryOrderIds[i]).length + Math.abs(pc.categoryOrderIds.length - config.categoryOrderIds.length),
    };
  }, [published, config]);

  const totalDiff = diffSummary.banners + diffSummary.featured + diffSummary.categories;

  const publishedContentIds = React.useMemo(
    () => new Set(contents.filter((c) => c.status === "published").map((c) => c.id)),
    [contents],
  );
  const activeCategoryIds = React.useMemo(
    () => new Set(categories.filter((c) => c.status === "active").map((c) => c.id)),
    [categories],
  );
  const activeBannerIds = React.useMemo(
    () => new Set(banners.filter((b) => b.status === "active" || b.status === "scheduled").map((b) => b.id)),
    [banners],
  );

  const warnIds = (ids: string[], valid: Set<string>, name: string) => {
    const bad = ids.filter((id) => !valid.has(id));
    if (bad.length === 0) return null;
    return (
      <Alert
        type="warning"
        showIcon
        closable
        message={`${name} 包含 ${bad.length} 个未发布/停用的 ID，发布后将被 /api/home 自动过滤`}
        description={bad.slice(0, 6).map((id) => id.slice(0, 10) + "…").join(", ")}
        style={{ marginTop: 8 }}
      />
    );
  };

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Card>
            <Statistic
              title="当前生效版本"
              value={published ? (published.versionLabel || published.id.slice(0, 10) + "…") : "未发布"}
              valueStyle={{ color: published ? "#3f8600" : "#bfbfbf" }}
              prefix={published ? <CheckCircleOutlined /> : undefined}
            />
            <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              {published
                ? `发布：${dayjs(published.publishedAt).format("YYYY-MM-DD HH:mm")} · ${published.publisher?.displayName || published.publisher?.email || published.publishedBy || "未知"}`
                : "还没有发布过任何版本，Mini App /api/home 将返回空骨架。"}
            </Paragraph>
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="草稿 vs 生效 差异条目"
              value={totalDiff}
              valueStyle={{ color: totalDiff > 0 ? "#1677ff" : "#52c41a" }}
              suffix="处"
            />
            <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              Banner {diffSummary.banners} · 今日精选 {diffSummary.featured} · 本周主题 {diffSummary.categories}
            </Paragraph>
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="/api/home 已发布版本 ID"
              value={homeResp?.versionId ? (homeResp.versionLabel || homeResp.versionId.slice(0, 10) + "…") : "未同步"}
              valueStyle={{ color: homeResp?.versionId ? "#722ed1" : "#bfbfbf" }}
            />
            <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              {homeResp
                ? `生成：${dayjs(homeResp.meta.generatedAt).format("HH:mm:ss")} · banner ${homeResp.banners.length} · content ${homeResp.contents.length} · cat ${homeResp.categories.length}`
                : "点击右上角「拉取实时渲染」读取公开 API。"}
            </Paragraph>
          </Card>
        </Col>
      </Row>

      <Card
        title={<Title level={5} style={{ margin: 0 }}>首页编排草稿（Draft）</Title>}
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={refreshingHome}
              onClick={() => refreshPublicHome(true)}
            >
              拉取实时渲染
            </Button>
            <Button
              icon={<SaveOutlined />}
              loading={savingDraft}
              onClick={saveDraft}
              disabled={!canEdit || loading}
            >
              保存草稿
            </Button>
            <Button
              icon={<RocketOutlined />}
              type="primary"
              danger
              loading={publishing}
              onClick={openPublishModal}
              disabled={!canPublish || loading || !draft}
            >
              发布首页
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Row gutter={[16, 0]}>
            <Col span={8}>
              <Form layout="inline" style={{ marginTop: 0 }}>
                <Form.Item label="版本标签" style={{ marginBottom: 0 }}>
                  <Input
                    placeholder="v1.0 / 2025-W13"
                    maxLength={80}
                    value={versionLabel}
                    onChange={(e) => setVersionLabel(e.target.value)}
                    disabled={!canEdit}
                  />
                </Form.Item>
              </Form>
            </Col>
            <Col span={16}>
              <Text type="secondary">
                草稿 ID：{draft?.id ? draft.id.slice(0, 16) + "…" : "（未保存过）"}
                {draft?.updatedAt && ` · 上次保存：${dayjs(draft.updatedAt).format("YYYY-MM-DD HH:mm")}`}
              </Text>
            </Col>
          </Row>

          <Alert
            type="info"
            showIcon
            message="本页按视频点播版 PRD 编排首页"
            description="这里维护 3 类核心元素：Banner（0-3）、今日精选（最多 1 条）、本周主题（最多 4 个分类）。「最新上架」由前台自动读取最新已发布内容，不再单独手工堆卡。"
          />

          <Space size={16} wrap>
            <InputAddonTag title="Banner" ids={config.bannerIds} max={SECTION_META.banners.max} color={SECTION_META.banners.color} icon={SECTION_META.banners.icon}
              options={banners.map((b) => ({ id: b.id, label: `${b.title}  [${b.slot}]`, meta: `${b.status}` }))}
              value={config.bannerIds}
              onChange={(ids) => setConfig({ ...config, bannerIds: ids })}
              disabled={!canEdit}
            />
            <InputAddonTag title="今日精选" ids={config.featuredContentIds} max={SECTION_META.featured.max} color={SECTION_META.featured.color} icon={SECTION_META.featured.icon}
              options={contents.filter((c) => publishedContentIds.has(c.id)).map((c) => ({ id: c.id, label: c.title, meta: `${c.categories.map((x) => x.name).join("/") || "未分类"}` }))}
              value={config.featuredContentIds}
              onChange={(ids) => setConfig({ ...config, featuredContentIds: ids })}
              disabled={!canEdit}
            />
            <InputAddonTag title="本周主题" ids={config.categoryOrderIds} max={SECTION_META.categories.max} color={SECTION_META.categories.color} icon={SECTION_META.categories.icon}
              options={categories.filter((c) => activeCategoryIds.has(c.id)).map((c) => ({ id: c.id, label: c.name, meta: c.slug }))}
              value={config.categoryOrderIds}
              onChange={(ids) => setConfig({ ...config, categoryOrderIds: ids })}
              disabled={!canEdit}
            />
          </Space>

          {warnIds(config.bannerIds, activeBannerIds, "Banner 列表")}
          {warnIds(config.featuredContentIds, publishedContentIds, "今日精选")}
          {warnIds(config.categoryOrderIds, activeCategoryIds, "本周主题")}
        </Space>
      </Card>

      <Divider orientation="left"><Text strong>实时渲染预览（/api/home 实际输出）</Text></Divider>

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Card title={
            <Space><Tag color={SECTION_META.banners.color}>{SECTION_META.banners.icon} Banner</Tag>
              <Text type="secondary">{homeResp?.banners.length || 0} 张</Text></Space>
          }>
            {!homeResp?.banners.length ? <Empty description="无 Banner" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
              <List
                size="small"
                dataSource={homeResp.banners}
                renderItem={(b, idx) => (
                  <List.Item key={b.id}>
                    <Space>
                      <Tag color="blue">#{idx + 1}</Tag>
                      <Space direction="vertical" size={0}>
                        <Text strong>{b.title || "(无标题)"}</Text>
                        {b.eyebrow && <Text type="secondary" style={{ fontSize: 12 }}>{b.eyebrow}</Text>}
                        <Text style={{ fontSize: 12 }}>
                          target={b.targetType || "none"} {b.targetId || b.externalUrl || ""}
                        </Text>
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
        <Col span={8}>
          <Card title={
            <Space><Tag color={SECTION_META.featured.color}>{SECTION_META.featured.icon} 今日精选</Tag>
              <Text type="secondary">{homeResp?.featuredContent ? 1 : 0} 条</Text></Space>
          }>
            {!homeResp?.featuredContent ? <Empty description="未配置今日精选" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
              <List
                size="small"
                dataSource={[homeResp.featuredContent]}
                renderItem={(c) => (
                  <List.Item key={c.id}>
                    <Space direction="vertical" size={0} style={{ width: "100%" }}>
                      <Space>
                        {c.tag && <Tag color="gold">{c.tag}</Tag>}
                        <Text strong>{c.title}</Text>
                        {c.unlocked ? <Tag color="green">已解锁</Tag> : <Tag color="red">{c.accessType}</Tag>}
                      </Space>
                      <Text style={{ fontSize: 12, color: "#999" }}>{c.categoryName || c.categoryId.slice(0, 8)}… {c.duration || ""}</Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
        <Col span={8}>
          <Card title={
            <Space><Tag color={SECTION_META.categories.color}>{SECTION_META.categories.icon} 分类排序</Tag>
              <Text type="secondary">{homeResp?.themeCategories?.length || 0} 个</Text></Space>
          }>
            {!homeResp?.themeCategories?.length ? <Empty description="无本周主题" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
              <List
                size="small"
                dataSource={homeResp.themeCategories}
                renderItem={(c, idx) => (
                  <List.Item key={c.id}>
                    <Space>
                      <Tag color="green">#{idx + 1}</Tag>
                      <Space direction="vertical" size={0}>
                        <Text strong>{c.name}</Text>
                        <Text style={{ fontSize: 12, color: "#999" }}>
                          {c.slug} · 已发布 {c.publishedContentCount ?? "-"} 篇
                        </Text>
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
};

interface AddonProps {
  title: string;
  ids: string[];
  max: number;
  color: string;
  icon: string;
  options: Array<{ id: string; label: string; meta?: string }>;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

const InputAddonTag: React.FC<AddonProps> = ({ title, ids, max, color, icon, options, value, onChange, disabled }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <Card
      size="small"
      style={{ width: 340 }}
      title={
        <Space>
          <Tag color={color}>{icon} {title}</Tag>
          <Text type="secondary">{value.length} / {max}</Text>
        </Space>
      }
      extra={
        <Tooltip title="点击配置">
          <Button size="small" onClick={() => setOpen(true)} disabled={disabled}>
            配置
          </Button>
        </Tooltip>
      }
    >
      {value.length === 0 ? (
        <Empty description={<Text type="secondary" style={{ fontSize: 12 }}>尚未配置</Text>} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <List
          size="small"
          dataSource={value.slice(0, Math.min(value.length, max))}
          locale={{ emptyText: "空" }}
          renderItem={(id, idx) => {
            const found = options.find((o) => o.id === id);
            return (
              <List.Item key={id + idx}>
                <Space size={8} style={{ width: "100%" }}>
                  <Tag color={color} style={{ flexShrink: 0 }}>#{idx + 1}</Tag>
                  <Space direction="vertical" size={0} style={{ minWidth: 0, flex: 1 }}>
                    <Text ellipsis style={{ fontSize: 13, maxWidth: 180 }}>
                      {found ? found.label : <span style={{ color: "#ff4d4f" }}>未知ID: {id.slice(0, 14)}…</span>}
                    </Text>
                    {found?.meta && <Text type="secondary" style={{ fontSize: 11 }}>{found.meta}</Text>}
                  </Space>
                </Space>
              </List.Item>
            );
          }}
        />
      )}
      <Modal
        title={`配置${title}（按选择顺序 = 展示顺序，最多 ${max} 项）`}
        open={open}
        onCancel={() => setOpen(false)}
        width={720}
        footer={[
          <Button key="cancel" onClick={() => setOpen(false)}>取消</Button>,
          <Button key="apply" type="primary" onClick={() => setOpen(false)}>应用关闭</Button>,
        ]}
      >
        <Select
          mode="multiple"
          allowClear
          showSearch
          filterOption={(input, option) => ((option?.label || "") as string).toLowerCase().includes(input.toLowerCase())}
          placeholder={`选择 ${title}（按勾选顺序排序，可拖拽列表已选项调整顺序）`}
          style={{ width: "100%" }}
          value={value}
          onChange={(ids) => onChange(ids.slice(0, max))}
          disabled={disabled}
          maxTagCount={20}
          listHeight={420}
          optionLabelProp="label"
        >
          {options.map((o) => (
            <Option key={o.id} value={o.id} label={o.label}>
              <Space size={12}>
                <Text strong>{o.label}</Text>
                {o.meta && <Text type="secondary" style={{ fontSize: 12 }}>{o.meta}</Text>}
                <Text type="secondary" style={{ fontSize: 11, marginLeft: "auto" }}>{o.id.slice(0, 10)}…</Text>
              </Space>
            </Option>
          ))}
        </Select>
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message="提示：最终展示顺序 = 你选择时的顺序。可先清空再按期望顺序逐项勾选。"
          description={`已选 ${value.length} / 上限 ${max}。超出部分将被自动截断。`}
        />
      </Modal>
    </Card>
  );
};

export default HomepageConfigPage;
