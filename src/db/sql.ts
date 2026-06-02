import fs from "node:fs";
import path from "node:path";
import sqlite3 from "@journeyapps/sqlcipher";
import { env } from "../config/env.js";

const dbDir = path.dirname(env.SQLCIPHER_DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

sqlite3.verbose();

const db = new sqlite3.Database(env.SQLCIPHER_DB_PATH);

const run = (sql: string, params: unknown[] = []) =>
  new Promise<void>((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

export const get = <T>(sql: string, params: unknown[] = []) =>
  new Promise<T | undefined>((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row as T | undefined);
    });
  });

export const all = <T>(sql: string, params: unknown[] = []) =>
  new Promise<T[]>((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows as T[]);
    });
  });

export const initializeDatabase = async () => {
  await run("PRAGMA key = ?;", [env.SQLCIPHER_KEY]);
  await run("PRAGMA foreign_keys = ON;");
  await run(`
    CREATE TABLE IF NOT EXISTS admin_user (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reset_token TEXT,
      reset_token_expires TEXT
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS auth_challenge (
      id TEXT PRIMARY KEY,
      otp_hash TEXT NOT NULL,
      magic_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      failed_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Migration: add failed_attempts to pre-existing auth_challenge tables
  try {
    await run("ALTER TABLE auth_challenge ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists – ignore
  }

  await run(`
    CREATE TABLE IF NOT EXISTS routing_rule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pattern TEXT NOT NULL,
      pattern_type TEXT NOT NULL CHECK (pattern_type IN ('wildcard', 'regex')),
      endpoint_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS pending_message (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      destination TEXT,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'FAILED', 'BOUNCED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt TEXT NOT NULL,
      received_at TEXT NOT NULL,
      last_error TEXT
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS message_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      destination TEXT,
      status TEXT NOT NULL,
      event_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS app_setting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

export const exec = run;
export { db };
