import React, { useCallback, useMemo, useState } from "react";
import {
  Table,
  Button,
  Space,
  Input,
  Select,
  Form,
  Tag,
  Drawer,
  Descriptions,
  Empty,
  Tooltip,
  message as antdMsg,
  Typography,
  Badge,
  List,
  Avatar,
  Divider,
} from "antd";
import {
  SearchOutlined,
  EyeOutlined,
  ReloadOutlined,
  UserOutlined,
  SafetyCertificateOutlined,
  MessageOutlined,
  ExclamationCircleFilled,
} from "@ant-design/icons";
import type { ColumnsType, TablePaginationConfig } from "antd/es/table";
import dayjs from "dayjs";
import {
  listAdminUsers,
  getAdminUser,
} from "../api/client";
import type {
  AdminUserItem,
  AdminUserDetail,
  AdminRole,
  UserStatus,
  OrderStatus,
  EntitlementStatus,
  TicketStatus,
  TicketCategory,
  TicketPriority,
} from "../api/types";
import { useAuth } from "../components/AuthProvider";
import { useLocation } from "react-router-dom";

const { Text, Title } = Typography;
const { Option } = Select;

const ROLE_LABEL: Record<AdminRole, string> = {
  super_admin: "超级管理员",
  operator: "运营",
  editor: "内容编审",
  customer_service: "客服",
  finance: "财务",
  auditor: "审计",
};

const STATUS_META: Record<UserStatus, { label: string; color: string }> = {
  active: { label: "正常", color: "green" },
  suspended: { label: "封禁", color: "red" },
  deleted: { label: "已删", color: "default" },
};

const VIEW_ROLES: AdminRole[] = ["super_admin", "customer_service", "operator", "finance", "auditor"];

const ORDER_STATUS_COLOR: Record<string, string> = {
  paid: "green",
  refunded: "magenta",
  cancelled: "default",
  pending: "processing",
  processing: "processing",
  failed: "red",
  expired: "orange",
};

const ENT_STATUS_COLOR: Record<string, string> = {
  active: "green",
  revoked: "default",
  expired: "orange",
};

const TICKET_STATUS_COLOR: Record<string, string> = {
  open: "red",
  in_progress: "processing",
  resolved: "green",
  closed: "default",
};

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "red",
  high: "orange",
  normal: "blue",
  low: "default",
};

const CATEGORY_COLOR: Record<string, string> = {
  payment: "magenta",
  entitlement: "geekblue",
  access: "purple",
  refund: "volcano",
  other: "cyan",
};

const UsersPage: React.FC = () => {
  const { me } = useAuth();
  const location = useLocation();
  const botOnly = location.pathname.startsWith("/bot-users");
  const canView = !!me && VIEW_ROLES.includes(me.role);

  const [form] = Form.useForm<{
    q?: string;
    telegramUserId?: string;
    status?: UserStatus;
    hasActiveEntitlement?: "1" | "0";
  }>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<AdminUserItem[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchData = useCallback(async () => {
    const v = form.getFieldsValue();
    setLoading(true);
    try {
      const res = await listAdminUsers({
        page,
        pageSize,
        q: v.q?.trim() || undefined,
        telegramUserId: v.telegramUserId?.trim() || undefined,
        status: v.status,
        hasActiveEntitlement: v.hasActiveEntitlement === "1" ? true : v.hasActiveEntitlement === "0" ? false : undefined,
        telegramBound: botOnly || undefined,
      });
      setRows(res.items);
      setTotal(res.pagination.total);
    } catch (e: any) {
      antdMsg.error("用户列表加载失败：" + (e?.response?.data?.message || e.message));
    } finally {
      setLoading(false);
    }
  }, [botOnly, form, page, pageSize]);

  React.useEffect(() => { fetchData(); }, [fetchData]);

  const onSearch = () => { setPage(1); setTimeout(fetchData, 0); };
  const onReset = () => { form.resetFields(); setPage(1); setTimeout(fetchData, 0); };

  const openDetail = async (u: AdminUserItem) => {
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const latest = await getAdminUser(u.id);
      setDetail(latest);
    } catch (e: any) {
      antdMsg.error("用户详情加载失败：" + (e?.response?.data?.message || e.message));
    } finally {
      setDetailLoading(false);
    }
  };

  const columns = useMemo<ColumnsType<AdminUserItem>>(
    () => [
      {
        title: "用户",
        key: "user",
        width: 240,
        fixed: "left",
        render: (_: unknown, r: AdminUserItem) => (
          <Space>
            <Avatar icon={<UserOutlined />} src={r.avatarUrl || r.photoUrl || undefined}>
              {r.displayName?.slice(0, 1)}
            </Avatar>
            <div>
              <div>
                <Text strong>{r.displayName || "未知用户"}</Text>
                {r.username ? <Tag style={{ marginLeft: 4 }}>@{r.username}</Tag> : null}
                {r.telegramFirstName ? <Text type="secondary" style={{ marginLeft: 4 }}>TG：{[r.telegramFirstName, r.telegramLastName].filter(Boolean).join(" ")}</Text> : null}
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ID <Text code copyable>{r.id.slice(0, 12)}…</Text>
                  {r.telegramUserId ? <>，TG UID: {r.telegramUserId}</> : null}
                </Text>
              </div>
            </div>
          </Space>
        ),
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 120,
        render: (s: UserStatus) => <Tag color={STATUS_META[s]?.color}>{STATUS_META[s]?.label || s}</Tag>,
      },
      {
        title: "订单",
        key: "orders",
        width: 140,
        render: (_: unknown, r: AdminUserItem) => (
          <div style={{ fontSize: 13 }}>
            <Badge status="processing" /> <Text>累计 {r.ordersCount}</Text>
            {r.lastOrderAt ? (
              <div style={{ fontSize: 11 }}>
                <Text type="secondary">
                  最近 {dayjs(r.lastOrderAt).format("MM-DD HH:mm")}
                </Text>
              </div>
            ) : null}
          </div>
        ),
      },
      {
        title: "权益",
        key: "ent",
        width: 160,
        render: (_: unknown, r: AdminUserItem) => {
          const ratio = r.entitlementsCount > 0 ? `${r.activeEntitlementsCount}/${r.entitlementsCount}` : "0";
          return (
            <div style={{ fontSize: 13 }}>
              <SafetyCertificateOutlined style={{ color: "#1890ff" }} />
              <Text> 活跃 {ratio}</Text>
              {r.hasActiveEntitlement ? (
                <Tag color="green">有在享</Tag>
              ) : (
                <Tag color="default">无在享</Tag>
              )}
            </div>
          );
        },
      },
      {
        title: "工单",
        key: "tk",
        width: 130,
        render: (_: unknown, r: AdminUserItem) => {
          const ticketsCount = r.supportTicketsCount ?? r.ticketsCount ?? 0;
          return (
            <div style={{ fontSize: 13 }}>
              <MessageOutlined /> <Text>累计 {ticketsCount}</Text>
              {r.openTicketsCount > 0 ? (
                <Tag color="red" style={{ marginLeft: 4 }}>{r.openTicketsCount}个待处理</Tag>
              ) : null}
            </div>
          );
        },
      },
      {
        title: "注册 / 最近活动",
        key: "time",
        width: 220,
        render: (_: unknown, r: AdminUserItem) => (
          <div style={{ fontSize: 12 }}>
            <div>
              <Text type="secondary">注册：</Text>
              {dayjs(r.createdAt).format("YYYY-MM-DD HH:mm")}
            </div>
            <div>
              <Text type="secondary">最近：</Text>
              {r.lastActiveAt ? dayjs(r.lastActiveAt).format("YYYY-MM-DD HH:mm") : "无记录"}
            </div>
          </div>
        ),
      },
      {
        title: "最近权益",
        key: "recent",
        width: 360,
        render: (_: unknown, r: AdminUserItem) => {
          const items = r.recentEntitlements || [];
          if (!items.length) return <Text type="secondary">暂无权益记录</Text>;
          return (
            <List
              size="small"
              dataSource={items}
              split={false}
              renderItem={(it) => (
                <List.Item>
                  <Space size={4}>
                    <Tag style={{ margin: 0 }} color={ENT_STATUS_COLOR[it.status] || "default"}>
                      {it.resourceType}
                    </Tag>
                    <Text code copyable style={{ fontSize: 12 }}>
                      {it.resourceId.slice(0, 10)}…
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {it.status}
                    </Text>
                  </Space>
                </List.Item>
              )}
            />
          );
        },
      },
      {
        title: "操作",
        key: "act",
        fixed: "right",
        width: 120,
        render: (_: unknown, r: AdminUserItem) => (
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => openDetail(r)}>
            用户详情
          </Button>
        ),
      },
    ],
    [],
  );

  const pagination: TablePaginationConfig = {
    current: page, pageSize, total,
    showSizeChanger: true, showQuickJumper: true,
    pageSizeOptions: ["10", "20", "50", "100"],
    showTotal: (t) => `共 ${t} 位用户`,
    onChange: (p, s) => { setPage(p); setPageSize(s); },
  };

  if (!canView) {
    return (
      <Empty
        description={
          <Tag icon={<ExclamationCircleFilled />} color="warning">
            你的账号「{me?.role || "未登录"}」无 user:view 权限。需要客服/运营/财务/审计或超管。
          </Tag>
        }
      />
    );
  }

  return (
    <div>
      {botOnly ? <div style={{ marginBottom: 16 }}><Title level={4} style={{ margin: 0 }}>Bot 用户管理</Title><Text type="secondary">仅显示通过 Bot /start、Mini App 或 Telegram 登录建档的用户。头像仅在 Telegram 登录上下文提供时保存。</Text></div> : null}
      <div style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="inline"
          onFinish={onSearch}
          style={{ rowGap: 8, columnGap: 12, display: "flex", flexWrap: "wrap" }}
        >
          <Form.Item name="q" label="搜索">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="平台昵称 / Telegram 昵称 / 用户名 / TG UID"
              style={{ width: 280 }}
            />
          </Form.Item>
          <Form.Item name="telegramUserId" label="TG UID">
            <Input allowClear placeholder="精确匹配 1000000001" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select allowClear style={{ width: 130 }} placeholder="全部状态">
              {(Object.keys(STATUS_META) as UserStatus[]).map((s) => (
                <Option key={s} value={s}>{STATUS_META[s].label}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="hasActiveEntitlement" label="在享权益">
            <Select allowClear style={{ width: 140 }} placeholder="不限">
              <Option value="1">有活跃权益</Option>
              <Option value="0">无活跃权益</Option>
            </Select>
          </Form.Item>
          <Form.Item>
            <Space wrap>
              <Button type="primary" icon={<SearchOutlined />} htmlType="submit">搜索</Button>
              <Button icon={<ReloadOutlined />} onClick={onReset}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
      </div>

      <Table<AdminUserItem>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={pagination}
        scroll={{ x: 1600 }}
        locale={{ emptyText: <Empty description={botOnly ? "暂无 Bot 用户数据。用户点击 Bot /start 后会自动建档。" : "暂无用户数据。用户在 Mini App 首次打开会话后会自动建档。"} /> }}
      />

      <Drawer
        title={
          <Space style={{ width: "100%", justifyContent: "space-between" }}>
            <Space>
              <Avatar icon={<UserOutlined />} src={detail?.avatarUrl || detail?.photoUrl || undefined}>
                {detail?.displayName?.slice(0, 1)}
              </Avatar>
              <Title level={4} style={{ margin: 0 }}>
                {detail?.displayName || "用户详情"}
                {detail?.username ? <Tag style={{ marginLeft: 8 }}>@{detail.username}</Tag> : null}
              </Title>
            </Space>
          </Space>
        }
        placement="right"
        width={820}
        onClose={() => setDetailOpen(false)}
        open={detailOpen}
        destroyOnClose
      >
        {detailLoading ? <div style={{ textAlign: "center", padding: 40 }}><Empty description="加载中..." /></div> :
         !detail ? <Empty description="暂无用户详情" /> : (
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Descriptions bordered column={2} size="small" title={<Space><UserOutlined />账号快照</Space>}>
              <Descriptions.Item label="用户ID" span={1}>
                <Text copyable code>{detail.id}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Telegram UID">
                {detail.telegramUserId ? (
                  <Space>
                    <Text code copyable>{detail.telegramUserId}</Text>
                  </Space>
                ) : <Tag>未绑定</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="显示名">{detail.displayName || "-"}</Descriptions.Item>
              <Descriptions.Item label="Telegram 昵称">
                {[detail.telegramFirstName, detail.telegramLastName].filter(Boolean).join(" ") || <Text type="secondary">- 未提供 -</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="Telegram 用户名">
                {detail.username ? <Text copyable>@{detail.username}</Text> : <Text type="secondary">- 未设置 -</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_META[detail.status]?.color}>{STATUS_META[detail.status]?.label}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="邮箱">
                {detail.email || <Text type="secondary">- 未填 -</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="语言 / 时区">
                <Space>
                  {detail.telegramLanguageCode ? <Tag>{detail.telegramLanguageCode}</Tag> : detail.languageCode ? <Tag>{detail.languageCode}</Tag> : null}
                  {detail.timezone !== null && detail.timezone !== undefined ? (
                    <Text>UTC {detail.timezone >= 0 ? "+" : ""}{detail.timezone}</Text>
                  ) : null}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="注册时间">
                {dayjs(detail.createdAt).format("YYYY-MM-DD HH:mm:ss")}
              </Descriptions.Item>
              <Descriptions.Item label="最近活动">
                {detail.lastTelegramSeenAt ? dayjs(detail.lastTelegramSeenAt).format("YYYY-MM-DD HH:mm:ss") : detail.lastActiveAt ? dayjs(detail.lastActiveAt).format("YYYY-MM-DD HH:mm:ss") : "无活动"}
              </Descriptions.Item>
            </Descriptions>

            <Divider orientation="left" plain style={{ margin: "0 0 -4px" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                最近 20 笔订单（按创建倒序）
              </span>
            </Divider>
            <div style={{ padding: "0 4px" }}>
              {(detail.recentOrders?.length || 0) === 0 ? (
                <Empty description="暂无订单" style={{ padding: "12px 0" }} />
              ) : (
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={detail.recentOrders as any[]}
                  columns={[
                    {
                      title: "订单号",
                      dataIndex: "orderNo",
                      width: 210,
                      render: (v: string) => <Text code copyable style={{ fontSize: 12 }}>{v}</Text>,
                    },
                    { title: "状态", dataIndex: "status", width: 110,
                      render: (s: OrderStatus) => (
                        <Tag color={ORDER_STATUS_COLOR[s] || "blue"}>{s}</Tag>
                      ),
                    },
                    { title: "金额", key: "amt", width: 120, render: (_: any, r: any) =>
                      <Text strong>{r.amountMinor} {r.currency}</Text>
                    },
                    { title: "支付方式", key: "pm", width: 120,
                      render: (_: any, r: any) => r.paymentMethod || r.paymentProvider ? (
                        <Tag>{r.paymentMethod || r.paymentProvider}</Tag>
                      ) : <Text type="secondary">-</Text>
                    },
                    { title: "权益数", dataIndex: "entitlementsCount", width: 80, align: "center" },
                    { title: "创建", dataIndex: "createdAt", width: 150,
                      render: (v: string) => dayjs(v).format("MM-DD HH:mm"),
                    },
                  ]}
                />
              )}
            </div>

            <Divider orientation="left" plain style={{ margin: "0 0 -4px" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                <SafetyCertificateOutlined /> 最近 30 条权益
              </span>
            </Divider>
            <div style={{ padding: "0 4px" }}>
              {(detail.recentEntitlements?.length || 0) === 0 ? (
                <Empty description="暂无权益" style={{ padding: "12px 0" }} />
              ) : (
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={detail.recentEntitlements as any[]}
                  columns={[
                    { title: "类型", dataIndex: "resourceType", width: 160,
                      render: (v: string) => <Tag>{v}</Tag>
                    },
                    { title: "资源ID", dataIndex: "resourceId", width: 230,
                      render: (v: string) => <Text code copyable style={{ fontSize: 12 }}>{v}</Text>
                    },
                    { title: "状态", dataIndex: "status", width: 110,
                      render: (s: EntitlementStatus) => (
                        <Tag color={ENT_STATUS_COLOR[s] || "blue"}>{s}</Tag>
                      ),
                    },
                    { title: "来源订单", dataIndex: "sourceOrderNo", width: 210,
                      render: (v: string) => v ? (
                        <Text code copyable style={{ fontSize: 12 }}>{v}</Text>
                      ) : <Tag>直授/补偿</Tag>
                    },
                    { title: "生效周期", key: "t", width: 230,
                      render: (_: any, r: any) => (
                        <div style={{ fontSize: 12 }}>
                          <div>{dayjs(r.startsAt).format("MM-DD HH:mm")} 起</div>
                          <div>
                            {r.expiresAt ? `${dayjs(r.expiresAt).format("MM-DD HH:mm")} 止` : "永久"}
                            {r.revokedAt ? (
                              <Tag color="volcano">已回收 {dayjs(r.revokedAt).format("MM-DD HH:mm")}</Tag>
                            ) : null}
                          </div>
                        </div>
                      ),
                    },
                  ]}
                />
              )}
            </div>

            <Divider orientation="left" plain style={{ margin: "0 0 -4px" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                <MessageOutlined /> 最近 10 条客服工单
              </span>
            </Divider>
            <div style={{ padding: "0 4px" }}>
              {(detail.recentSupportTickets?.length || 0) === 0 ? (
                <Empty description="暂无工单" style={{ padding: "12px 0" }} />
              ) : (
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={detail.recentSupportTickets as any[]}
                  columns={[
                    { title: "工单号", dataIndex: "ticketNo", width: 220,
                      render: (v: string) => <Text code copyable style={{ fontSize: 12 }}>{v}</Text>,
                    },
                    { title: "标题", dataIndex: "title",
                      ellipsis: true,
                      render: (v: string) => v || <Text type="secondary">(无标题)</Text>,
                    },
                    { title: "分类", dataIndex: "category", width: 130,
                      render: (v: TicketCategory) => (
                        <Tag color={CATEGORY_COLOR[v] || "cyan"}>{CATEGORY_COLOR[v] ? v : v}</Tag>
                      )
                    },
                    { title: "优先级", dataIndex: "priority", width: 100,
                      render: (v: TicketPriority) => (
                        <Tag color={PRIORITY_COLOR[v] || "blue"}>{v}</Tag>
                      ),
                    },
                    { title: "状态", dataIndex: "status", width: 110,
                      render: (s: TicketStatus) => (
                        <Tag color={TICKET_STATUS_COLOR[s] || "blue"}>{s}</Tag>
                      ),
                    },
                    { title: "处理人", key: "asg", width: 120,
                      render: (_: any, r: any) => (
                        r.assignedToName ? r.assignedToName :
                        r.assignedToId ? <Tag>已分配</Tag> :
                        <Text type="secondary">未分配</Text>
                      )
                    },
                    { title: "创建", dataIndex: "createdAt", width: 150,
                      render: (v: string) => dayjs(v).format("MM-DD HH:mm"),
                    },
                  ]}
                />
              )}
            </div>
          </Space>
        )}
      </Drawer>
    </div>
  );
};

export default UsersPage;
