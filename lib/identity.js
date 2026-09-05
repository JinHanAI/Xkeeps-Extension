/** Read the actual X session cookie; stored DOM labels can lag an account switch. */
export async function getSessionUserId() {
  const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'twid' });
  try { return decodeURIComponent(cookie?.value || '').replaceAll('"', '').match(/^u=(\d+)$/)?.[1] || null; }
  catch { return null; }
}

/** Serialize read/merge/write updates from capture and query discovery. */
export async function updateCredentials(userId, patch) {
  if (!userId) return;
  return navigator.locks.request('xarchive-credentials', async () => {
    const key = `xarchive_creds_${userId}`;
    const existing = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: { ...existing[key], ...patch } });
  });
}
