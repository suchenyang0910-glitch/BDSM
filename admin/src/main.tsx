import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./components/AuthProvider";
import RequireAuth from "./components/RequireAuth";
import AdminLayout from "./components/AdminLayout";
import LoginPage from "./pages/Login";
import OrdersPage from "./pages/Orders";
import EntitlementsPage from "./pages/Entitlements";
import UsersPage from "./pages/Users";
import SupportTicketsPage from "./pages/SupportTickets";
import ContentsPage from "./pages/Contents";
import CategoriesPage from "./pages/Categories";
import BannersPage from "./pages/Banners";
import HomepageConfigPage from "./pages/HomepageConfig";
import ChannelsPage from "./pages/Channels";
import "dayjs/locale/zh-cn";
import dayjs from "dayjs";

dayjs.locale("zh-cn");

const App: React.FC = () => (
  <ConfigProvider
    locale={zhCN}
    theme={{
      token: {
        colorPrimary: "#1677ff",
        borderRadius: 8,
        fontFamily:
          '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif',
      },
    }}
  >
    <AntApp>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <AdminLayout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/orders" replace />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/entitlements" element={<EntitlementsPage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/tickets" element={<SupportTicketsPage />} />
              <Route path="/contents" element={<ContentsPage />} />
              <Route path="/categories" element={<CategoriesPage />} />
              <Route path="/banners" element={<BannersPage />} />
              <Route path="/homepage" element={<HomepageConfigPage />} />
              <Route path="/channels" element={<ChannelsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/orders" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </AntApp>
  </ConfigProvider>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
