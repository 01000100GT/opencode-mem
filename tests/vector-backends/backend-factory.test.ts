import { describe, expect, it } from "bun:test";
import { createVectorBackend } from "../../src/services/vector-backends/backend-factory.js";
import type { VectorBackend } from "../../src/services/vector-backends/types.js";

function createThrowingBackend(method: "search" | "rebuildFromShard"): VectorBackend {
  return {
    getBackendName: () => "hnswlib-wasm",
    insert: async () => {},
    insertBatch: async () => {},
    delete: async () => {},
    search: async (args) => {
      if (method === "search") throw new Error("boom-search");
      void args;
      return [];
    },
    rebuildFromShard: async (args) => {
      if (method === "rebuildFromShard") throw new Error("boom-rebuild");
      void args;
    },
    deleteShardIndexes: async () => {},
  };
}

describe("vector backend factory", () => {
  it("defaults to hnswlib-wasm-first strategy", async () => {
    const backend = await createVectorBackend({
      vectorBackend: "hnswlib-wasm-first",
      probeHnswlib: async () => true,
    });

    expect(backend.getBackendName()).toBe("hnswlib-wasm");
  });

  it("falls back to exact scan when hnswlib-wasm-first cannot load hnswlib", async () => {
    const backend = await createVectorBackend({
      vectorBackend: "hnswlib-wasm-first",
      probeHnswlib: async () => false,
    });

    expect(backend.getBackendName()).toBe("exact-scan");
  });

  it("uses hnswlib-wasm backend when requested and available", async () => {
    const backend = await createVectorBackend({
      vectorBackend: "hnswlib-wasm",
      probeHnswlib: async () => true,
    });

    expect(backend.getBackendName()).toBe("hnswlib-wasm");
  });

  it("falls back to exact scan when hnswlib-wasm is unavailable", async () => {
    const backend = await createVectorBackend({
      vectorBackend: "hnswlib-wasm",
      probeHnswlib: async () => false,
    });

    expect(backend.getBackendName()).toBe("exact-scan");
  });

  it("falls back to exact scan on hnswlib search failure", async () => {
    const backend = await createVectorBackend({
      vectorBackend: "hnswlib-wasm-first",
      probeHnswlib: async () => true,
      createHnswlibBackend: () => createThrowingBackend("search"),
    });

    const result = await backend.search({
      db: {
        prepare: () => ({
          all: () => [],
        }),
      },
      shard: {
        id: 1,
        scope: "project",
        scopeHash: "hash",
        shardIndex: 0,
        dbPath: "test.db",
        vectorCount: 0,
        isActive: true,
        createdAt: Date.now(),
      },
      kind: "content",
      queryVector: new Float32Array([1, 0, 0, 0]),
      limit: 1,
    });

    expect(backend.getBackendName()).toBe("exact-scan");
    expect(result).toEqual([]);
  });

  it("falls back to exact scan on hnswlib rebuild failure", async () => {
    const backend = await createVectorBackend({
      vectorBackend: "hnswlib-wasm-first",
      probeHnswlib: async () => true,
      createHnswlibBackend: () => createThrowingBackend("rebuildFromShard"),
    });

    await expect(
      backend.rebuildFromShard({
        db: null,
        shard: {
          id: 1,
          scope: "project",
          scopeHash: "hash",
          shardIndex: 0,
          dbPath: "test.db",
          vectorCount: 0,
          isActive: true,
          createdAt: Date.now(),
        },
        kind: "content",
      })
    ).resolves.toBeUndefined();

    expect(backend.getBackendName()).toBe("exact-scan");
  });
});
