// 履歴の順序とDOMを管理する。通常の更新は変更されたエントリだけに触れる。
export function createHistoryRenderer({ container, renderTile, tileSignature, releaseTile }) {
  let records = new Map();
  let ordered = [];
  let sequence = 0;
  let entryOrders = new Map();
  let visibleImages = null;

  const timeOf = entry => Date.parse(entry.timestamp) || 0;
  const compare = (a, b) => b.time - a.time || a.order - b.order;
  const firstNode = record => record.tiles.values().next().value.node;
  const urlsOf = (entry, favoritesOnly) => entry.images?.length
    ? entry.images.filter(url => !favoritesOnly || entry.favoritedImages?.includes(url))
    : favoritesOnly ? [] : [null];

  function position(record) {
    let lo = 0;
    let hi = ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(ordered[mid], record) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function removeTiles(record) {
    for (const { node } of record.tiles.values()) {
      releaseTile(node);
      container.removeChild(node);
    }
  }

  function updateTiles(record, entry, urls) {
    const next = new Map();
    for (const url of urls) {
      const signature = tileSignature(entry, url);
      const cached = record.tiles.get(url);
      next.set(url, cached?.signature === signature ? cached : {
        signature, node: renderTile(entry, url),
      });
    }
    // 古いカードを先に取り除く。古い位置を目印に後続カードを移動させない。
    for (const [url, { node }] of record.tiles) {
      if (next.get(url)?.node === node) continue;
      releaseTile(node);
      container.removeChild(node);
    }
    record.tiles = next;
  }

  function placeTiles(record, anchor) {
    for (const { node } of Array.from(record.tiles.values()).reverse()) {
      if (node.parentNode !== container || node.nextSibling !== anchor) container.insertBefore(node, anchor);
      anchor = node;
    }
  }

  function renderAll(entries, favoritesOnly) {
    const next = new Map();
    const updates = new Map();
    sequence = 0;
    entryOrders = new Map();
    for (const entry of entries.values()) {
      const order = sequence++;
      entryOrders.set(entry.id, order);
      const urls = urlsOf(entry, favoritesOnly);
      if (!urls.length) continue;
      const record = records.get(entry.id) || { id: entry.id, tiles: new Map() };
      record.time = timeOf(entry);
      record.order = order;
      next.set(entry.id, record);
      updates.set(record, { entry, urls });
    }
    for (const [id, record] of records) if (!next.has(id)) removeTiles(record);
    records = next;
    ordered = Array.from(records.values()).sort(compare);
    for (const record of ordered) {
      const { entry, urls } = updates.get(record);
      updateTiles(record, entry, urls);
    }
    let cursor = container.firstChild;
    for (const record of ordered) {
      for (const { node } of record.tiles.values()) {
        if (node === cursor) cursor = cursor.nextSibling;
        else container.insertBefore(node, cursor);
      }
    }
  }

  return {
    render(entries, changedIds, favoritesOnly = false) {
      visibleImages = null;
      // 初回接続・再同期・フィルター切り替えだけ全件を照合する。
      if (!changedIds) { renderAll(entries, favoritesOnly); return; }
      for (const id of changedIds) {
        const entry = entries.get(id);
        if (!entry) entryOrders.delete(id);
        else if (!entryOrders.has(id)) entryOrders.set(id, sequence++);
        const urls = entry ? urlsOf(entry, favoritesOnly) : [];
        let record = records.get(id);
        if (!urls.length) {
          if (record) {
            removeTiles(record);
            ordered.splice(position(record), 1);
            records.delete(id);
          }
          continue;
        }
        let index;
        const time = timeOf(entry);
        if (!record) {
          record = { id, time, order: entryOrders.get(id), tiles: new Map() };
          records.set(id, record);
          index = position(record);
          ordered.splice(index, 0, record);
        } else {
          index = position(record);
          if (record.time !== time) {
            ordered.splice(index, 1);
            record.time = time;
            index = position(record);
            ordered.splice(index, 0, record);
          }
        }
        const anchor = ordered[index + 1] ? firstNode(ordered[index + 1]) : null;
        updateTiles(record, entry, urls);
        placeTiles(record, anchor);
      }
    },
    // スワイプ用の全画像一覧はライトボックスを開く時だけ作る。
    getVisibleImages() {
      if (!visibleImages) visibleImages = ordered.flatMap(record => Array.from(record.tiles.keys()).filter(url => url !== null));
      return visibleImages;
    },
  };
}

// 生成開始時などに連続するSSE通知を、次の描画フレームで一度だけ反映する。
export function createHistoryRenderScheduler(render, schedule = callback => requestAnimationFrame(callback)) {
  const pendingIds = new Set();
  let fullRender = false;
  let scheduled = false;
  return changedIds => {
    if (!changedIds) fullRender = true;
    else for (const id of changedIds) pendingIds.add(id);
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      const ids = fullRender ? undefined : new Set(pendingIds);
      pendingIds.clear();
      fullRender = scheduled = false;
      render(ids);
    });
  };
}
