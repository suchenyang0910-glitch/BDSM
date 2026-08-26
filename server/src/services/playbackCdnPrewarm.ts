import { emitSafetyEvent } from "../utils/structuredError.js";
import { createPlaybackDeliverySigner } from "./playbackDelivery.js";
import type { PlaybackConfig } from "./playbackConfig.js";

type PrewarmVariant = "preview" | "full";
type RenditionKind = "preview" | "hls_480" | "hls_720" | "hls_1080";

type PrewarmFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function cookieHeaderFromSetCookie(value: string | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.split(";")[0] || null;
}

function safeUrlJoin(base: string, relative: string): string {
  return new URL(relative, base).toString();
}

function parseManifestTargets(manifestText: string, manifestUrl: string, limitSegments: number): string[] {
  const targets: string[] = [];
  let mapUrl: string | null = null;
  let segmentCount = 0;
  for (const rawLine of manifestText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP:")) {
      const match = line.match(/URI="([^"]+)"/i);
      if (match?.[1]) mapUrl = safeUrlJoin(manifestUrl, match[1]);
      continue;
    }
    if (line.startsWith("#")) continue;
    if (/\.m3u8($|\?)/i.test(line)) continue;
    if (segmentCount >= limitSegments) continue;
    targets.push(safeUrlJoin(manifestUrl, line));
    segmentCount += 1;
  }
  return mapUrl ? [mapUrl, ...targets] : targets;
}

async function fetchText(fetchImpl: PrewarmFetch, url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetchImpl(url, {
    method: "GET",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`prewarm_fetch_${res.status}`);
  }
  return await res.text();
}

async function warmUrl(fetchImpl: PrewarmFetch, url: string, headers: Record<string, string>) {
  const res = await fetchImpl(url, {
    method: "GET",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`prewarm_fetch_${res.status}`);
  }
}

async function warmManifestAndSegments(fetchImpl: PrewarmFetch, manifestUrl: string, headers: Record<string, string>, segmentLimit: number) {
  const manifest = await fetchText(fetchImpl, manifestUrl, headers);
  const targets = parseManifestTargets(manifest, manifestUrl, segmentLimit);
  for (const target of targets) {
    await warmUrl(fetchImpl, target, headers);
  }
}

function buildVariantManifestUrl(baseManifestUrl: string, contentId: string, kind: RenditionKind): string {
  if (kind === "preview") {
    return baseManifestUrl;
  }
  const base = baseManifestUrl.replace(`/playback/${encodeURIComponent(contentId)}/full/master.m3u8`, `/playback/${encodeURIComponent(contentId)}/full/${kind}/index.m3u8`);
  return base;
}

export async function prewarmPlaybackCdnForContent(input: {
  prisma: any;
  playbackConfig: PlaybackConfig;
  signingKey: string;
  contentId: string;
  fetchImpl?: PrewarmFetch;
}) {
  if (input.playbackConfig.mode === "disabled" || !input.playbackConfig.configured) {
    return { attempted: false, warmedUrls: 0 };
  }
  if (process.env.NODE_ENV === "test") {
    return { attempted: false, warmedUrls: 0 };
  }

  const fetchImpl = input.fetchImpl || (globalThis.fetch as PrewarmFetch | undefined);
  if (typeof fetchImpl !== "function") {
    emitSafetyEvent({ event: "playback_cdn_prewarm_unavailable", errorClass: "delivery_unavailable", note: "fetch_missing" });
    return { attempted: false, warmedUrls: 0 };
  }

  const content = await input.prisma.content.findUnique({
    where: { id: input.contentId },
    select: {
      id: true,
      previewEnabled: true,
      fullVideoAsset: {
        select: {
          id: true,
          renditions: {
            where: { status: "ready" },
            select: { kind: true },
          },
        },
      },
    },
  });
  if (!content?.fullVideoAsset?.id) {
    emitSafetyEvent({ event: "playback_cdn_prewarm_skipped", errorClass: "not_found", note: "full_asset_missing" });
    return { attempted: false, warmedUrls: 0 };
  }

  const signer = createPlaybackDeliverySigner({
    cdnBaseUrl: input.playbackConfig.cdnBaseUrl || "https://video.invalid",
    signingMode: input.playbackConfig.signingMode || "signed_cookie",
    sessionTtlSeconds: input.playbackConfig.sessionTtlSeconds,
    signingKey: input.signingKey,
  });
  const expiresAt = new Date(Date.now() + Math.min(input.playbackConfig.sessionTtlSeconds, 300) * 1000);
  let warmedUrls = 0;

  const warmVariant = async (variant: PrewarmVariant, renditionKinds: RenditionKind[], segmentLimit: number) => {
    const issued = await signer.issue({
      sessionId: `prewarm-${variant}-${input.contentId}`,
      contentId: input.contentId,
      expiresAt,
      variant,
    });
    const cookie = cookieHeaderFromSetCookie(issued.responseHeaders["set-cookie"]);
    const headers: Record<string, string> = cookie ? { cookie } : {};
    if (variant === "preview") {
      await warmManifestAndSegments(fetchImpl, issued.manifestUrl, headers, segmentLimit);
      warmedUrls += 2;
      return;
    }
    await warmUrl(fetchImpl, issued.manifestUrl, headers);
    warmedUrls += 1;
    for (const kind of renditionKinds) {
      const manifestUrl = buildVariantManifestUrl(issued.manifestUrl, input.contentId, kind);
      await warmManifestAndSegments(fetchImpl, manifestUrl, headers, segmentLimit);
      warmedUrls += 3;
    }
  };

  try {
    const renditionKinds = ((content.fullVideoAsset.renditions || []) as Array<{ kind: RenditionKind }>)
      .map((row) => row.kind)
      .filter((kind) => kind === "hls_480" || kind === "hls_720" || kind === "hls_1080");
    if (content.previewEnabled !== false && content.fullVideoAsset.renditions.some((row: any) => row.kind === "preview")) {
      await warmVariant("preview", ["preview"], 2);
    }
    if (renditionKinds.length > 0) {
      await warmVariant("full", renditionKinds, 2);
    }
    return { attempted: true, warmedUrls };
  } catch (error) {
    emitSafetyEvent({
      event: "playback_cdn_prewarm_failed",
      errorClass: "delivery_unavailable",
      note: `content_fp=${String(input.contentId).slice(0, 8)}`,
    }, error);
    return { attempted: true, warmedUrls };
  }
}
