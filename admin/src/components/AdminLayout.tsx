import React, { useEffect, useMemo, useState } from "react";
import { Avatar, Button, Divider, Drawer, Dropdown, Input, Layout, Menu, Modal, Space, Tag, Tooltip, Typography } from "antd";
import {
  ApiOutlined, AppstoreOutlined, BarChartOutlined, DashboardOutlined, ExclamationCircleFilled,
  FileSearchOutlined, HomeOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MessageOutlined,
  ReadOutlined, SafetyCertificateOutlined, SearchOutlined, ShoppingOutlined, TagsOutlined,
  TeamOutlined, UserOutlined, VideoCameraOutlined, LogoutOutlined,
} from "@ant-design/icons";
import { useLocation, useNavigate, Outlet } from "react-router-dom";
import { useAuth } from "../components/AuthProvider";
import "./AdminLayout.css";

const { Header, Sider, Content } = Layout;
const { Text, Title } = Typography;
const { confirm } = Modal;

type NavigationItem = { key: string; label: string; section: string; icon: React.ReactNode };

const NAVIGATION: NavigationItem[] = [
  { key: "/dashboard", label: "运营工作台", section: "工作台", icon: <DashboardOutlined /> },
  { key: "/analytics", label: "数据分析", section: "增长与经营", icon: <BarChartOutlined /> },
  { key: "/traffic-entries", label: "流量入口", section: "增长与经营", icon: <ApiOutlined /> },
  { key: "/campaigns", label: "活动管理", section: "增长与经营", icon: <HomeOutlined /> },
  { key: "/finance", label: "财务数据中心", section: "增长与经营", icon: <SafetyCertificateOutlined /> },
  { key: "/contents", label: "视频内容", section: "内容与审核", icon: <VideoCameraOutlined /> },
  { key: "/articles", label: "文章中心", section: "内容与审核", icon: <ReadOutlined /> },
  { key: "/interaction-reports", label: "互动审核", section: "内容与审核", icon: <MessageOutlined /> },
  { key: "/packages", label: "内容包管理", section: "内容与审核", icon: <AppstoreOutlined /> },
  { key: "/categories", label: "分类与标签", section: "内容与审核", icon: <TagsOutlined /> },
  { key: "/banners", label: "Banner 运营位", section: "内容与审核", icon: <HomeOutlined /> },
  { key: "/homepage", label: "首页配置", section: "内容与审核", icon: <HomeOutlined /> },
  { key: "/orders", label: "订单管理", section: "用户与支付", icon: <ShoppingOutlined /> },
  { key: "/entitlements", label: "权益管理", section: "用户与支付", icon: <SafetyCertificateOutlined /> },
  { key: "/payment-addresses", label: "USDT 收款地址", section: "用户与支付", icon: <ApiOutlined /> },
  { key: "/users", label: "用户检索", section: "用户与支付", icon: <TeamOutlined /> },
  { key: "/bot-users", label: "Bot 用户管理", section: "用户与支付", icon: <TeamOutlined /> },
  { key: "/tickets", label: "客服工单", section: "用户与支付", icon: <MessageOutlined /> },
  { key: "/channels", label: "Bot 频道管理", section: "系统设置", icon: <ApiOutlined /> },
  { key: "/platform-metadata", label: "平台 SEO / GEO", section: "系统设置", icon: <TagsOutlined /> },
];

const PAGE_TITLE_BY_PATH = Object.fromEntries(NAVIGATION.map((item) => [item.key, item.label]));
const keyForPath = (pathname: string) => NAVIGATION.find((item) => pathname === item.key || pathname.startsWith(`${item.key}/`))?.key || "/dashboard";
const menuItems = () => Array.from(new Set(NAVIGATION.map((item) => item.section))).map((section) => ({
  key: `section:${section}`, label: section, type: "group" as const,
  children: NAVIGATION.filter((item) => item.section === section).map((item) => ({ key: item.key, icon: item.icon, label: item.label })),
}));

const AdminLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { me, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1100);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const selectedKey = keyForPath(location.pathname);
  const currentItem = NAVIGATION.find((item) => item.key === selectedKey);
  const pageTitle = PAGE_TITLE_BY_PATH[selectedKey] || "运营工作台";
  const commands = useMemo(() => {
    const query = commandQuery.trim().toLocaleLowerCase();
    return query ? NAVIGATION.filter((item) => `${item.label} ${item.section}`.toLocaleLowerCase().includes(query)) : NAVIGATION;
  }, [commandQuery]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const openCommand = () => { setCommandQuery(""); setCommandOpen(true); };
  const go = (key: string) => { navigate(key); setCommandOpen(false); setCommandQuery(""); };
  const onLogoutClick = () => confirm({
    title: "确认退出登录？", icon: <ExclamationCircleFilled />, okText: "退出", cancelText: "取消", okButtonProps: { danger: true },
    onOk: async () => { await logout(); navigate("/login", { replace: true }); },
  });

  return <Layout className="admin-shell">
    <Sider className="admin-sider" width={264} collapsedWidth={76} collapsed={collapsed} trigger={null} theme="dark">
      <div className="admin-brand" onClick={() => go("/dashboard")} role="button" tabIndex={0}>
        <div className="admin-brand-mark">S</div>{!collapsed && <div><strong>SAMEWAVE</strong><span>运营管理台</span></div>}
      </div>
      {!collapsed && <button className="admin-command-trigger" onClick={openCommand}><SearchOutlined /><span>搜索页面与工具</span><kbd>Ctrl K</kbd></button>}
      <Menu className="admin-main-menu" theme="dark" mode="inline" inlineCollapsed={collapsed} selectedKeys={[selectedKey]} onClick={({ key }) => go(String(key))} items={menuItems()} />
      <div className="admin-sider-footer"><Tooltip title={collapsed ? "展开导航" : "收起导航"} placement="right"><Button type="text" className="admin-collapse-button" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((value) => !value)}>{!collapsed && "收起导航"}</Button></Tooltip></div>
    </Sider>
    <Layout className="admin-workspace">
      <Header className="admin-header">
        <Space size={12}>{collapsed && <Button className="admin-header-icon" icon={<MenuUnfoldOutlined />} onClick={() => setCollapsed(false)} />}<div><Text className="admin-header-kicker">{currentItem?.section || "工作台"}</Text><Title level={4}>{pageTitle}</Title></div></Space>
        <Space size={8}>
          <Tooltip title="搜索页面与工具（Ctrl K)"><Button className="admin-header-icon" icon={<SearchOutlined />} onClick={openCommand} /></Tooltip>
          <Button icon={<FileSearchOutlined />} onClick={() => setContextOpen(true)}>当前页</Button>
          <Dropdown menu={{ items: [{ key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: onLogoutClick }] }} placement="bottomRight"><button className="admin-user-button"><Avatar size="small" icon={<UserOutlined />} /><span>{me?.displayName || me?.email || "管理员"}</span></button></Dropdown>
        </Space>
      </Header>
      <Content className="admin-content"><Outlet /></Content>
    </Layout>
    <Modal open={commandOpen} footer={null} title="快速前往" onCancel={() => setCommandOpen(false)} width={620} destroyOnClose>
      <Input autoFocus prefix={<SearchOutlined />} value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} onPressEnter={() => commands[0] && go(commands[0].key)} placeholder="搜索页面或运营工具" size="large" />
      <div className="admin-command-results">{commands.map((item) => <button key={item.key} onClick={() => go(item.key)}><span className="admin-command-icon">{item.icon}</span><span><b>{item.label}</b><small>{item.section}</small></span></button>)}{commands.length === 0 && <Text type="secondary">没有匹配的管理入口。</Text>}</div>
    </Modal>
    <Drawer title="当前工作上下文" open={contextOpen} onClose={() => setContextOpen(false)} width={420}>
      <Tag color="blue">{currentItem?.section || "工作台"}</Tag><Title level={4}>{pageTitle}</Title>
      <Text type="secondary">在当前列表页查看或处理具体视频、文章、订单、用户及审核项时，保持筛选与分页上下文，优先使用各业务页的右侧详情抽屉。</Text><Divider />
      <Text strong>同一工作区入口</Text><div className="admin-context-links">{NAVIGATION.filter((item) => item.section === currentItem?.section).map((item) => <Button key={item.key} type={item.key === selectedKey ? "primary" : "default"} icon={item.icon} onClick={() => go(item.key)}>{item.label}</Button>)}</div>
    </Drawer>
  </Layout>;
};

export default AdminLayout;
