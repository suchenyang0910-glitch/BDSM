import type { FastifyInstance } from "fastify";
import {
  createChannelInvite,
  sendDirectMessage,
  refRawChatId,
  type ChannelRef,
} from "../services/telegramBot.js";
import {
  resolveContentChannelId,
  resolvePackageChannelId,
} from "../services/channelCrypto.js";
import {
  isValidFreeChannelCode,
  refFreeChannelByCode,
  tryGetFreeChannelPublicUrl,
  getFreeChannelEntry,
  PUBLIC_FREE_CHANNELS,
} from "../services/freeChannels.js";
import { emitSafetyEvent } from "../utils/structuredError.js";
import { resolveMembershipChannelRef } from "../services/membershipChannel.js";

export default async function resourceRoutes(fastify: FastifyInstance) {
  const prisma = (fastify as any).prisma;

  async function handleAccessLink(req: any, reply: any) {
    const uid = req.userId as string | undefined;
    const { id: resourceId } = req.params as { id: string };
    const now = new Date();

    if (!uid) {
      return reply.status(401).send({ error: "unauthorized", message: "未登录" });
    }

    const content = await prisma.content.findUnique({
      where: { id: resourceId },
      select: {
        id: true,
        status: true,
        accessType: true,
        packageId: true,
        title: true,
      },
    });

    if (!content) {
      return reply.status(404).send({ error: "not_found", message: "内容不存在" });
    }
    if (content.status !== "published") {
      return reply.status(409).send({ error: "content_unavailable", message: "内容已下架或未上架" });
    }

    if (content.accessType === "single") {
      return reply.status(409).send({
        error: "single_delivery_not_enabled",
        message: "单篇购买（single）首期不支持，共享 VIP 频道无法做到只开放单条内容。",
      });
    }

    let channelRef: ChannelRef | null = null;
    let validEntitlementId: string | null = null;
    // 免费频道有公开 t.me 链接的话直接返回，不走一次性 invite 创建
    let publicDirectUrl: string | null = null;
    // 解析 chatId 用于 telegram_invites 入库（Fail-Closed: 解析不到则不写 invite 记录）
    let resolvedChatIdForInvite: bigint | null = null;

    if (content.accessType === "public") {
      const publicContent = await prisma.content.findUnique({
        where: { id: resourceId },
        select: { freeChannelCode: true, channelId: true, channelIdCiphertext: true },
      });
      const code = publicContent?.freeChannelCode;
      if (code && isValidFreeChannelCode(code)) {
        // 优先走白名单（P1-#7 强制路由）
        publicDirectUrl = tryGetFreeChannelPublicUrl(code);
        try {
          channelRef = refFreeChannelByCode(code);
          // 额外解析 chatId 用于入库（refFreeChannelByCode 内部没暴露 chatId，这里再取一次，Fail-Closed）
          const entry = getFreeChannelEntry(code);
          const envRaw = entry?.envVarName ? process.env[entry.envVarName] : null;
          if (envRaw && /^-?\d{6,22}$/.test(envRaw)) resolvedChatIdForInvite = BigInt(envRaw);
        } catch (err: any) {
          emitSafetyEvent(
            {
              event: "free_channel_env_resolve_failed",
              errorClass: "business",
              userId: uid,
              note: `resource=${resourceId} freeChannelCode=${code}`,
            },
            err,
          );
          return reply.status(503).send({
            error: "free_channel_not_configured",
            userError: "free_channel_not_configured",
            message: "该免费频道服务端未配置，请稍后重试或联系客服",
          });
        }
      } else {
        // 迁移期回退：老数据没 freeChannelCode，尝试解密 channelIdCiphertext（Fail-Closed：解析不到直接 409）
        const ch = resolveContentChannelId({
          channelId: publicContent?.channelId ?? null,
          channelIdCiphertext: publicContent?.channelIdCiphertext ?? null,
        });
        if (!ch) {
          return reply.status(409).send({
            error: "free_channel_code_required",
            message: "公开内容尚未绑定免费频道白名单编码；请编辑该内容，从免费频道下拉中选择一个合法频道。",
          });
        }
        channelRef = refRawChatId(ch);
        resolvedChatIdForInvite = ch;
      }
    } else {
      const entitlements = await prisma.entitlement.findMany({
        where: {
          userId: uid,
          status: "active",
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
        select: { id: true, resourceType: true, resourceId: true, expiresAt: true },
      });

      let matchedEntitlement: any = null;

      if (content.accessType === "membership") {
        const membershipE = entitlements.find((e: any) => e.resourceType === "membership_channel");
        if (!membershipE) {
          return reply.status(403).send({ error: "forbidden", message: "无访问权限，请完成会员订单" });
        }
        matchedEntitlement = membershipE;
        channelRef = await resolveMembershipChannelRef(prisma);
      } else if (content.accessType === "package") {
        if (!content.packageId) {
          return reply.status(400).send({
            error: "package_id_required",
            message: "package 类型内容必须绑定内容包",
          });
        }
        const pkgE = entitlements.find(
          (e: any) => e.resourceType === "package" && e.resourceId === content.packageId,
        );
        if (!pkgE) {
          return reply.status(403).send({ error: "forbidden", message: "无访问权限，请完成对应内容包的有效订单" });
        }
        matchedEntitlement = pkgE;
        const pkg = await prisma.contentPackage.findUnique({
          where: { id: content.packageId },
          select: { channelId: true, channelIdCiphertext: true },
        });
        const pkgChannel = resolvePackageChannelId({
          channelId: pkg?.channelId ?? null,
          channelIdCiphertext: pkg?.channelIdCiphertext ?? null,
        });
        if (!pkg || pkgChannel == null) {
          return reply.status(409).send({
            error: "delivery_channel_not_configured",
            message: "该内容包尚未配置交付频道，请联系运营确认受控频道映射已完成。",
          });
        }
        channelRef = refRawChatId(pkgChannel);
      } else {
        return reply.status(400).send({
          error: "unknown_access_type",
          message: "未知的内容访问类型",
        });
      }

      validEntitlementId = matchedEntitlement.id;
    }

    if (!channelRef) {
      return reply.status(500).send({ error: "internal_error", message: "交付通道解析失败" });
    }

    // 公开免费频道的直接 t.me URL（不走一次性 invite 创建，也不消耗 Bot 配额）
    if (publicDirectUrl) {
      // 尽力而为写条访问记录；chatId 没拿到就不写（Fail-Closed 不阻塞）
      if (resolvedChatIdForInvite) {
        prisma.telegramInvite
          .create({
            data: {
              userId: uid,
              entitlementId: validEntitlementId,
              channelId: resolvedChatIdForInvite,
              inviteLink: publicDirectUrl,
              expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
            },
          })
          .catch(() => {});
      }
      const user = await prisma.user.findUnique({ where: { id: uid }, select: { telegramUserId: true } });
      let dmSent = false;
      if (user?.telegramUserId) {
        try {
          const dm = await sendDirectMessage({
            telegramUserId: String(user.telegramUserId),
            text:
              `【同频 · 免费公开内容】\n` +
              `《${content.title || content.id}》\n直达公开频道：${publicDirectUrl}`,
            disableWebPagePreview: true,
          });
          dmSent = dm.success;
        } catch {
          dmSent = false;
        }
      }
      return reply.status(302).header("Location", publicDirectUrl).send({
        delivery: {
          method: dmSent ? "telegram_dm_sent_plus_302_redirect" : "302_redirect_only",
          redirectTo: "same-as-location-header",
          channel: "public_free_channel_direct_url",
          stub: false,
        },
      });
    }

    let invite!: Awaited<ReturnType<typeof createChannelInvite>>;
    try {
      invite = await createChannelInvite({
        channel: channelRef,
        name: `[InTune] uid=${uid.slice(0, 8)} content=${content.id.slice(0, 8)}`,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isConfigIssue =
        msg.includes("TELEGRAM_INVITE_BOT_KEY") ||
        msg.includes("TELEGRAM_BOTS") ||
        msg.includes("TELEGRAM_CHANNEL_MEMBERSHIP") ||
        msg.includes("no valid invite Bot");
      emitSafetyEvent(
        {
          event: isConfigIssue ? "invite_bot_not_configured" : "invite_bot_create_failed",
          errorClass: "business",
          userId: uid,
          note: isConfigIssue ? `配置缺失(res=${String(resourceId ?? "null").slice(0, 64)})` : `raw_len=${msg.length} res=${String(resourceId ?? "null").slice(0, 64)}`,
        },
        err,
      );
      return reply.status(isConfigIssue ? 503 : 502).send({
        error: isConfigIssue ? "bot_not_configured" : "bot_api_error",
        userError: isConfigIssue ? "invite_bot_not_configured" : "invite_bot_create_failed",
        message: isConfigIssue
          ? "暂不能发放入口：服务端邀请 Bot 未配置。请联系管理员检查 TELEGRAM_BOTS 和 TELEGRAM_INVITE_BOT_KEY。"
          : "暂不能发放入口：创建 Telegram 邀请失败，请稍后重试或联系支持。",
        hint:
          "管理员操作指引：1) 将受控 Bot Token 填入 server/.env 的 TELEGRAM_BOTS；2) 设置 TELEGRAM_INVITE_BOT_KEY；3) 重启服务端；4) 确认该 Bot 是收费频道管理员并授予创建邀请链接权限。",
      });
    }

    await prisma.telegramInvite.create({
      data: {
        userId: uid,
        entitlementId: validEntitlementId,
        channelId: invite._resolvedChannelId,
        inviteLink: invite.inviteLink,
        expiresAt: invite.expiresAt,
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: { telegramUserId: true },
    });
    let dmSent = false;
    if (user?.telegramUserId) {
      try {
        const dm = await sendDirectMessage({
          telegramUserId: String(user.telegramUserId),
          text:
            `【同频 · 内容访问】\n` +
            `你请求访问的内容《${content.title || content.id}》已生成专属邀请链接（1 小时内有效，限 1 人使用）：\n${invite.inviteLink}`,
          disableWebPagePreview: true,
        });
        dmSent = dm.success;
      } catch {
        dmSent = false;
      }
    }

    return reply.status(302).header("Location", invite.inviteLink).send({
      delivery: {
        method: dmSent ? "telegram_dm_sent_plus_302_redirect" : "302_redirect_only",
        redirectTo: "same-as-location-header",
        expiresAt: invite.expiresAt.toISOString(),
        ttlSeconds: invite.ttlSeconds,
        stub: invite.stub,
      },
    });
  }

  fastify.post<{ Params: { id: string } }>("/resources/:id/access-link", handleAccessLink);
  fastify.get<{ Params: { id: string } }>("/resources/:id/access-link", async (_req, reply) => {
    return reply.status(405).send({
      error: "method_not_allowed",
      message: "请使用 POST /api/resources/:id/access-link 由浏览器处理 302 跳转",
    });
  });

  fastify.get<{ Params: { id: string } }>("/videos/:id/telegram-link", async (_req, reply) => {
    return reply.status(410).send({
      error: "gone",
      message: "GET /api/videos/:id/telegram-link 已废弃，请使用 GET /api/resources/:id/access-link 由浏览器处理 302 跳转",
    });
  });

  // ============================================================
  // P0 修复：我的可进入频道（H5 & Mini App 共用）
  //   聚合 public（免费白名单）+ membership 会员主频道 + package 内容包交付频道
  //   安全策略：
  //     1. 不批量调用 createChannelInvite（避免 bot 限流），只返回 resourceId 触发点和 public 现成 link
  //     2. 用户点击「进入频道」按钮时再单条调 POST /api/resources/:resourceId/access-link
  //     3. 免费频道 env 缺失：Fail-Closed 不抛 503，只在条目标 available=false + reason 中文
  //     4. 返回绝对不暴露明文 chatId 或 channelIdCiphertext/hmac
  // ============================================================
  fastify.get("/user/channels", async (req, reply) => {
    const uid = (req as any).userId as string | undefined;
    if (!uid) return reply.status(401).send({ error: "unauthorized", userError: "unauthorized", message: "请先完成登录后再查看你的频道" });

    const prisma = (fastify as any).prisma;
    const items: Array<{
      id: string;
      kind: "public" | "membership" | "package";
      label: string;
      subtitle: string;
      accessMode: "public_link" | "invite_link_on_demand";
      link: string | null;
      available: boolean;
      resourceId?: string;
      reason?: string;
    }> = [];

    // ----- 1. 后台已登记的免费公开频道（优先）-----
    // 频道管理页是运营的单一事实来源。只返回标题与公开 URL，绝不下发 chatId / 密文 / HMAC。
    const managedPublicChannels = await prisma.adminManagedChannel.findMany({
      where: { purpose: "free_preview", chatType: "channel", isPrivate: false },
      orderBy: [{ updatedAt: "desc" }],
      select: { id: true, title: true, username: true, publicUrl: true, botIsAdmin: true },
    });
    for (const channel of managedPublicChannels) {
      const publicUrl = String(channel.publicUrl || "").trim();
      const derivedUrl = channel.username ? `https://t.me/${String(channel.username).replace(/^@/, "")}` : "";
      const link = /^https:\/\/t\.me\/[A-Za-z0-9_]{3,128}$/i.test(publicUrl)
        ? publicUrl
        : (/^https:\/\/t\.me\/[A-Za-z0-9_]{3,128}$/i.test(derivedUrl) ? derivedUrl : null);
      items.push({
        id: `public-managed-${channel.id}`,
        kind: "public",
        label: channel.title || "免费公开频道",
        subtitle: "免费预览与平台公开内容",
        accessMode: "public_link",
        link,
        available: Boolean(link),
        reason: link ? undefined : "频道已登记，但尚未同步公开用户名或 t.me 链接。",
      });
    }

    // ----- 2. 兼容旧的 env 白名单配置（仅后台未登记免费频道时使用）-----
    if (managedPublicChannels.length === 0) for (const entry of PUBLIC_FREE_CHANNELS) {
      const code = entry.code;
      // 找一个 published + accessType=public + freeChannelCode=code 的内容作为 access-link 触发点
      let triggerContentId: string | null = null;
      try {
        const c = await prisma.content.findFirst({
          where: { status: "published", accessType: "public", freeChannelCode: code },
          select: { id: true },
        });
        triggerContentId = c?.id || null;
      } catch (_) {
        triggerContentId = null;
      }
      // 优先公开 t.me URL
      let publicLink: string | null = null;
      let configured = false;
      try {
        publicLink = tryGetFreeChannelPublicUrl(code);
        // 检查 env chatId 是否存在（Fail-Closed 不抛，只记录）
        const raw = entry.envVarName ? process.env[entry.envVarName] : null;
        if (publicLink || (raw && /^-?\d{6,22}$/.test(raw))) configured = true;
      } catch (_) {
        configured = false;
      }
      items.push({
        id: `public-${code}`,
        kind: "public",
        label: entry.label,
        subtitle: entry.description,
        accessMode: publicLink ? "public_link" : "invite_link_on_demand",
        link: publicLink,
        available: configured && (!!publicLink || !!triggerContentId),
        resourceId: triggerContentId || undefined,
        reason: configured ? undefined : "免费频道服务端尚未配置（env TELEGRAM_FREE_CHANNEL_*）",
      });
    }

    // ----- 3. 会员主频道（如果有 active membership_channel entitlement）-----
    try {
      const now = new Date();
      const membershipE = await prisma.entitlement.findFirst({
        where: {
          userId: uid,
          status: "active",
          resourceType: "membership_channel",
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
        select: { id: true, expiresAt: true, grantedAt: true, sourceOrderNo: true },
      });
      if (membershipE) {
        // 找一个 accessType=membership + published 的内容作为触发点
        const trigger = await prisma.content.findFirst({
          where: { status: "published", accessType: "membership" },
          select: { id: true },
        });
        const sub = [
          membershipE.expiresAt ? `有效期至 ${new Date(membershipE.expiresAt).toISOString().slice(0, 10)}` : "永久有效",
          membershipE.sourceOrderNo ? `订单：${membershipE.sourceOrderNo}` : "",
        ].filter(Boolean).join(" · ");
        items.push({
          id: "membership-main",
          kind: "membership",
          label: "VIP 会员专属频道",
          subtitle: sub || "会员期内可无限观看全部 VIP 视频内容",
          accessMode: "invite_link_on_demand",
          link: null,
          available: !!trigger,
          resourceId: trigger?.id || undefined,
          reason: trigger ? undefined : "系统尚未配置会员内容条目（accessType=membership），请联系运营。",
        });
      }
    } catch (_) {
    }

    // ----- 3. 内容包交付频道（每个 active package entitlement）-----
    try {
      const now = new Date();
      const pkgEntitlements = await prisma.entitlement.findMany({
        where: {
          userId: uid,
          status: "active",
          resourceType: "package",
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
        select: { id: true, resourceId: true, expiresAt: true, grantedAt: true, sourceOrderNo: true, productTitle: true, contentPackageTitle: true },
      });
      for (const e of pkgEntitlements) {
        const pkgId = e.resourceId;
        if (!pkgId) continue;
        // 找 packageId=pkgId + accessType=package + published 的任意内容 id 作为触发点
        const trigger = await prisma.content.findFirst({
          where: { status: "published", accessType: "package", packageId: pkgId },
          select: { id: true, title: true },
        });
        const pkgMeta = await prisma.contentPackage.findUnique({
          where: { id: pkgId },
          select: { id: true, title: true, status: true },
        }).catch(() => null);
        const label = e.contentPackageTitle || pkgMeta?.title || e.productTitle || `内容包 ${pkgId.slice(0, 8)}`;
        const sub = [
          e.expiresAt ? `有效期至 ${new Date(e.expiresAt).toISOString().slice(0, 10)}` : "无限期",
          e.sourceOrderNo ? `订单：${e.sourceOrderNo}` : "",
        ].filter(Boolean).join(" · ");
        items.push({
          id: `package-${pkgId}`,
          kind: "package",
          label,
          subtitle: sub || "已购内容包交付频道",
          accessMode: "invite_link_on_demand",
          link: null,
          available: !!trigger,
          resourceId: trigger?.id || undefined,
          reason: trigger ? undefined : "该内容包尚未发布任何交付内容条目（accessType=package），请联系运营完成发布配置。",
        });
      }
    } catch (_) {
    }

    return reply.status(200).send({ items, total: items.length });
  });
}
