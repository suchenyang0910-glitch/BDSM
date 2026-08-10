import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { adminLogin, adminLogout as doLogout, adminMe } from "../api/client";
import type { AdminMe } from "../api/types";

type AuthState = {
  me: AdminMe | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    try {
      const data = await adminMe();
      setMe(data);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    try {
      await adminLogin(email, password);
      await refresh();
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await doLogout();
    } finally {
      setMe(null);
      setLoading(false);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ me, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
