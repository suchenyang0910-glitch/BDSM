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

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function signPayload(secret: string, payload: string): string {
  return crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(payload).digest("base64url");
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
