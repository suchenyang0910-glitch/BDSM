import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message as antdMsg,
} from "antd";
import {
  LinkOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  bindAdminChannelPurpose,
  errMsg,
  listAdminChannels,
  listAdminPackages,
  listChannelDiscoveryRequests,
  refreshAdminChannels,
  submitChannelDiscoveryRequest,
} from "../api/client";
import type {
  AdminPackageItem,
  AdminRole,
  ChannelDiscoveryRequestItem,
  ChannelDiscoveryStatus,
  ChannelItem,
  ChannelRefreshResp,
  ManagedChannelPurpose,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";

dayjs.extend(relativeTime);

const { Text, Title } = Typography;
const { Option } = Select;

const VIEW_ROLES: AdminRole[] = ["super_admin"];
const EDIT_ROLES: AdminRole[] = ["super_admin"];

const PURPOSE_LABEL: Record<ManagedChannelPurpose, string> = {
  none: "未绑定用途",
  free_preview: "免费预览",
  membership_main: "会员主频道",
  package_channel: "内容包频道",
};

const PURPOSE_COLOR: Record<ManagedChannelPurpose, string> = {
  none: "default",
  free_preview: "green",
  membership_main: "gold",
  package_channel: "purple",
};

const DISCOVERY_STATUS_META: Record<ChannelDiscoveryStatus, { label: string; color: string }> = {
  pending_public_check: { label: "待公开校验", color: "processing" },
  awaiting_bot_admin: { label: "等待 Bot 管理员", color: "warning" },
  discovered: { label: "已发现", color: "blue" },
  bound: { label: "已绑定用途", color: "success" },
  conflict: { label: "发现冲突", color: "error" },
  failed: { label: "校验失败", color: "error" },
};

const REFRESH_REASON = "后台频道管理：刷新受控频道元数据与 Bot 权限状态";
const DISCOVERY_REASON = "后台频道管理：登记频道链接并等待 Webhook 自动发现";
const BIND_REASON = "后台频道管理：设置频道用途";

type FilterValues = {
  search?: string;
  purpose?: ManagedChannelPurpose;
  status?: ChannelDiscoveryStatus;
};

type DiscoveryFormValues = {
  channelLink: string;
  purpose?: ManagedChannelPurpose;
  packageId?: string;
  reason: string;
};

type BindFormValues = {
  purpose: ManagedChannelPurpose;
  packageId?: string;
  reason: string;
};

const ChannelsPage: React.FC = () => {
  const { me } = useAuth();
  const canView = !!me && VIEW_ROLES.includes(me.role);
  const canEdit = !!me && EDIT_ROLES.includes(me.role);

  const [filterForm] = Form.useForm<FilterValues>();
  const [discoveryForm] = Form.useForm<DiscoveryFormValues>();
  const [bindForm] = Form.useForm<BindFormValues>();
  const [refreshForm] = Form.useForm<{ reason: string; force?: boolean }>();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [bindSaving, setBindSaving] = useState(false);
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [requests, setRequests] = useState<ChannelDiscoveryRequestItem[]>([]);
  const [packages, setPackages] = useState<AdminPackageItem[]>([]);
  const [bindTarget, setBindTarget] = useState<ChannelItem | null>(null);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [refreshResult, setRefreshResult] = useState<ChannelRefreshResp | null>(null);

  const loadPackages = useCallback(async () => {
    try {
      const res = await listAdminPackages();
      setPackages(res.data);
    } catch (e) {
      antdMsg.error("内容包列表加载失败：" + errMsg(e, "未知错误"));
    }
  }, []);

  const fetchData = useCallback(async () => {
    if (!canView) return;
    const values = filterForm.getFieldsValue();
    setLoading(true);
    try {
      const [channelRes, requestRes] = await Promise.all([
        listAdminChannels({
          page,
          pageSize,
          search: values.search?.trim() || undefined,
          purpose: values.purpose,
          status: values.status,
        }),
        listChannelDiscoveryRequests(),
      ]);
      setChannels(channelRes.items);
      setTotal(channelRes.pagination.total);
      setRequests(requestRes.items);
    } catch (e) {
      antdMsg.error("频道管理数据加载失败：" + errMsg(e, "未知错误"));
    } finally {
      setLoading(false);
    }
  }, [canView, filterForm, page, pageSize]);

  useEffect(() => {
    if (!canView) return;
    void Promise.all([loadPackages(), fetchData()]);
  }, [canView, loadPackages, fetchData]);

  const onSearch = () => {
    setPage(1);
    void fetchData();
  };

  const onReset = () => {
    filterForm.resetFields();
    setPage(1);
    void fetchData();
  };

  const submitDiscovery = async (values: DiscoveryFormValues) => {
    setSubmitting(true);
    try {
      const res = await submitChannelDiscoveryRequest({
        channelLink: values.channelLink.trim(),
        purpose: values.purpose || "none",
        packageId: values.purpose === "package_channel" ? values.packageId || null : null,
        reason: values.reason.trim() || DISCOVERY_REASON,
      });
      antdMsg.success(
        res.mode === "public_verified"
          ? "公开频道已校验并登记。"
          : "私密频道登记成功，等待 Bot 被加入管理员后由 Webhook 自动发现。",
      );
      discoveryForm.setFieldsValue({
        channelLink: "",
        purpose: "none",
        packageId: undefined,
        reason: DISCOVERY_REASON,
      });
      await fetchData();
    } catch (e) {
      antdMsg.error("频道登记失败：" + errMsg(e, "未知错误"));
    } finally {
      setSubmitting(false);
    }
  };

  const openBindModal = (row: ChannelItem) => {
    setBindTarget(row);
    bindForm.setFieldsValue({
      purpose: row.purpose || "none",
      packageId: row.packageId || undefined,
      reason: BIND_REASON,
    });
  };

  const saveBind = async () => {
    if (!bindTarget) return;
    const values = await bindForm.validateFields();
    setBindSaving(true);
    try {
      await bindAdminChannelPurpose(bindTarget.chatIdHmac, {
        purpose: values.purpose,
        packageId: values.purpose === "package_channel" ? values.packageId || null : null,
        reason: values.reason,
      });
      antdMsg.success("频道用途已更新。");
      setBindTarget(null);
      await fetchData();
    } catch (e) {
      antdMsg.error("用途更新失败：" + errMsg(e, "未知错误"));
    } finally {
      setBindSaving(false);
    }
  };

  const submitRefresh = async (values: { reason: string; force?: boolean }) => {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const res = await refreshAdminChannels({
        reason: values.reason?.trim() || REFRESH_REASON,
        force: values.force === true,
      });
      setRefreshResult(res);
      antdMsg.success(`刷新完成：成功 ${res.summary.refreshed}，失败 ${res.summary.failed}`);
      await fetchData();
    } catch (e) {
      antdMsg.error("刷新失败：" + errMsg(e, "未知错误"));
    } finally {
      setRefreshing(false);
    }
  };

  const channelColumns = useMemo<ColumnsType<ChannelItem>>(
    () => [
      {
        title: "频道",
        key: "title",
        width: 240,
        fixed: "left",
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2}>
            <Space wrap>
              <Text strong>{row.title || "(未命名频道)"}</Text>
              <Tag color={row.isPrivate ? "red" : "green"}>{row.isPrivate ? "私密" : "公开"}</Tag>
              <Tag color={PURPOSE_COLOR[row.purpose]}>{PURPOSE_LABEL[row.purpose]}</Tag>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.type}
              {row.packageTitle ? ` · ${row.packageTitle}` : ""}
            </Text>
          </Space>
        ),
      },
      {
        title: "链接 / 脱敏 ID",
        key: "link",
        width: 280,
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2}>
            {row.publicUrl ? (
              <a href={row.publicUrl} target="_blank" rel="noreferrer">
                <LinkOutlined /> {row.publicUrl}
              </a>
            ) : row.username ? (
              <Text>@{row.username}</Text>
            ) : (
              <Text type="secondary">私密频道，无公开链接</Text>
            )}
            <Text code>{row.chatIdMasked}</Text>
          </Space>
        ),
      },
      {
        title: "Bot 权限",
        key: "bot",
        width: 260,
        render: (_: unknown, row) => (
          <Space wrap>
            <Tag color={row.botIsAdmin ? "success" : "default"}>{row.botIsAdmin ? "已是管理员" : "未设管理员"}</Tag>
            <Tag color={row.botCanPostMessages ? "blue" : "default"}>发帖</Tag>
            <Tag color={row.botCanInviteUsers ? "blue" : "default"}>邀请</Tag>
            <Tag color={row.botCanRestrictMembers ? "blue" : "default"}>踢人</Tag>
          </Space>
        ),
      },
      {
        title: "发现状态",
        key: "discovery",
        width: 240,
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2}>
            <Text>{row.lastDiscoveryUpdateType || "未收到 Webhook 事件"}</Text>
            {row.discoveryErrorCode ? (
              <Tag color="error">{row.discoveryErrorCode}</Tag>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                无发现错误
              </Text>
            )}
          </Space>
        ),
      },
      {
        title: "时间",
        key: "time",
        width: 200,
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              刷新 {row.refreshedAt ? dayjs(row.refreshedAt).fromNow() : "未刷新"}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              事件 {row.lastEventAt ? dayjs(row.lastEventAt).fromNow() : "无"}
            </Text>
          </Space>
        ),
      },
      {
        title: "操作",
        key: "actions",
        width: 140,
        fixed: "right",
        render: (_: unknown, row) => (
          <Button size="small" icon={<SaveOutlined />} disabled={!canEdit} onClick={() => openBindModal(row)}>
            设置用途
          </Button>
        ),
      },
    ],
    [canEdit],
  );

  const requestColumns = useMemo<ColumnsType<ChannelDiscoveryRequestItem>>(
    () => [
      {
        title: "提交链接",
        dataIndex: "submittedLink",
        key: "submittedLink",
        width: 320,
        render: (value: string, row) => (
          <Space direction="vertical" size={2}>
            <Text>{value}</Text>
            {row.normalizedLink ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {row.normalizedLink}
              </Text>
            ) : null}
          </Space>
        ),
      },
      {
        title: "状态",
        dataIndex: "status",
        key: "status",
        width: 180,
        render: (status: ChannelDiscoveryStatus) => (
          <Tag color={DISCOVERY_STATUS_META[status].color}>{DISCOVERY_STATUS_META[status].label}</Tag>
        ),
      },
      {
        title: "目标用途",
        key: "purpose",
        width: 180,
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2}>
            <Tag color={PURPOSE_COLOR[row.requestedPurpose]}>{PURPOSE_LABEL[row.requestedPurpose]}</Tag>
            {row.packageTitle ? <Text type="secondary">{row.packageTitle}</Text> : null}
          </Space>
        ),
      },
      {
        title: "已解析频道",
        key: "resolved",
        width: 220,
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2}>
            <Text>{row.resolvedChannelTitle || "待发现"}</Text>
            {row.resolvedChannelMasked ? <Text code>{row.resolvedChannelMasked}</Text> : null}
          </Space>
        ),
      },
      {
        title: "时间 / 错误",
        key: "time",
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              创建 {dayjs(row.createdAt).fromNow()}
            </Text>
            {row.waitingSince ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                等待自 {dayjs(row.waitingSince).fromNow()}
              </Text>
            ) : null}
            {row.lastErrorCode ? <Tag color="error">{row.lastErrorCode}</Tag> : null}
            {row.lastErrorNote ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {row.lastErrorNote}
              </Text>
            ) : null}
          </Space>
        ),
      },
    ],
    [],
  );

  if (!canView) {
    return (
      <Alert
        type="error"
        showIcon
        message="403 无权限"
        description="频道管理页仅超级管理员可用。"
      />
    );
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Webhook 自动发现频道"
        description={
          <div>
            <div>公开频道：输入 `@username` 或 `https://t.me/xxx`，服务端立即 `getChat` 校验。</div>
            <div>私密频道：输入邀请链接后进入“等待 Bot 管理员”，待 Telegram Webhook 收到 `my_chat_member / channel_post` 自动登记。</div>
            <div>前端不显示完整 chatId，只展示脱敏 ID 与 Bot 权限状态。</div>
          </div>
        }
      />

      <Form
        form={discoveryForm}
        layout="vertical"
        onFinish={submitDiscovery}
        initialValues={{ purpose: "none", reason: DISCOVERY_REASON }}
        style={{ marginBottom: 16 }}
      >
        <Space align="start" wrap style={{ width: "100%" }}>
          <Form.Item
            label="频道链接"
            name="channelLink"
            rules={[{ required: true, message: "请输入公开频道链接或私密邀请链接" }]}
            style={{ minWidth: 360, flex: 1 }}
          >
            <Input placeholder="@channel_name / https://t.me/xxx / https://t.me/+xxxx" />
          </Form.Item>
          <Form.Item label="用途" name="purpose" style={{ width: 180 }}>
            <Select>
              <Option value="none">先不绑定</Option>
              <Option value="free_preview">免费预览</Option>
              <Option value="membership_main">会员主频道</Option>
              <Option value="package_channel">内容包频道</Option>
            </Select>
          </Form.Item>
          <Form.Item noStyle dependencies={["purpose"]}>
            {({ getFieldValue }) =>
              getFieldValue("purpose") === "package_channel" ? (
                <Form.Item
                  label="内容包"
                  name="packageId"
                  rules={[{ required: true, message: "请选择内容包" }]}
                  style={{ width: 220 }}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={packages.map((pkg) => ({ value: pkg.id, label: pkg.title }))}
                  />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item
            label="操作原因"
            name="reason"
            rules={[{ required: true, min: 2, max: 1000 }]}
            style={{ minWidth: 320, flex: 1 }}
          >
            <Input />
          </Form.Item>
          <Form.Item label=" " style={{ marginTop: 30 }}>
            <Button type="primary" htmlType="submit" loading={submitting}>
              提交登记
            </Button>
          </Form.Item>
        </Space>
      </Form>

      <div style={{ marginBottom: 16 }}>
        <Form form={filterForm} layout="inline" onFinish={onSearch}>
          <Form.Item name="search" label="关键词">
            <Input allowClear placeholder="频道名 / @username / 链接" style={{ width: 240 }} />
          </Form.Item>
          <Form.Item name="purpose" label="用途">
            <Select allowClear placeholder="全部" style={{ width: 180 }}>
              <Option value="none">未绑定用途</Option>
              <Option value="free_preview">免费预览</Option>
              <Option value="membership_main">会员主频道</Option>
              <Option value="package_channel">内容包频道</Option>
            </Select>
          </Form.Item>
          <Form.Item name="status" label="发现状态">
            <Select allowClear placeholder="全部" style={{ width: 180 }}>
              {(Object.keys(DISCOVERY_STATUS_META) as ChannelDiscoveryStatus[]).map((status) => (
                <Option key={status} value={status}>
                  {DISCOVERY_STATUS_META[status].label}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">筛选</Button>
              <Button onClick={onReset}>重置</Button>
              <Button icon={<ReloadOutlined />} onClick={() => {
                refreshForm.setFieldsValue({ reason: REFRESH_REASON, force: false });
                setRefreshResult(null);
                setRefreshOpen(true);
              }}>
                刷新元数据
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </div>

      <Title level={5}>受控频道</Title>
      <Table<ChannelItem>
        rowKey="chatIdHmac"
        columns={channelColumns}
        dataSource={channels}
        loading={loading}
        scroll={{ x: 1320 }}
        locale={{ emptyText: <Empty description="暂无受控频道。先登记公开链接，或登记私密邀请链接后等待 Webhook 自动发现。" /> }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showQuickJumper: true,
          onChange: (nextPage, nextPageSize) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          },
          showTotal: (value, range) => `${range[0]}-${range[1]} / ${value} 条`,
        }}
      />

      <Title level={5} style={{ marginTop: 24 }}>最近登记请求</Title>
      <Table<ChannelDiscoveryRequestItem>
        rowKey="id"
        columns={requestColumns}
        dataSource={requests}
        loading={loading}
        scroll={{ x: 1100 }}
        pagination={false}
        locale={{ emptyText: <Empty description="暂无登记请求。" /> }}
      />

      <Modal
        open={!!bindTarget}
        title="设置频道用途"
        onCancel={() => !bindSaving && setBindTarget(null)}
        onOk={saveBind}
        confirmLoading={bindSaving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={bindForm} layout="vertical">
          <Form.Item label="频道">
            <Text strong>{bindTarget?.title || "(未命名频道)"}</Text>
            {bindTarget?.chatIdMasked ? (
              <div style={{ marginTop: 4 }}>
                <Text code>{bindTarget.chatIdMasked}</Text>
              </div>
            ) : null}
          </Form.Item>
          <Form.Item name="purpose" label="用途" rules={[{ required: true }]}>
            <Select>
              <Option value="none">先不绑定</Option>
              <Option value="free_preview">免费预览</Option>
              <Option value="membership_main">会员主频道</Option>
              <Option value="package_channel">内容包频道</Option>
            </Select>
          </Form.Item>
          <Form.Item noStyle dependencies={["purpose"]}>
            {({ getFieldValue }) =>
              getFieldValue("purpose") === "package_channel" ? (
                <Form.Item name="packageId" label="内容包" rules={[{ required: true, message: "请选择内容包" }]}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={packages.map((pkg) => ({ value: pkg.id, label: pkg.title }))}
                  />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="reason" label="操作原因" rules={[{ required: true, min: 2, max: 1000 }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={refreshOpen}
        title="刷新频道元数据"
        onCancel={() => !refreshing && setRefreshOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Form form={refreshForm} layout="vertical" onFinish={submitRefresh}>
          <Form.Item name="reason" label="操作原因" rules={[{ required: true, min: 2, max: 1000 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="force" valuePropName="checked">
            <label style={{ display: "inline-flex", gap: 8 }}>
              <input
                type="checkbox"
                checked={!!refreshForm.getFieldValue("force")}
                onChange={(e) => refreshForm.setFieldsValue({ force: e.target.checked })}
              />
              <span>强制刷新（绕过缓存）</span>
            </label>
          </Form.Item>
          <Space style={{ marginBottom: 12 }}>
            <Button type="primary" htmlType="submit" loading={refreshing}>
              开始刷新
            </Button>
            <Button disabled={refreshing} onClick={() => setRefreshOpen(false)}>
              关闭
            </Button>
          </Space>
          {refreshResult ? (
            <Alert
              type={refreshResult.summary.failed > 0 ? "warning" : "success"}
              showIcon
              message="刷新完成"
              description={`处理 ${refreshResult.summary.processed} 个频道，成功 ${refreshResult.summary.refreshed}，失败 ${refreshResult.summary.failed}。`}
            />
          ) : null}
        </Form>
      </Modal>
    </div>
  );
};

export default ChannelsPage;
