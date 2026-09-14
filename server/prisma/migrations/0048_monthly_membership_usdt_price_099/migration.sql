-- 月度会员的 Telegram Stars 主价保持不变；只将 H5 / Web / Mini App
-- 使用的 TRC-20 备用标价从 9.99 USDT 调整为 0.99 USDT。
-- 已创建订单保留自己的 amount_minor，不受该商品配置更新影响。
UPDATE "products"
SET "usdt_price_minor" = 990000
WHERE "type" = 'membership'
  AND "duration_days" = 30
  AND "status" = 'active'
  AND "usdt_price_minor" = 9990000;
