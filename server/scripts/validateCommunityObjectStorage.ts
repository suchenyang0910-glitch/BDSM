import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, requireObjectStorageEnv } from "../src/services/objectStorage.js";

const CONFIRM_FLAG = "--confirm-community-object-storage";

if (!process.argv.includes(CONFIRM_FLAG)) {
  throw new Error(`Refusing to write a temporary object without ${CONFIRM_FLAG}`);
}

async function readBody(body: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const storage = requireObjectStorageEnv();
const client = getS3Client();
const key = `community/acceptance/${randomUUID()}.txt`;
const payload = Buffer.from(`samewave-community-storage-acceptance:${randomUUID()}`, "utf8");
const expectedHash = createHash("sha256").update(payload).digest("hex");

let uploaded = false;
try {
  await client.send(new PutObjectCommand({
    Bucket: storage.bucket,
    Key: key,
    Body: payload,
    ContentType: "text/plain; charset=utf-8",
    CacheControl: "no-store",
  }));
  uploaded = true;
  const head = await client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }));
  if (Number(head.ContentLength || 0) !== payload.length) throw new Error("community_storage_length_mismatch");
  const result = await client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  const actualHash = createHash("sha256").update(await readBody(result.Body)).digest("hex");
  if (actualHash !== expectedHash) throw new Error("community_storage_hash_mismatch");
  console.log(JSON.stringify({ ok: true, verified: ["write", "head", "read_hash"] }));
} finally {
  if (uploaded) {
    await client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
    console.log(JSON.stringify({ cleanup: "deleted_temporary_acceptance_object" }));
  }
}
