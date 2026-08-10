import type { FastifyInstance } from "fastify";
import {
  createChannelInvite,
  sendDirectMessage,
  refMembershipMain,
  refRawChatId,
} from "../services/telegramBot.js";

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
        channelId: true,
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

    let channelId: bigint | null = content.channelId;
    let validEntitlementId: string | null = null;
    let membershipMatched = false;

    if (content.accessType !== "public") {
      const entitlements = await prisma.entitlement.findMany({
        where: {
          userId: uid,
          status: "active",
          OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
        },
        select: { id: true, resourceType: true, resourceId: true, expiresAt: true },
      });

      const matchSingle = entitlements.find(
        (e: any) => e.resourceType === "content" && e.resourceId === content.id,
      );
      const matchPackage =
        content.packageId &&
        entitlements.find(
          (e: any) => e.resourceType === "package" && e.resourceId === content.packageId,
        );
      const hasMembership = entitlements.some((e: any) => e.resourceType === "membership_channel");
      const matchMembership = content.accessType === "membership" && hasMembership;
      membershipMatched = !!matchMembership;

      const matchedEntitlement =
        matchSingle ||
        matchPackage ||
        (matchMembership ? entitlements.find((e: any) => e.resourceType === "membership_channel") : null);

      if (!matchedEntitlement) {
        return reply.status(403).send({ error: "forbidden", message: "无访问权限，请完成有效订单" });
      }
      validEntitlementId = matchedEntitlement.id;

      if (!channelId && content.packageId) {
        const pkg = await prisma.contentPackage.findUnique({
          where: { id: content.packageId },
          select: { channelId: true },
        });
        channelId = pkg?.channelId || null;
      }

      // 【Security Boundary - 细节2】路由层严禁直接从 env 取明文 chatId；
      // membership 频道的 chatId 在 telegramBot.ts 服务层通过 refMembershipMain() 解析
    } else if (!channelId) {
      // public 内容如果未配 channelId 不生成链接
      return reply.status(409).send({
        error: "channel_missing",
        message: "公开内容尚未配置访问通道；请前往公开频道预览：" + (process.env.PUBLIC_CHANNEL_URL || ""),
      });
    }

    let invite!: Awaited<ReturnType<typeof createChannelInvite>>;
    try {
      // 【Security Boundary - 细节2】根据命中类型传递 ChannelRef
      const channel = membershipMatched
        ? refMembershipMain()
        : channelId
        ? refRawChatId(channelId)
        : refMembershipMain();
      invite = await createChannelInvite({
        channel,
        name: `[InTune] uid=${uid.slice(0, 8)} content=${content.id.slice(0, 8)}`,
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isConfigIssue =
        msg.includes("TELEGRAM_INVITE_BOT_KEY") ||
        msg.includes("TELEGRAM_BOTS") ||
        msg.includes("TELEGRAM_CHANNEL_MEMBERSHIP") ||
        msg.includes("no valid invite Bot");
      console.error("[access-link] createChannelInvite failed: telegram_api_error (详细错误已脱敏)");
      return reply.status(isConfigIssue ? 503 : 502).send({
        error: isConfigIssue ? "bot_not_configured" : "bot_api_error",
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
        channelId: invite._resolvedChannelId, // 细节2：同一调用栈内部使用解析值，不暴露给 JSON
        inviteLink: invite.inviteLink,
        expiresAt: invite.expiresAt,
      },
    });

    // 【Security Boundary - 细节3】前端 API 永远不含 inviteLink 字段
    // 优先通过 Telegram Bot 私信发送邀请链接；同时提供一次性 302 跳转作为备用
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

    // 302 跳转作为备用交付方式；邀请链接直接在 Location 中，绝不写入响应 body
    return reply.status(302).header("Location", invite.inviteLink).send({
      delivery: {
        method: dmSent ? "telegram_dm_sent_plus_302_redirect" : "302_redirect_only",
        redirectTo: "same-as-location-header", // 占位说明，不重复明文链接
        expiresAt: invite.expiresAt.toISOString(),
        ttlSeconds: invite.ttlSeconds,
        stub: invite.stub,
      },
    });
  }

  fastify.post<{ Params: { id: string } }>("/resources/:id/access-link", handleAccessLink);

  fastify.get<{ Params: { id: string } }>("/videos/:id/telegram-link", async (_req, reply) => {
    return reply.status(410).send({
      error: "gone",
      message: "GET /api/videos/:id/telegram-link 已废弃，请使用 POST /api/resources/:id/access-link",
      hint: "废弃原因：防止浏览器预取、爬虫或邮件预览在无用户交互时误发邀请",
    });
  });
  fastify.get<{ Params: { id: string } }>("/resources/:id/access-link", async (_req, reply) => {
    return reply.status(405).send({
      error: "method_not_allowed",
      message: "access-link 只允许 POST，防止浏览器预取误发邀请",
      allowedMethods: ["POST"],
    });
  });
}
