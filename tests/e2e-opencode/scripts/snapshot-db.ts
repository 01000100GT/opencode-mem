#!/usr/bin/env bun
/**
 * Snapshot the demo project's SQLite database into JSON for trace inspection.
 * Targets ~/.opencode-mem-demo-data/ai-sessions.db
 */
import { Database } from "bun:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH = join(homedir(), ".opencode-mem-demo-data", "ai-sessions.db");
const OUT_DIR = join(import.meta.dir, "..", "trace");

mkdirSync(OUT_DIR, { recursive: true });

const db = new Database(DB_PATH, { readonly: true });

interface Snapshot {
  generatedAt: string;
  dbPath: string;
  schema: Record<string, string>;
  counts: Record<string, number>;
  tables: Record<string, any[]>;
}

const generatedAt = new Date().toISOString();
const schema: Record<string, string> = {};
const tables: Record<string, any[]> = {};
const counts: Record<string, number> = {};

const tableNames = db
  .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);

for (const name of tableNames) {
  const ddl = db
    .query<
      { sql: string },
      [string]
    >("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  if (ddl?.sql) schema[name] = ddl.sql;

  const rows = db.query(`SELECT * FROM "${name}"`).all();
  tables[name] = rows;
  counts[name] = rows.length;
}

const snapshot: Snapshot = { generatedAt, dbPath: DB_PATH, schema, counts, tables };

const outPath = join(OUT_DIR, "db_snapshot.json");
writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

console.log(`✓ snapshot 写入 ${outPath}`);
for (const [name, count] of Object.entries(counts)) {
  console.log(`  ${name}: ${count} 行`);
}
