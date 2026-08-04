import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { join } from "node:path";

const TIMEOUT_MS = 30000;
const GLOBAL_EMBEDDING_KEY = Symbol.for("opencode-mem.embedding.instance");
const MAX_CACHE_SIZE = 100;

type HfTransformers = typeof import("@huggingface/transformers");

let _transformers: {
  pipeline: HfTransformers["pipeline"];
  env: HfTransformers["env"];
} | null = null;

function getTransformersPackageSpecifier(): string {
  // Keep this non-literal so OpenCode/Bun plugin-loader bundling does not eagerly
  // traverse @huggingface/transformers internals during plugin startup. The package
  // is only needed for the local embedding backend, and should stay lazy.
  return ["@huggingface", "transformers"].join("/");
}

async function ensureTransformersLoaded(): Promise<NonNullable<typeof _transformers>> {
  if (_transformers !== null) return _transformers;
  // 强制 transformers.js v4 走纯 WASM 的 onnxruntime-web：通过全局 hook 覆盖其默认的
  // onnxruntime-node（在无平台 binding 的环境 import 必失败），使 Node/Bun/Windows/Linux/ARM 行为一致。
  await injectOnnxruntimeWebHook();
  const mod = (await import(getTransformersPackageSpecifier())) as HfTransformers;
  mod.env.allowLocalModels = true;
  mod.env.allowRemoteModels = true;
  mod.env.cacheDir = join(CONFIG.storagePath, ".cache");
  // Keep ONNX WASM single-threaded for Bun/Node runtimes without SharedArrayBuffer.
  try {
    (mod.env as any).backends.onnx.wasm.numThreads = 1;
    // 定向到 onnxruntime-web 自带的 wasm 文件，避免按脚本 URL 相对路径解析失败
    (mod.env as any).backends.onnx.wasm.wasmPaths = new URL(
      "../../node_modules/onnxruntime-web/dist/",
      import.meta.url
    ).href;
  } catch (e) {
    log("Failed to configure onnx wasm backend", { error: String(e) });
  }
  _transformers = mod;
  return _transformers!;
}

// 将 onnxruntime-web 注入全局 hook（幂等），必须在 import(@huggingface/transformers) 之前调用
let _ortHookInjected = false;
async function injectOnnxruntimeWebHook(): Promise<void> {
  if (_ortHookInjected) return;
  const ort = (await import("onnxruntime-web")) as typeof import("onnxruntime-web");
  (globalThis as any)[Symbol.for("onnxruntime")] = ort;
  _ortHookInjected = true;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

export class EmbeddingService {
  private pipe: any = null;
  private initPromise: Promise<void> | null = null;
  public isWarmedUp: boolean = false;
  private cache: Map<string, Float32Array> = new Map();
  private cachedModelName: string | null = null;

  static getInstance(): EmbeddingService {
    if (!(globalThis as any)[GLOBAL_EMBEDDING_KEY]) {
      (globalThis as any)[GLOBAL_EMBEDDING_KEY] = new EmbeddingService();
    }
    return (globalThis as any)[GLOBAL_EMBEDDING_KEY];
  }

  async warmup(progressCallback?: (progress: any) => void): Promise<void> {
    if (this.isWarmedUp) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initializeModel(progressCallback);
    return this.initPromise;
  }

  private async initializeModel(progressCallback?: (progress: any) => void): Promise<void> {
    try {
      if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
        // Send a probe request to verify the API endpoint is actually reachable
        // Uses a minimal embedding of "ping" to test the full request pipeline
        const probeResponse = await withTimeout(
          fetch(`${CONFIG.embeddingApiUrl}/embeddings`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${CONFIG.embeddingApiKey}`,
            },
            body: JSON.stringify({
              input: "ping",
              model: CONFIG.embeddingModel,
            }),
          }),
          TIMEOUT_MS
        );

        if (!probeResponse.ok) {
          throw new Error(
            `Embedding API health check failed: ${probeResponse.status} ${probeResponse.statusText}`
          );
        }

        this.isWarmedUp = true;
        return;
      }

      // Local model path
      const { pipeline } = await ensureTransformersLoaded();
      // 仅在配置了 embeddingDtype 时透传给 transformers.js；未配置则保持库默认（fp32）
      const pipelineOpts: Record<string, unknown> = { progress_callback: progressCallback };
      if (CONFIG.embeddingDtype) {
        pipelineOpts.dtype = CONFIG.embeddingDtype;
      }
      this.pipe = await pipeline("feature-extraction", CONFIG.embeddingModel, pipelineOpts);
      this.isWarmedUp = true;
      log("Embedding model warmed up", { model: CONFIG.embeddingModel });
    } catch (error) {
      this.initPromise = null;
      log("Failed to initialize embedding model", { error: String(error) });
      throw error;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (this.cachedModelName !== CONFIG.embeddingModel) {
      this.clearCache();
      this.cachedModelName = CONFIG.embeddingModel;
    }

    const cached = this.cache.get(text);
    if (cached) return cached;

    if (!this.isWarmedUp && !this.initPromise) {
      await this.warmup();
    }
    if (this.initPromise) {
      await this.initPromise;
    }

    let result: Float32Array;

    if (CONFIG.embeddingApiUrl && CONFIG.embeddingApiKey) {
      const response = await fetch(`${CONFIG.embeddingApiUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.embeddingApiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: CONFIG.embeddingModel,
        }),
      });

      if (!response.ok) {
        throw new Error(`API embedding failed: ${response.statusText}`);
      }

      const data: any = await response.json();
      result = new Float32Array(data.data[0].embedding);
    } else {
      const output = await this.pipe(text, { pooling: "mean", normalize: true });
      result = new Float32Array(output.data);
    }

    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(text, result);

    return result;
  }

  async embedWithTimeout(text: string): Promise<Float32Array> {
    return withTimeout(this.embed(text), TIMEOUT_MS);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const embeddingService = EmbeddingService.getInstance();
