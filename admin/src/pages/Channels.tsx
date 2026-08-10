import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Table,
  Button,
  Space,
  Input,
  Select,
  Form,
  Tag,
  Modal,
  Empty,
  Tooltip,
  message as antdMsg,
  Typography,
  Alert,
} from "antd";
import {
  SearchOutlined,
  ReloadOutlined,
  PlusOutlined,
  EyeOutlined,
  CopyOutlined,
  ExclamationCircleFilled,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  listAdminChannels,
  refreshAdminChannels,
  addAdminChannel,
  revealAdminChannelId,
  errMsg,
} from "../api/client";
import type {
  ChannelItem,
  ChannelSource,
  AdminRole,
  ChannelRefreshResp,
  ChannelRefreshError,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";

dayjs.extend(relativeTime);

const { Text, Title } = Typography;
const { Option } = Select;
const { confirm } = Modal;

const VIEW_ROLES: AdminRole[] = ["super_admin"];
const REFRESH_ROLES: AdminRole[] = ["super_admin"];
const ADD_ROLES: AdminRole[] = ["super_admin"];
const REVEAL_ROLES: AdminRole[] = ["super_admin"];

const SOURCE_META: Record<ChannelSource, { label: string; color: string }> = {
  auto_scan: { label: "自动扫描", color: "blue" },
  manual_add: { label: "手动添加", color: "purple" },
};

const CHAT_TYPE_META: Record<string, { label: string; color: string }> = {
  channel: { label: "频道 Channel", color: "geekblue" },
  supergroup: { label: "超级群", color: "green" },
  group: { label: "普通群", color: "cyan" },
  private: { label: "私聊", color: "gold" },
  unknown: { label: "未知", color: "default" },
};

const DEFAULT_REASON_REFRESH = "后台频道管理：刷新 Bot 管理的全部频道元数据";
const DEFAULT_REASON_ADD = "后台频道管理：手动录入冷频道（无法通过 getUpdates 自动发现）";
const DEFAULT_REASON_REVEAL = "后台频道管理：查看频道 ID 明文（运维/迁移/排障场景）";

type RevealedState = {
  chatIdPlain: string;
  expiresAt: number; // ms epoch
  ttlMs: number;
};

const ChannelsPage: React.FC = () => {
  const { me } = useAuth();
  const canView = !!me && VIEW_ROLES.includes(me.role);
  const canRefresh = !!me && REFRESH_ROLES.includes(me.role);
  const canAdd = !!me && ADD_ROLES.includes(me.role);
  const canReveal = !!me && REVEAL_ROLES.includes(me.role);

  const [filterForm] = Form.useForm<{
    search?: string;
    source?: ChannelSource;
    chatType?: string;
  }>();
  const [addForm] = Form.useForm<{ chatId: string; reason?: string }>();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ChannelItem[]>([]);
  const [revealed, setRevealed] = useState<Record<string, RevealedState>>({});

  const [refreshModalOpen, setRefreshModalOpen] = useState(false);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshResult, setRefreshResult] = useState<ChannelRefreshResp | null>(null);
  const [refreshReasonForm] = Form.useForm<{ reason?: string; force?: boolean }>();

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addLoading, setAddLoading] = useState(false);

  const revealedTimers = useRef<Record<string, number>>({});

  const fetchData = useCallback(async () => {
    if (!canView) return;
    const v = filterForm.getFieldsValue();
    setLoading(true);
    try {
      const res = await listAdminChannels({
        page,
        pageSize,
        search: v.search?.trim() || undefined,
        source: v.source,
        chatType: v.chatType,
      });
      setRows(res.items);
      setTotal(res.pagination.total);
    } catch (e) {
      antdMsg.error("频道列表加载失败：" + errMsg(e, "未知错误"));
    } finally {
      setLoading(false);
    }
  }, [canView, filterForm, page, pageSize]);

  useEffect(() => {
    if (canView) fetchData();
  }, [canView, fetchData]);

  useEffect(() => {
    return () => {
      Object.values(revealedTimers.current).forEach((id) => window.clearTimeout(id));
    };
  }, []);

  const onSearch = () => { setPage(1); setTimeout(fetchData, 0); };
  const onReset = () => { filterForm.resetFields(); setPage(1); setTimeout(fetchData, 0); };

  const copyText = async (text: string, okHint = "已复制") => {
    try {
      await navigator.clipboard.writeText(text);
      antdMsg.success(okHint);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); antdMsg.success(okHint); } catch { antdMsg.warning("复制失败，请手动选择文本复制"); }
      document.body.removeChild(ta);
    }
  };

  const doRevealId = async (item: ChannelItem) => {
    if (!canReveal) return;
    const existing = revealed[item.chatId];
    if (existing && existing.expiresAt > Date.now() + 2000) {
      antdMsg.info(`剩余明文展示 ${Math.max(1, Math.round((existing.expiresAt - Date.now()) / 1000))}s`);
      return;
    }
    confirm({
      title: "查看频道 ID 明文",
      icon: <ExclamationCircleFilled />,
      content: (
        <div>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="敏感操作，将写入审计日志"
            description={
              <>
                频道 <Text strong>{item.title || "(未命名)"}</Text> · 脱敏 ID：
                <Text code>{item.chatIdMasked}</Text>
                <br />
                明文仅 <Tag color="magenta">临时展示 10 秒</Tag>，过期自动脱敏；审计事件：
                <Text code>admin.channel.reveal_id</Text>
              </>
            }
          />
          <Input.TextArea
            rows={2}
            maxLength={200}
            placeholder="请输入查看原因（必填，2-1000 字符）"
            id="__reveal_reason_input"
            defaultValue={DEFAULT_REASON_REVEAL}
          />
        </div>
      ),
      okText: "确认查看",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        const ta = document.getElementById("__reveal_reason_input") as HTMLTextAreaElement | null;
        const reason = (ta?.value || "").trim() || DEFAULT_REASON_REVEAL;
        try {
          const r = await revealAdminChannelId(item.chatId, reason);
          const expiresAt = new Date(r.reveal.expiresAt).getTime();
          const state: RevealedState = {
            chatIdPlain: r.reveal.chatIdPlain,
            expiresAt,
            ttlMs: r.reveal.ttlMs,
          };
          setRevealed((prev) => ({ ...prev, [item.chatId]: state }));
          if (revealedTimers.current[item.chatId]) window.clearTimeout(revealedTimers.current[item.chatId]);
          const delayMs = Math.max(100, expiresAt - Date.now());
          revealedTimers.current[item.chatId] = window.setTimeout(() => {
            setRevealed((prev) => {
              const n = { ...prev };
              delete n[item.chatId];
              return n;
            });
            antdMsg.info(`频道 ${item.title || item.chatIdMasked} 明文已自动脱敏`);
          }, delayMs);
          antdMsg.success("已解锁 10 秒明文展示（自动写入审计日志）");
        } catch (e) {
          antdMsg.error("解锁失败：" + errMsg(e, "请确认权限或稍后再试"));
        }
      },
    });
  };

  const renderChatIdCell = (_: unknown, r: ChannelItem) => {
    const cur = revealed[r.chatId];
    const active = !!cur && cur.expiresAt > Date.now();
    const remainSec = active ? Math.max(1, Math.round((cur!.expiresAt - Date.now()) / 1000)) : 0;
    return (
      <Space.Compact>
        <Tooltip title={active ? "明文将在倒计时结束后自动脱敏" : "点击右侧 👁️ 临时查看 10 秒明文"}>
          <Input
            readOnly
            style={{ width: 220, fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" }}
            value={active ? cur!.chatIdPlain : r.chatIdMasked}
            suffix={active ? <Tag color="magenta" style={{ marginRight: 0 }}>{remainSec}s</Tag> : null}
          />
        </Tooltip>
        <Button
          icon={<EyeOutlined />}
          disabled={!canReveal}
          onClick={() => doRevealId(r)}
          title={canReveal ? "查看 ID 明文 10 秒（记审计日志）" : "仅超级管理员可查看"}
        />
        <Button
          icon={<CopyOutlined />}
          onClick={() =>
            copyText(active ? cur!.chatIdPlain : r.chatIdMasked, active ? "已复制完整 ID" : "已复制脱敏 ID")
          }
          title="一键复制当前可见文本"
        />
      </Space.Compact>
    );
  };

  const columns = useMemo<ColumnsType<ChannelItem>>(
    () => [
      {
        title: "频道名称",
        dataIndex: "title",
        key: "title",
        width: 240,
        fixed: "left",
        render: (v: string | null, r) => (
          <Space>
            <Text strong>{v || "(未命名)"}</Text>
            {r.isPrivate ? (
              <Tooltip title="非公开（没有 @username 公开链接）">
                <Tag color="red">私密</Tag>
              </Tooltip>
            ) : (
              <Tooltip title="公开频道/群组">
                <Tag color="green">公开</Tag>
              </Tooltip>
            )}
          </Space>
        ),
        sorter: (a, b) => (a.title || "").localeCompare(b.title || ""),
      },
      {
        title: "类型",
        dataIndex: "type",
        key: "type",
        width: 160,
        render: (t: string) => {
          const meta = CHAT_TYPE_META[t] || { label: t, color: "default" };
          return <Tag color={meta.color}>{meta.label}</Tag>;
        },
      },
      {
        title: "频道 ID（脱敏 + 👁️ 明文 10s）",
        key: "chatId",
        width: 400,
        render: renderChatIdCell,
      },
      {
        title: "成员数",
        dataIndex: "memberCount",
        key: "memberCount",
        width: 110,
        align: "right",
        render: (n: number | null) => (n == null ? <Text type="secondary">—</Text> : n.toLocaleString()),
      },
      {
        title: "公开 @username",
        dataIndex: "username",
        key: "username",
        width: 200,
        render: (u: string | null) => (u ? <Text copyable>@{u}</Text> : <Text type="secondary">—</Text>),
      },
      {
        title: "最近刷新",
        dataIndex: "refreshedAt",
        key: "refreshedAt",
        width: 180,
        render: (v: string | null) => (v ? dayjs(v).fromNow() : <Tag color="default">尚未刷新</Tag>),
      },
      {
        title: "来源",
        dataIndex: "source",
        key: "source",
        width: 130,
        render: (s: ChannelSource) => {
          const m = SOURCE_META[s];
          return <Tag color={m.color}>{m.label}</Tag>;
        },
      },
      {
        title: "最近事件",
        dataIndex: "lastEventAt",
        key: "lastEventAt",
        width: 160,
        render: (v: string | null) => (v ? dayjs(v).fromNow() : <Text type="secondary">—</Text>),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canReveal, revealed],
  );

  const openRefresh = () => {
    refreshReasonForm.setFieldsValue({ reason: DEFAULT_REASON_REFRESH, force: false });
    setRefreshResult(null);
    setRefreshModalOpen(true);
  };

  const submitRefresh = async (values: { reason?: string; force?: boolean }) => {
    setRefreshLoading(true);
    setRefreshResult(null);
    try {
      const r = await refreshAdminChannels({
        reason: (values.reason || "").trim() || DEFAULT_REASON_REFRESH,
        force: values.force === true,
      });
      setRefreshResult(r);
      if (r.summary.failed === 0) {
        antdMsg.success(
          `刷新完成：扫描入库 ${r.summary.scannedFromUpdates} · 元数据更新 ${r.summary.refreshed} · 命中缓存 ${r.summary.fromCache}`,
          6,
        );
      } else {
        antdMsg.warning(`刷新完成，但有 ${r.summary.failed} 个频道调用 Telegram API 失败（见下方）`, 8);
      }
      void fetchData();
    } catch (e: any) {
      if (e?.response?.status === 503) {
        antdMsg.error(
          "Telegram Bot 未配置（503 telegram_not_configured）。请先在服务器设置 TELEGRAM_BOTS / TELEGRAM_INVITE_BOT_KEY，再回来点击刷新。",
          10,
        );
      } else {
        antdMsg.error("刷新失败：" + errMsg(e, "未知错误"));
      }
    } finally {
      setRefreshLoading(false);
    }
  };

  const openAdd = () => {
    addForm.setFieldsValue({ chatId: "", reason: DEFAULT_REASON_ADD });
    setAddModalOpen(true);
  };

  const submitAdd = async (values: { chatId: string; reason?: string }) => {
    setAddLoading(true);
    try {
      const r = await addAdminChannel({
        chatId: values.chatId.trim(),
        reason: (values.reason || "").trim() || DEFAULT_REASON_ADD,
      });
      antdMsg.success(
        <>
          已录入 <Text code>{r.chatIdMasked}</Text> · 来源 <Tag color="purple">{SOURCE_META[r.source].label}</Tag>
        </>,
      );
      setAddModalOpen(false);
      addForm.resetFields();
      void fetchData();
    } catch (e) {
      antdMsg.error("录入失败：" + errMsg(e, "请确认 chatId 格式为 -100 开头的纯数字"));
    } finally {
      setAddLoading(false);
    }
  };

  if (!canView) {
    return (
      <div>
        <Alert
          type="error"
          showIcon
          message="403 无权限"
          description={
            <>
              你的账号「{me?.role || "未登录"}」无 <Text code>channel:view</Text> 权限。
              <br />
              按权限矩阵 D2-1，频道管理功能 <Text strong>仅超级管理员 (super_admin)</Text> 可用；
              客服 / 财务 / 审计 / 运营一律返回 403。
            </>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Alert
          showIcon
          type="info"
          style={{ marginBottom: 16 }}
          message="Bot 频道管理（D1~D5 严格执行）"
          description={
            <>
              <Space wrap>
                <Tag color="blue">D1-1 getUpdates 自动扫热频道</Tag>
                <Tag color="purple">D1-2 手动加冷频道</Tag>
                <Tag color="red">D2-1 仅 super_admin 4 权限</Tag>
                <Tag color="magenta">D3-1 默认脱敏 **** · 👁️ 10s 记 reveal_id 审计</Tag>
                <Tag color="geekblue">D4-1 串行 350ms · 10min DB 缓存 · 🔄 强制刷新</Tag>
                <Tag color="green">D5-Y 落表 admin_managed_channels</Tag>
              </Space>
            </>
          }
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <Form form={filterForm} layout="inline" onFinish={onSearch}>
          <Form.Item name="search" label="关键词">
            <Input allowClear prefix={<SearchOutlined />} placeholder="名称 / @公开用户名" style={{ width: 240 }} />
          </Form.Item>
          <Form.Item name="source" label="来源">
            <Select style={{ width: 150 }} allowClear placeholder="全部">
              <Option value="auto_scan">自动扫描</Option>
              <Option value="manual_add">手动添加</Option>
            </Select>
          </Form.Item>
          <Form.Item name="chatType" label="类型">
            <Select style={{ width: 160 }} allowClear placeholder="全部">
              <Option value="channel">频道 Channel</Option>
              <Option value="supergroup">超级群</Option>
              <Option value="group">普通群</Option>
              <Option value="private">私聊</Option>
              <Option value="unknown">未知</Option>
            </Select>
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>查询</Button>
              <Button onClick={onReset}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Space wrap>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={openRefresh}
            disabled={!canRefresh}
            title={canRefresh ? "自动扫描热频道 + 串行刷新全部频道元数据（10min 缓存可强制绕过）" : "仅 super_admin 可刷新"}
          >
            🔄 自动扫描并刷新
          </Button>
          <Button
            icon={<PlusOutlined />}
            onClick={openAdd}
            disabled={!canAdd}
            title={canAdd ? "手动添加 getUpdates 扫不到的冷频道（输入完整 -100… chatId）" : "仅 super_admin 可添加"}
          >
            ➕ 手动添加冷频道 ID
          </Button>
        </Space>
      </div>

      <Table
        rowKey="chatId"
        size="middle"
        loading={loading}
        columns={columns}
        dataSource={rows}
        locale={{ emptyText: <Empty description="暂无频道。先点【🔄 自动扫描并刷新】或【➕ 手动添加冷频道】" /> }}
        scroll={{ x: 1580 }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showQuickJumper: true,
          onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          showTotal: (t, range) => `${range[0]}-${range[1]} / ${t} 条`,
        }}
      />

      <Modal
        open={refreshModalOpen}
        onCancel={() => !refreshLoading && setRefreshModalOpen(false)}
        title="🔄 自动扫描并刷新频道元数据"
        width={760}
        footer={null}
        maskClosable={false}
      >
        <Form form={refreshReasonForm} layout="vertical" onFinish={submitRefresh}>
          <Form.Item name="reason" label="操作原因（必填，2-1000 字符，写入 admin.channel.refresh 审计）" rules={[{ required: true, min: 2, max: 1000 }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="force" valuePropName="checked">
            <Space>
              <CheckboxLike label="强制刷新（绕过 10 分钟 DB 缓存）" name="force" form={refreshReasonForm} />
              <Text type="secondary">
                默认：10 分钟内刷新只写缓存不打 Telegram API；勾选后对所有频道强制执行
                getChat + getChatMemberCount（串行 350ms 间隔，避免 429）。
              </Text>
            </Space>
          </Form.Item>
          <Space style={{ marginBottom: 16 }}>
            <Button type="primary" htmlType="submit" loading={refreshLoading} icon={<ReloadOutlined />}>
              {refreshReasonForm.getFieldValue("force") ? "强制刷新 🔄" : "开始刷新（优先读 10min 缓存）"}
            </Button>
            <Button disabled={refreshLoading} onClick={() => setRefreshModalOpen(false)}>
              关闭
            </Button>
          </Space>
          {refreshResult ? (
            <>
              <Alert
                style={{ marginBottom: 12 }}
                type={refreshResult.summary.failed > 0 ? "warning" : "success"}
                showIcon
                message="刷新完成"
                description={
                  <>
                    自动扫描入库 <Text strong>{refreshResult.summary.scannedFromUpdates}</Text> · 处理
                    <Text strong> {refreshResult.summary.processed} </Text>
                    · 成功刷新 <Tag color="green">{refreshResult.summary.refreshed}</Tag> · 失败
                    <Tag color="red">{refreshResult.summary.failed}</Tag>
                    · DB 缓存命中 <Tag color="blue">{refreshResult.summary.fromCache}</Tag>
                  </>
                }
              />
              {refreshResult.errors.length > 0 ? (
                <>
                  <Title level={5} style={{ marginTop: 4 }}>失败明细（按 Telegram 错误码）</Title>
                  <Space direction="vertical" style={{ width: "100%" }} size={8}>
                    {refreshResult.errors.slice(0, 20).map((e: ChannelRefreshError) => (
                      <Tag key={e.chatId} color="red" style={{ marginRight: 8 }}>
                        {e.chatIdMasked} · {e.tgCode ? `tg_${e.tgCode}` : e.errorClass}
                      </Tag>
                    ))}
                    {refreshResult.errors.length > 20 ? (
                      <Text type="secondary">
                        只展示前 20 条，其余 {refreshResult.errors.length - 20} 条可在服务器日志检索 admin.channel.refresh
                      </Text>
                    ) : null}
                  </Space>
                </>
              ) : null}
            </>
          ) : null}
        </Form>
      </Modal>

      <Modal
        open={addModalOpen}
        onCancel={() => !addLoading && setAddModalOpen(false)}
        title="➕ 手动添加冷频道 ID"
        width={620}
        footer={null}
      >
        <Form form={addForm} layout="vertical" onFinish={submitAdd}>
          <Form.Item
            name="chatId"
            label="频道 chatId（完整 -100 开头的数字，从 t.me/c/xxxxxxx/n 链接的 xxxxxxx 前加 -100）"
            rules={[{ required: true, min: 6, max: 20, pattern: /^-?\d{6,20}$/ }]}
            extra='例：链接 https://t.me/c/4360193327/3 → 填入 -1004360193327'
          >
            <Input placeholder="-1004360193327" style={{ fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" }} />
          </Form.Item>
          <Form.Item name="reason" label="操作原因（写入 admin.channel.add 审计，2-1000）" rules={[{ required: true, min: 2, max: 1000 }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={addLoading} icon={<PlusOutlined />}>确认添加</Button>
            <Button disabled={addLoading} onClick={() => setAddModalOpen(false)}>取消</Button>
          </Space>
        </Form>
      </Modal>
    </div>
  );
};

function CheckboxLike(props: { label: string; name: string; form: any }) {
  // 用 Form.Item + 原生 checkbox 避免与 4.x/5.x 版本差异
  const value = props.form.getFieldValue(props.name);
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, userSelect: "none" }}>
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => props.form.setFieldsValue({ [props.name]: e.target.checked })}
      />
      <span>{props.label}</span>
    </label>
  );
}

export default ChannelsPage;
