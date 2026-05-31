'use strict';
const fs   = require('fs');
const path = require('path');

// ---- 画像生成（リトライ付き） ----
// 依存する共有状態・関数をまとめて受け取り、startGeneration 関数を返すファクトリ。
function createStartGeneration({
  MAX_RETRIES,
  IMAGES_DIR,
  isGeminiModel,
  callGenerations,
  callEdits,
  callGemini,
  dbSaveEntry,
  broadcast,
  pendingEntries,
  abortControllers,
  history,
}) {
  return function startGeneration(id, entry, prompt, params, inputImageFiles) {
    let attempt = 0;

    async function tryGenerate() {
      if (!pendingEntries.has(id)) return;
      try {
        attempt++;
        const ac = new AbortController();
        abortControllers.set(id, ac);

        const response = isGeminiModel(params?.model)
          ? await callGemini(prompt, params, inputImageFiles, ac.signal)
          : inputImageFiles.length
            ? await callEdits(prompt, params, inputImageFiles, ac.signal)
            : await callGenerations(prompt, params, ac.signal);

        abortControllers.delete(id);
        if (!pendingEntries.has(id)) return;

        const fmt = params?.format === 'jpeg' ? 'jpeg' : params?.format === 'webp' ? 'webp' : 'png';
        entry.images = (response?.data || []).map((item, idx) => {
          if (item.url) return item.url;
          const itemFmt = item.mime_type === 'image/jpeg' ? 'jpeg' : item.mime_type === 'image/webp' ? 'webp' : fmt;
          const filename = `${entry.id}-${idx}.${itemFmt}`;
          fs.writeFileSync(path.join(IMAGES_DIR, filename), Buffer.from(item.b64_json, 'base64'));
          return `/images/${filename}`;
        });
        entry.status = 'completed';
        entry.error  = undefined;
        history.unshift(entry);
        dbSaveEntry(entry);
        pendingEntries.delete(id);
        broadcast({ type: 'completed', entry });
      } catch (err) {
        abortControllers.delete(id);
        if (err.name === 'AbortError') return;
        console.error('生成エラー:', err.message);
        entry.error = err.message;

        if (attempt < MAX_RETRIES) {
          if (!pendingEntries.has(id)) return;
          entry.retries = attempt;
          entry.status  = 'retrying';
          broadcast({ type: 'retry', id: entry.id, retries: entry.retries, error: entry.error });
          tryGenerate();
        } else {
          entry.retries = attempt;
          entry.status  = 'error';
          history.unshift(entry);
          dbSaveEntry(entry);
          pendingEntries.delete(id);
          broadcast({ type: 'error', id: entry.id, error: err.message, entry });
        }
      }
    }

    tryGenerate();
  };
}

module.exports = { createStartGeneration };
