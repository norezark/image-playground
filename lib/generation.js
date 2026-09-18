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
  preprocessImages,
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
    let editImages = inputImageFiles;
    const apiParams = { ...params };
    delete apiParams.remove_synthid;
    const ac = new AbortController();
    abortControllers.set(id, ac);

    function fail(error) {
      if (!pendingEntries.has(id) || ac.signal.aborted) return;
      entry.status = 'error';
      entry.error = error.message;
      entry.retries = attempt;
      delete entry.progress;
      history.unshift(entry);
      dbSaveEntry(entry);
      pendingEntries.delete(id);
      abortControllers.delete(id);
      broadcast({ type: 'error', id, error: error.message, entry });
    }

    async function tryGenerate() {
      if (!pendingEntries.has(id) || ac.signal.aborted) return;
      try {
        attempt++;

        const response = isGeminiModel(apiParams.model)
          ? await callGemini(prompt, apiParams, editImages, ac.signal)
          : editImages.length
            ? await callEdits(prompt, apiParams, editImages, ac.signal)
            : await callGenerations(prompt, apiParams, ac.signal);

        if (!pendingEntries.has(id) || ac.signal.aborted) return;

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
        delete entry.progress;
        history.unshift(entry);
        dbSaveEntry(entry);
        pendingEntries.delete(id);
        abortControllers.delete(id);
        broadcast({ type: 'completed', entry });
      } catch (err) {
        if (err.name === 'AbortError' || ac.signal.aborted || !pendingEntries.has(id)) return;
        console.error('生成エラー:', err.message);
        entry.error = err.message;

        if (attempt < MAX_RETRIES) {
          if (!pendingEntries.has(id)) return;
          entry.retries = attempt;
          entry.status  = 'retrying';
          broadcast({ type: 'retry', id: entry.id, retries: entry.retries, error: entry.error });
          return tryGenerate();
        } else {
          fail(err);
        }
      }
    }

    async function run() {
      if (params.remove_synthid) {
        try {
          if (!preprocessImages || !inputImageFiles.length) throw new Error('SynthID除去を実行できません。');
          editImages = await preprocessImages(inputImageFiles, { signal: ac.signal,
            onProgress: progress => {
              if (!pendingEntries.has(id) || ac.signal.aborted) return;
              entry.status = 'preprocessing';
              entry.progress = progress;
              broadcast({ type: 'processing', entry });
            },
          });
          if (!pendingEntries.has(id) || ac.signal.aborted) return;
          if (editImages.length !== inputImageFiles.length) throw new Error('一部の入力画像を処理できませんでした。');
          if (editImages.some(img => typeof img.url !== 'string')) throw new Error('前処理画像の保存先がありません。');
          entry.processedInputImages = editImages.map(img => img.url);
          const cacheHits = editImages.filter(img => img.cacheHit).length;
          entry.status = 'generating';
          entry.progress = cacheHits ? `前処理完了（${cacheHits}/${editImages.length}枚を再利用）・画像を生成中…` : '前処理完了・画像を生成中…';
          broadcast({ type: 'processing', entry });
        } catch (error) {
          // Never silently send the original, or repeat a costly failed scrub.
          fail(error);
          return;
        }
      }
      await tryGenerate();
    }
    return run();
  };
}

module.exports = { createStartGeneration };
