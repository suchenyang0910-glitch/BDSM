import { sha256 } from "@noble/hashes/sha256.js";
import { bytesToHex } from "@noble/hashes/utils.js";

type WorkerRequest =
  | {
      type: "fingerprint";
      file: File;
      chunkSize: number;
      sampleSize: number;
    };

type WorkerProgress = {
  type: "progress";
  processedBytes: number;
  totalBytes: number;
};

type WorkerDone = {
  type: "done";
  sha256: string;
  headSha256: string;
  tailSha256: string;
};

type WorkerError = {
  type: "error";
  message: string;
};

async function digestHex(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return bytesToHex(sha256(bytes));
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const payload = event.data;
  if (!payload || payload.type !== "fingerprint") {
    return;
  }

  try {
    const { file, chunkSize, sampleSize } = payload;
    const totalBytes = file.size;
    const hasher = sha256.create();
    let processedBytes = 0;

    while (processedBytes < totalBytes) {
      const nextEnd = Math.min(processedBytes + chunkSize, totalBytes);
      const chunk = new Uint8Array(await file.slice(processedBytes, nextEnd).arrayBuffer());
      hasher.update(chunk);
      processedBytes = nextEnd;
      const progress: WorkerProgress = {
        type: "progress",
        processedBytes,
        totalBytes,
      };
      self.postMessage(progress);
    }

    const sampleBytes = Math.max(1, Math.min(sampleSize, totalBytes || sampleSize));
    const headSha256 = await digestHex(file.slice(0, sampleBytes));
    const tailSha256 = await digestHex(file.slice(Math.max(0, totalBytes - sampleBytes), totalBytes));
    const done: WorkerDone = {
      type: "done",
      sha256: bytesToHex(hasher.digest()),
      headSha256,
      tailSha256,
    };
    self.postMessage(done);
  } catch (error: any) {
    const failure: WorkerError = {
      type: "error",
      message: error instanceof Error ? error.message : "无法计算文件指纹",
    };
    self.postMessage(failure);
  }
};
