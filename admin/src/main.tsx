import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./components/AuthProvider";
import RequireAuth from "./components/RequireAuth";
import AdminLayout from "./components/AdminLayout";
import LoginPage from "./pages/Login";
import DashboardPage from "./pages/Dashboard";
import OrdersPage from "./pages/Orders";
import EntitlementsPage from "./pages/Entitlements";
import PaymentAddressesPage from "./pages/PaymentAddresses";
import UsersPage from "./pages/Users";
import SupportTicketsPage from "./pages/SupportTickets";
import ContentsPage from "./pages/Contents";
import PackagesPage from "./pages/Packages";
import CategoriesPage from "./pages/Categories";
import BannersPage from "./pages/Banners";
import HomepageConfigPage from "./pages/HomepageConfig";
import ChannelsPage from "./pages/Channels";
import PlatformMetadataPage from "./pages/PlatformMetadata";
import AnalyticsPage from "./pages/Analytics";
import TrafficEntriesPage from "./pages/TrafficEntries";
import FinanceCenterPage from "./pages/FinanceCenter";
import CampaignsPage from "./pages/Campaigns";
import ArticlesPage from "./pages/Articles";
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
        <BrowserRouter basename="/admin">
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <AdminLayout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/traffic-entries" element={<TrafficEntriesPage />} />
              <Route path="/campaigns" element={<CampaignsPage />} />
              <Route path="/finance" element={<FinanceCenterPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/entitlements" element={<EntitlementsPage />} />
              <Route path="/payment-addresses" element={<PaymentAddressesPage />} />
              <Route path="/users" element={<UsersPage />} />
              <Route path="/bot-users" element={<UsersPage />} />
              <Route path="/tickets" element={<SupportTicketsPage />} />
              <Route path="/contents" element={<ContentsPage />} />
              <Route path="/articles" element={<ArticlesPage />} />
              <Route path="/packages" element={<PackagesPage />} />
              <Route path="/categories" element={<CategoriesPage />} />
              <Route path="/banners" element={<BannersPage />} />
              <Route path="/homepage" element={<HomepageConfigPage />} />
              <Route path="/channels" element={<ChannelsPage />} />
              <Route path="/platform-metadata" element={<PlatformMetadataPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
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
