import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const sql = fs.readFileSync(path.resolve("src/sql/migrations.sql"), "utf8");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(sql);
  console.log("✓ Migrations applied");
} finally {
  await pool.end();
}