const KEY = 'support-invitation';
export const PREFERENCE_DB = 'xkeeps-preferences-v1';
export function openPreferences() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PREFERENCE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('preferences', { keyPath: 'key' });
    let blocked = false;
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('Preference database unavailable')); };
  });
}
export async function consumeSupportOpportunity(reason, open = openPreferences) {
  if (!['automatic_prompt', 'manual_support'].includes(reason)) return false;
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('preferences', 'readwrite'); let won = false;
      const store = tx.objectStore('preferences'); const request = store.get(KEY);
      request.onsuccess = () => {
        const previous = request.result;
        // An unknown existing record is never treated as a fresh opportunity.
        if (previous) return;
        store.put({ key: KEY, schemaVersion: 1, status: 'consumed', reason, consumedAt: new Date().toISOString() }); won = true;
      };
      tx.oncomplete = () => resolve(won);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Preference transaction failed'));
    });
  } finally { db.close(); }
}
