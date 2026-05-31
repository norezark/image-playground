'use strict';
const fs   = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const HISTORY_DB   = path.join(__dirname, '..', 'history.db');
const HISTORY_FILE = path.join(__dirname, '..', 'history.json'); // マイグレーション用

// ---- SQLite 初期化 ----
const db = new DatabaseSync(HISTORY_DB);
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    prompt      TEXT NOT NULL,
    params      TEXT NOT NULL,
    images      TEXT NOT NULL,
    input_images TEXT,
    timestamp   TEXT NOT NULL,
    retries     INTEGER DEFAULT 0,
    status      TEXT NOT NULL,
    error       TEXT,
    favorited   INTEGER DEFAULT 0
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_timestamp ON entries (timestamp DESC)`);
// favorited カラムが存在しない場合は追加（旧 DB の後方互換）
try { db.exec('ALTER TABLE entries ADD COLUMN favorited INTEGER DEFAULT 0'); } catch {}
// favorited_images カラムが存在しない場合は追加
try { db.exec('ALTER TABLE entries ADD COLUMN favorited_images TEXT DEFAULT NULL'); } catch {}

const _stmtInsert = db.prepare(
  `INSERT OR REPLACE INTO entries (id, prompt, params, images, input_images, timestamp, retries, status, error, favorited_images)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const _stmtFavoriteImages = db.prepare(`UPDATE entries SET favorited_images = ? WHERE id = ?`);
const _stmtDelete  = db.prepare(`DELETE FROM entries WHERE id = ?`);
const _stmtAll     = db.prepare(`SELECT * FROM entries ORDER BY timestamp DESC`);
const _stmtFindIdx = db.prepare(`SELECT id FROM entries WHERE id = ?`);

function _rowToEntry(row) {
  return {
    id:             row.id,
    prompt:         row.prompt,
    params:         JSON.parse(row.params),
    images:         JSON.parse(row.images),
    inputImages:    row.input_images ? JSON.parse(row.input_images) : undefined,
    timestamp:      row.timestamp,
    retries:        row.retries,
    status:         row.status,
    error:          row.error || undefined,
    favoritedImages: row.favorited_images ? JSON.parse(row.favorited_images) : [],
  };
}

function dbSaveEntry(entry) {
  _stmtInsert.run(
    entry.id,
    entry.prompt,
    JSON.stringify(entry.params || {}),
    JSON.stringify(entry.images || []),
    entry.inputImages ? JSON.stringify(entry.inputImages) : null,
    entry.timestamp,
    entry.retries || 0,
    entry.status,
    entry.error || null,
    entry.favoritedImages?.length ? JSON.stringify(entry.favoritedImages) : null,
  );
}

function dbDeleteEntry(id) {
  _stmtDelete.run(id);
}

function dbLoadHistory() {
  return _stmtAll.all().map(_rowToEntry);
}

// ---- history.json からの移行 ----
if (fs.existsSync(HISTORY_FILE)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    if (Array.isArray(legacy) && legacy.length > 0) {
      const migrate = db.prepare(
        `INSERT OR IGNORE INTO entries (id, prompt, params, images, input_images, timestamp, retries, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      db.exec('BEGIN');
      for (const e of legacy) {
        try {
          migrate.run(
            e.id, e.prompt,
            JSON.stringify(e.params || {}),
            JSON.stringify(e.images || []),
            e.inputImages ? JSON.stringify(e.inputImages) : null,
            e.timestamp, e.retries || 0,
            e.status || 'completed',
            e.error || null,
          );
        } catch { /* skip invalid entries */ }
      }
      db.exec('COMMIT');
      console.log(`history.json から ${legacy.length} 件を SQLite へ移行しました。`);
      fs.renameSync(HISTORY_FILE, HISTORY_FILE + '.bak');
    }
  } catch (err) {
    console.error('history.json の移行に失敗しました:', err);
  }
}

module.exports = { db, dbSaveEntry, dbDeleteEntry, dbLoadHistory, _stmtFindIdx, _stmtFavoriteImages };
