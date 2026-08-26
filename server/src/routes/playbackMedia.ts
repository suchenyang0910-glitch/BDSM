import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createPrivatePresignedReadUrl } from "../services/objectStorage.js";
import type { PlaybackConfig } from "../services/playbackConfig.js";
import { resolvePlaybackEntitlement } from "../services/playbackSessions.js";
import { verifyPlaybackToken } from "../services/playbackDelivery.js";

const routeParams = z.object({ contentId: z.string().uuid(), variant: z.enum(["preview", "full"]), "*": z.string().min(1).max(512) });
function isSafeRelativeMediaPath(value: string): boolean { return value.length > 0 && !value.includes("\\") && !value.includes("..") && !value.startsWith("/") && /^[A-Za-z0-9._/-]+$/.test(value); }
function mediaPath(contentId: string, variant: "preview" | "full", relative: string): string { return `/playback/${encodeURIComponent(contentId)}/${variant}/${relative.split("/").map(encodeURIComponent).join("/")}`; }
function rewriteManifest(input: { text: string; contentId: string; variant: "preview" | "full" }): string | null {
  const rewrite = (raw: string) => isSafeRelativeMediaPath(raw) ? mediaPath(input.contentId, input.variant, raw) : null;
  const result: string[] = [];
  for (const line of input.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { result.push(line); continue; }
    const map = trimmed.match(/URI="([^"]+)"/);
    if (map) { const next = rewrite(map[1]); if (!next) return null; result.push(line.replace(map[1], next)); continue; }
    if (!trimmed.startsWith("#")) { const next = rewrite(trimmed); if (!next) return null; result.push(next); continue; }
    result.push(line);
  }
  return result.join("\n");
}

/** Same-origin, cookie-gated HLS gateway. Caddy proxies only /playback/* here. */
export default async function playbackMediaRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;
  const cfg = (fastify as any).playbackConfig as PlaybackConfig;
  const signingKey = String(process.env.VIDEO_CDN_SIGNING_KEY || "");
  const cookieName = cfg?.signingMode === "edge_token" ? "__Host-intune_edge" : "__Host-intune_playback";
  fastify.get("/playback/:contentId/:variant/*", async (req: any, reply) => {
    const params = routeParams.safeParse(req.params || {});
    if (!params.success || !isSafeRelativeMediaPath(params.data["*"])) return reply.status(404).send({ error: "not_found" });
    const token = verifyPlaybackToken({ token: req.cookies?.[cookieName], signingKey });
    if (!token || token.contentId !== params.data.contentId || token.variant !== params.data.variant) return reply.status(401).send({ error: "playback_unauthorized" });
    const now = new Date();
    const session = await prisma.playbackSession.findFirst({ where: { id: token.sessionId, contentId: token.contentId, status: "active", revokedAt: null, expiresAt: { gt: now } }, include: { content: { include: { fullVideoAsset: { include: { renditions: true } } } } } });
    if (!session || !session.content || session.content.status !== "published") return reply.status(403).send({ error: "playback_revoked" });
    const grant = await prisma.playbackGrant.findFirst({ where: { playbackSessionId: session.id, contentId: session.contentId, revokedAt: null, expiresAt: { gt: now } }, select: { id: true } });
    if (!grant) return reply.status(403).send({ error: "playback_revoked" });
    if (params.data.variant === "full") {
      const entitlement = await resolvePlaybackEntitlement(prisma, { userId: session.userId, content: session.content, now });
      if (!entitlement.ok) return reply.status(403).send({ error: "entitlement_required" });
    }
    const relative = params.data["*"];
    const renditions = Array.isArray(session.content.fullVideoAsset?.renditions) ? session.content.fullVideoAsset.renditions : [];
    let objectKey: string | null = null;
    if (params.data.variant === "preview") {
      const rendition = renditions.find((row: any) => row.kind === "preview" && row.status === "ready" && row.prefixKey);
      objectKey = rendition ? `${rendition.prefixKey}/${relative}` : null;
    } else if (relative === "master.m3u8") {
      const rendition = renditions.find((row: any) => row.kind !== "preview" && row.status === "ready" && row.prefixKey);
      objectKey = rendition ? `${String(rendition.prefixKey).split("/").slice(0, -1).join("/")}/master.m3u8` : null;
    } else {
      const [kind, ...rest] = relative.split("/");
      const rendition = renditions.find((row: any) => row.kind === kind && row.kind !== "preview" && row.status === "ready" && row.prefixKey);
      objectKey = rendition && rest.length > 0 ? `${rendition.prefixKey}/${rest.join("/")}` : null;
    }
    if (!objectKey) return reply.status(404).send({ error: "media_not_ready" });
    if (relative.endsWith(".m3u8")) {
      try {
        const signed = await createPrivatePresignedReadUrl(objectKey, 30);
        const upstream = await fetch(signed.downloadUrl);
        if (!upstream.ok) return reply.status(404).send({ error: "media_not_found" });
        const body = rewriteManifest({ text: await upstream.text(), contentId: params.data.contentId, variant: params.data.variant });
        if (!body) return reply.status(404).send({ error: "media_not_found" });
        return reply.header("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8").header("Cache-Control", "private, no-store").send(body);
      } catch { return reply.status(503).send({ error: "media_unavailable" }); }
    }
    try { const signed = await createPrivatePresignedReadUrl(objectKey, 30); return reply.header("Cache-Control", "private, no-store").redirect(signed.downloadUrl, 302); }
    catch { return reply.status(503).send({ error: "media_unavailable" }); }
  });
}
