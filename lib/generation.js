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
  function normalizeGeneratedImages(response) {
    const candidates = [response?.data, response?.images, response?.output, response?.result];
    const items = [];

    for (const candidate of candidates) {
      if (!Array.isArray(candidate) || candidate.length === 0) continue;
      for (const item of candidate) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.url === 'string' || typeof item.b64_json === 'string' || typeof item.inlineData?.data === 'string') {
          items.push(item);
        }
      }
      if (items.length > 0) break;
    }

    return items;
  }

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
        const generatedItems = normalizeGeneratedImages(response);
        if (generatedItems.length === 0) {
          throw new Error('生成API から画像が返されませんでした');
        }

        entry.images = generatedItems.map((item, idx) => {
          if (item.url) return item.url;
          if (item.inlineData?.data) {
            const mimeType = item.inlineData.mimeType || 'image/png';
            const itemFmt = mimeType === 'image/jpeg' ? 'jpeg' : mimeType === 'image/webp' ? 'webp' : fmt;
            const filename = `${entry.id}-${idx}.${itemFmt}`;
            fs.writeFileSync(path.join(IMAGES_DIR, filename), Buffer.from(item.inlineData.data, 'base64'));
            return `/images/${filename}`;
          }
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
