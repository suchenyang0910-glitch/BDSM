import assert from "node:assert/strict";
import test from "node:test";
import { isPublicMediaAssetKind, makePublicUrl } from "../src/services/objectStorage.js";

test("object storage exposes only cover and preview assets as public", () => {
  assert.equal(isPublicMediaAssetKind("cover_image"), true);
  assert.equal(isPublicMediaAssetKind("preview_video"), true);
  assert.equal(isPublicMediaAssetKind("full_video"), false);
});

test("object storage public URL uses the configured public base only", () => {
  const url = makePublicUrl("bucket", "sgp1", "20260823/cover_image/a.jpg", {
    endpoint: "https://sgp1.digitaloceanspaces.com",
    region: "sgp1",
    bucket: "bucket",
    accessKeyId: "access",
    secretAccessKey: "secret",
    publicBaseUrl: "https://bucket.sgp1.cdn.digitaloceanspaces.com",
  });
  assert.equal(url, "https://bucket.sgp1.cdn.digitaloceanspaces.com/20260823/cover_image/a.jpg");
});
