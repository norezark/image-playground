'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const hashImage = buffer => createHash('sha256').update(buffer).digest('hex');
const isPng = buffer => buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

// Original inputs and processed inputs share immutable, content-addressed files.
// Metadata stays in history.db; deleting a history card never deletes a shared file.
function createImageStore({ root, db }) {
  const directory = path.resolve(root, 'public', 'images', 'inputs');
  fs.mkdirSync(directory, { recursive: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_assets (
      hash TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS synthid_cache (
      input_hash TEXT NOT NULL, recipe TEXT NOT NULL, output_hash TEXT NOT NULL,
      PRIMARY KEY (input_hash, recipe)
    );
    CREATE TABLE IF NOT EXISTS image_cache_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const byHash = db.prepare('SELECT * FROM image_assets WHERE hash = ?');
  const saveAsset = db.prepare('INSERT OR REPLACE INTO image_assets (hash, url, mime_type) VALUES (?, ?, ?)');
  const cached = db.prepare('SELECT output_hash FROM synthid_cache WHERE input_hash = ? AND recipe = ?');
  const saveCache = db.prepare('INSERT OR REPLACE INTO synthid_cache (input_hash, recipe, output_hash) VALUES (?, ?, ?)');
  const forgetCache = db.prepare("UPDATE synthid_cache SET output_hash = '' WHERE input_hash = ? AND recipe = ?");
  let existingFiles;
  let previousEntries = [];
  let previousRecipe;

  function imagePath(url) {
    if (typeof url !== 'string' || !/^\/images\/inputs\/[a-zA-Z0-9_.-]+$/.test(url)) return null;
    const result = path.resolve(directory, path.basename(url));
    return path.dirname(result) === directory ? result : null;
  }

  function readLocal(url) {
    const filename = imagePath(url);
    try {
      // Do not follow a link outside the managed input directory.
      if (!filename || !fs.lstatSync(filename).isFile()) return null;
      return fs.readFileSync(filename);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function loadAsset(row) {
    if (!row) return null;
    const buffer = readLocal(row.url);
    if (!buffer || hashImage(buffer) !== row.hash) return null;
    return { hash: row.hash, url: row.url, mimeType: row.mime_type, filename: path.basename(row.url), buffer };
  }

  function findExistingFile(hash) {
    if (!existingFiles) {
      existingFiles = new Map();
      // Read-only indexing: leave old filenames, files and history untouched.
      for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!file.isFile() || !/\.(png|jpe?g|webp)$/i.test(file.name)) continue;
        const url = `/images/inputs/${file.name}`;
        const buffer = readLocal(url);
        if (!buffer) continue;
        const contentHash = hashImage(buffer);
        if (!existingFiles.has(contentHash)) existingFiles.set(contentHash, { hash: contentHash, url,
          mime_type: /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.webp$/i.test(file.name) ? 'image/webp' : 'image/png' });
      }
    }
    return loadAsset(existingFiles.get(hash));
  }

  function put(buffer, mimeType = 'image/png') {
    const hash = hashImage(buffer);
    const existing = loadAsset(byHash.get(hash)) || findExistingFile(hash);
    if (existing) {
      saveAsset.run(hash, existing.url, existing.mimeType);
      return existing;
    }
    if (isPng(buffer)) mimeType = 'image/png';
    else if (buffer[0] === 255 && buffer[1] === 216) mimeType = 'image/jpeg';
    else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
    const url = `/images/inputs/sha256-${hash}.${extension}`;
    const filename = imagePath(url);
    const present = readLocal(url);
    if (!present || hashImage(present) !== hash) {
      const temporary = path.join(directory, `.write-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, buffer, { flag: 'wx' });
        fs.renameSync(temporary, filename);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    saveAsset.run(hash, url, mimeType);
    return { hash, url, mimeType, filename: path.basename(url), buffer };
  }

  function getPreprocessed(inputBuffer, recipe) {
    const inputHash = hashImage(inputBuffer);
    const row = cached.get(inputHash, recipe);
    if (row) {
      const result = loadAsset(byHash.get(row.output_hash));
      if (result && isPng(result.buffer)) return result;
      forgetCache.run(inputHash, recipe);
      return null;
    }
    // Consult previous results on demand without converting existing data.
    // Never reuse these unversioned results after the worker recipe changes.
    if (recipe === previousRecipe) {
      for (const entry of previousEntries) {
        if (!entry.params?.remove_synthid || !entry.inputImages?.length
          || entry.inputImages.length !== entry.processedInputImages?.length) continue;
        for (let index = 0; index < entry.inputImages.length; index++) {
          const input = readLocal(entry.inputImages[index]);
          if (!input || hashImage(input) !== inputHash) continue;
          const output = readLocal(entry.processedInputImages[index]);
          if (output && isPng(output)) {
            const known = db.prepare('SELECT recipe FROM synthid_cache WHERE input_hash = ? AND output_hash = ?').all(inputHash, hashImage(output));
            if (known.length && !known.some(row => row.recipe === recipe)) continue;
            return savePreprocessed(inputBuffer, recipe, output);
          }
        }
      }
    }
    return null;
  }

  function savePreprocessed(inputBuffer, recipe, outputBuffer) {
    if (!isPng(outputBuffer)) throw new Error('SynthID除去エンジンから有効なPNGが返されませんでした。');
    const result = put(outputBuffer, 'image/png');
    saveCache.run(hashImage(inputBuffer), recipe, result.hash);
    return result;
  }

  function setHistory(history, recipe) {
    previousEntries = history.slice();
    db.prepare('INSERT OR IGNORE INTO image_cache_settings (name, value) VALUES (?, ?)').run('previous-results-recipe', recipe);
    previousRecipe = db.prepare('SELECT value FROM image_cache_settings WHERE name = ?').get('previous-results-recipe').value;
  }

  function cacheCount(recipe) {
    return db.prepare("SELECT COUNT(*) AS count FROM synthid_cache WHERE recipe = ? AND output_hash <> ''").get(recipe).count;
  }

  return { put, getPreprocessed, savePreprocessed, setHistory, cacheCount };
}

module.exports = { createImageStore, hashImage, isPng };
