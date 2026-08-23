import React, { useEffect, useState } from "react";
import { Form, Input, Button, Card, Typography, Alert, message as antdMsg, Spin } from "antd";
import { LockOutlined, MailOutlined } from "@ant-design/icons";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../components/AuthProvider";

const { Title, Paragraph, Text } = Typography;

const LoginPage: React.FC = () => {
  const { me, login, loading: authLoading } = useAuth();
  const [query] = useSearchParams();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me && !authLoading) {
      navigate(query.get("redirect") || "/orders", { replace: true });
    }
  }, [me, authLoading, navigate, query]);

  const onFinish = async (values: { email: string; password: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      await login(values.email.trim(), values.password);
      antdMsg.success("登录成功");
      const to = query.get("redirect") || "/orders";
      navigate(to, { replace: true });
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      if (status === 401) {
        setError(body?.message || "邮箱或密码错误，请使用正确的管理员账号登录");
      } else if (status === 403) {
        setError(body?.message || "账号已停用，请联系超级管理员");
      } else if (status === 400) {
        setError("请输入有效的邮箱地址和密码（密码至少 1 个字符）");
      } else {
        setError(
          "登录失败：" + (body?.message || body?.error || err?.message || "未知错误，请检查后端服务是否运行于 :3000"),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading || me) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spin size="large" tip="正在进入系统..." />
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg,#0f172a 0%, #1e293b 50%, #334155 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <Card style={{ width: 420, boxShadow: "0 10px 40px rgba(0,0,0,.25)" }}>
        <div style={{ marginBottom: 20, textAlign: "center" }}>
          <Title level={3} style={{ marginBottom: 4 }}>
            同频 InTune · 管理后台
          </Title>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            订单管理 · 人工补单 · 财务审计入口
          </Paragraph>
        </div>

        {error && (
          <Alert
            style={{ marginBottom: 16 }}
            type="error"
            showIcon
            message="登录失败"
            description={error}
          />
        )}

        <Form layout="vertical" onFinish={onFinish} disabled={submitting} autoComplete="on">
          <Form.Item
            label="管理员邮箱"
            name="email"
            rules={[
              { required: true, message: "请输入邮箱" },
              { type: "email", message: "邮箱格式不正确" },
            ]}
          >
            <Input size="large" prefix={<MailOutlined />} placeholder="admin@intune.local" />
          </Form.Item>

          <Form.Item
            label="管理员密码"
            name="password"
            rules={[{ required: true, message: "请输入密码" }]}
          >
            <Input.Password size="large" prefix={<LockOutlined />} placeholder="登录密码" />
          </Form.Item>

          <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
            登录管理后台
          </Button>
        </Form>

        <div style={{ marginTop: 20, padding: 12, background: "#f8fafc", borderRadius: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            请使用由系统管理员创建的后台账号登录。登录后请及时修改初始密码，并妥善保管账号信息。
          </Text>
        </div>
      </Card>
    </div>
  );
};

export default LoginPage;
