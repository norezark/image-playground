// api.js – サーバーへの API リクエスト

export async function postJSON(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deleteEntry(id) {
  try { await postJSON('/delete', { id }); }
  catch (err) { console.error('削除失敗', err); }
}

export async function cancelEntry(id) {
  try { await postJSON('/cancel', { id }); }
  catch (err) { console.error('キャンセル失敗', err); }
}
