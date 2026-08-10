import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Spin } from "antd";
import { useAuth } from "../components/AuthProvider";

const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { me, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spin size="large" tip="鉴权状态检查中..." />
      </div>
    );
  }
  if (!me) {
    return <Navigate to={"/login?redirect=" + encodeURIComponent(location.pathname + location.search)} replace />;
  }
  return <>{children}</>;
};

export default RequireAuth;
