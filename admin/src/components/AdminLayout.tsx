import React, { useState } from "react";
import { Layout, Menu, Avatar, Dropdown, Button, Space, Typography } from "antd";
import {
  UserOutlined,
  LogoutOutlined,
  ShoppingOutlined,
  VideoCameraOutlined,
  TagsOutlined,
  AppstoreOutlined,
  HomeOutlined,
  ExclamationCircleFilled,
  SafetyCertificateOutlined,
  TeamOutlined,
  MessageOutlined,
  SettingOutlined,
  ApiOutlined,
} from "@ant-design/icons";
import { useNavigate, useLocation, Outlet } from "react-router-dom";
import { Modal } from "antd";
import { useAuth } from "../components/AuthProvider";
import type { AdminRole } from "../api/types";

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;
const { confirm } = Modal;

const ROLE_LABEL: Record<AdminRole, string> = {
  super_admin: "超级管理员",
  operator: "运营",
  editor: "内容编审",
  customer_service: "客服",
  finance: "财务",
  auditor: "审计",
};

const PAGE_TITLE_BY_PATH: Record<string, string> = {
  "/orders": "订单与权益 · 订单管理",
  "/entitlements": "订单与权益 · 权益管理",
  "/users": "订单与权益 · 用户检索",
  "/tickets": "订单与权益 · 客服工单",
  "/contents": "内容管理 · 视频内容",
  "/categories": "内容管理 · 分类与标签",
  "/banners": "内容管理 · Banner 运营位",
  "/homepage": "内容管理 · 首页配置",
  "/channels": "系统设置 · Bot 频道管理",
};

const AdminLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { me, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const selectedKey = (() => {
    const p = location.pathname;
    if (p.startsWith("/contents")) return "/contents";
    if (p.startsWith("/categories")) return "/categories";
    if (p.startsWith("/banners")) return "/banners";
    if (p.startsWith("/homepage")) return "/homepage";
    if (p.startsWith("/orders")) return "/orders";
    if (p.startsWith("/entitlements")) return "/entitlements";
    if (p.startsWith("/users")) return "/users";
    if (p.startsWith("/tickets")) return "/tickets";
    if (p.startsWith("/channels")) return "/channels";
    return "/orders";
  })();
  const openKeys = (() => {
    const p = location.pathname;
    const keys: string[] = ["orders"];
    if (["/contents", "/categories", "/banners", "/homepage"].some((k) => p.startsWith(k))) keys.push("content");
    if (["/channels"].some((k) => p.startsWith(k))) keys.push("settings");
    return keys;
  })();
  const pageTitle = PAGE_TITLE_BY_PATH[selectedKey] || "订单管理";

  const onLogoutClick = () => {
    confirm({
      title: "确认退出登录？",
      icon: <ExclamationCircleFilled />,
      okText: "退出",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: async () => {
        await logout();
        navigate("/login", { replace: true });
      },
    });
  };

  const userMenu = {
    items: [
      {
        key: "logout",
        icon: <LogoutOutlined />,
        label: "退出登录",
        onClick: onLogoutClick,
      },
    ],
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider collapsible collapsed={collapsed} onCollapse={(v) => setCollapsed(v)} theme="dark">
        <div
          style={{
            color: "white",
            padding: collapsed ? "16px 0" : "16px 20px",
            fontWeight: 700,
            fontSize: collapsed ? 14 : 16,
            borderBottom: "1px solid rgba(255,255,255,0.1)",
            letterSpacing: 1,
          }}
        >
          {collapsed ? "InTune" : "同频 · 管理后台"}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          defaultOpenKeys={openKeys}
          onClick={({ key }) => navigate(key)}
          items={[
            {
              key: "content",
              icon: <AppstoreOutlined />,
              label: "内容管理",
              children: [
                { key: "/contents", icon: <VideoCameraOutlined />, label: "视频内容" },
                { key: "/categories", icon: <TagsOutlined />, label: "分类与标签" },
                { key: "/banners", icon: <HomeOutlined />, label: "Banner 运营位" },
                { key: "/homepage", icon: <HomeOutlined />, label: "首页配置" },
              ],
            },
            {
              key: "orders",
              icon: <ShoppingOutlined />,
              label: "订单与权益",
              children: [
                { key: "/orders", icon: <ShoppingOutlined />, label: "订单管理" },
                { key: "/entitlements", icon: <SafetyCertificateOutlined />, label: "权益管理" },
                { key: "/users", icon: <TeamOutlined />, label: "用户检索" },
                { key: "/tickets", icon: <MessageOutlined />, label: "客服工单" },
              ],
            },
            {
              key: "settings",
              icon: <SettingOutlined />,
              label: "系统设置",
              children: [
                { key: "/channels", icon: <ApiOutlined />, label: "Bot 频道管理" },
              ],
            },
          ]}
          style={{ borderRight: 0, marginTop: 8 }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid #f0f0f0",
          }}
        >
          <Title level={4} style={{ margin: 0 }}>
            {pageTitle}
          </Title>
          <Dropdown menu={userMenu} placement="bottomRight">
            <Space style={{ cursor: "pointer" }}>
              <Avatar size="small" icon={<UserOutlined />} style={{ backgroundColor: "#1677ff" }} />
              <Space direction="vertical" size={0}>
                <Text strong>{me?.displayName || me?.email || "管理员"}</Text>
                <Text type="secondary" style={{ fontSize: 12, lineHeight: 1 }}>
                  {me?.role ? ROLE_LABEL[me.role] : ""}
                </Text>
              </Space>
              <Button type="text" size="small">
                菜单
              </Button>
            </Space>
          </Dropdown>
        </Header>
        <Content style={{ margin: 16, background: "#fff", padding: 20, borderRadius: 8 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
};

export default AdminLayout;
