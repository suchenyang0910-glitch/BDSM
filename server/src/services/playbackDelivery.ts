import crypto from "node:crypto";

import type { PlaybackConfig } from "./playbackConfig.js";

export type PlaybackDeliverySigner = {
  issue(input: { sessionId: string; contentId: string; expiresAt: Date; variant: "preview" | "full" }): Promise<{
    manifestUrl: string;
    responseHeaders: Record<string, string>;
    tokenFingerprint: string;
    scopePath: string;
  }>;
  revoke?(input: { sessionId: string; contentId: string }): Promise<void>;
};

export type VerifiedPlaybackToken = {
  sessionId: string;
  contentId: string;
  variant: "preview" | "full";
  expiresAt: Date;
};

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function signPayload(secret: string, payload: string): string {
  return crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyPlaybackToken(input: { token: string | undefined; signingKey: string; now?: Date }): VerifiedPlaybackToken | null {
  const token = String(input.token || "");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;
  if (!safeEqual(signPayload(input.signingKey, parts[1]), parts[2])) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sessionId = typeof payload.sid === "string" ? payload.sid : "";
    const contentId = typeof payload.cid === "string" ? payload.cid : "";
    const variant = payload.var === "preview" || payload.var === "full" ? payload.var : null;
    const expiresAt = new Date(String(payload.exp || ""));
    if (!sessionId || !contentId || !variant || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= (input.now || new Date()).getTime()) return null;
    return { sessionId, contentId, variant, expiresAt };
  } catch {
    return null;
  }
}

function fingerprintToken(secret: string, token: string): string {
  return crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(`playback-token:${token}`).digest("hex");
}

export function createPlaybackDeliverySigner(
  cfg: Pick<PlaybackConfig, "cdnBaseUrl" | "signingMode" | "sessionTtlSeconds"> & { signingKey: string },
): PlaybackDeliverySigner {
  return {
    async issue(input) {
      const contentPath = input.variant === "preview"
        ? `/playback/${encodeURIComponent(input.contentId)}/preview/index.m3u8`
        : `/playback/${encodeURIComponent(input.contentId)}/full/master.m3u8`;
      const payload = JSON.stringify({
        sid: input.sessionId,
        cid: input.contentId,
        var: input.variant,
        exp: input.expiresAt.toISOString(),
      });
      const tokenBody = base64UrlEncode(payload);
      const signature = signPayload(cfg.signingKey, tokenBody);
      const token = `v1.${tokenBody}.${signature}`;
      const ttlSeconds = Math.max(1, Math.floor((input.expiresAt.getTime() - Date.now()) / 1000));
      const cookieName = cfg.signingMode === "edge_token" ? "__Host-intune_edge" : "__Host-intune_playback";
      const cookie = [
        `${cookieName}=${token}`,
        `Max-Age=${ttlSeconds}`,
        `Path=/playback/${encodeURIComponent(input.contentId)}/${input.variant}/`,
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
      ].join("; ");

      return {
        manifestUrl: `${cfg.cdnBaseUrl}${contentPath}`,
        responseHeaders: {
          "set-cookie": cookie,
        },
        tokenFingerprint: fingerprintToken(cfg.signingKey, token),
        scopePath: `/playback/${input.contentId}/${input.variant}/*`,
      };
    },
    async revoke() {
      return;
    },
  };
}
