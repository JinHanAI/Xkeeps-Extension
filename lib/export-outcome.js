// Ephemeral receipts only. Never stored in support preferences or analytics.
export function confirmedReceipt(receipt) {
  return receipt?.state === 'complete' && (receipt.method === 'filesystem' ? receipt.closed === true
    : Number.isInteger(receipt.downloadId) && receipt.downloadId >= 0);
}
export function fileReceipt() { return { state: 'complete', method: 'filesystem', closed: true }; }
export class ExportBatch {
  constructor({ operationId, entry, itemCount, origin = 'user', purpose = 'archive_export' }) {
    this.outcome = { operationId, entry, itemCount, origin, purpose, terminal: false, selectionStable: true,
      result: 'pending', requiredArtifacts: [], savedArtifacts: [], media: { selected: false, complete: 0, failed: 0, partial: 0, rejected: 0, pending: 0 } };
  }
  require(id) { if (this.outcome.terminal) throw new Error('Export already sealed'); if (!this.outcome.requiredArtifacts.includes(id)) this.outcome.requiredArtifacts.push(id); }
  saved(id, receipt) { this.require(id); if (confirmedReceipt(receipt) && !this.outcome.savedArtifacts.includes(id)) this.outcome.savedArtifacts.push(id); }
  media(result) {
    const counts = result?.counts || {};
    this.outcome.media = { selected: true, complete: counts.complete || 0, failed: counts.failed || 0,
      partial: counts.partial || 0, rejected: result?.inventory?.rejected?.length || 0,
      pending: (counts.cancelled || 0) + (result?.inventory?.items || []).filter(item => item.status === 'pending').length };
    if (result?.status !== 'complete') this.outcome.result = result?.cancelled ? 'cancelled' : 'partial';
  }
  include(prefix, child) {
    if (!child?.terminal) { this.outcome.result = 'error'; return; }
    for (const id of child.requiredArtifacts) this.require(`${prefix}:${id}`);
    for (const id of child.savedArtifacts) if (!this.outcome.savedArtifacts.includes(`${prefix}:${id}`)) this.outcome.savedArtifacts.push(`${prefix}:${id}`);
    if (child.media.selected) this.outcome.media = { ...child.media };
    if (child.result !== 'complete') this.outcome.result = child.result;
    if (!child.selectionStable) this.outcome.selectionStable = false;
  }
  finish(result = null) {
    if (this.outcome.terminal) return structuredClone(this.outcome);
    this.outcome.terminal = true;
    if (result) this.outcome.result = result;
    else if (this.outcome.result === 'pending') this.outcome.result = this.outcome.requiredArtifacts.length
      && this.outcome.requiredArtifacts.every(id => this.outcome.savedArtifacts.includes(id)) ? 'complete' : 'requested';
    return structuredClone(this.outcome);
  }
}
export function eligibleExport(outcome) {
  const m = outcome?.media;
  return Boolean(outcome?.origin === 'user' && outcome.purpose === 'archive_export' && ['home', 'browse', 'media'].includes(outcome.entry)
    && Number.isSafeInteger(outcome.itemCount) && outcome.itemCount > 0 && outcome.terminal === true
    && outcome.result === 'complete' && outcome.selectionStable === true
    && Array.isArray(outcome.requiredArtifacts) && outcome.requiredArtifacts.length > 0
    && new Set(outcome.requiredArtifacts).size === outcome.requiredArtifacts.length
    && Array.isArray(outcome.savedArtifacts) && outcome.requiredArtifacts.every(id => outcome.savedArtifacts.includes(id))
    && m && typeof m.selected === 'boolean' && ['complete', 'failed', 'partial', 'rejected', 'pending'].every(key => Number.isSafeInteger(m[key]) && m[key] >= 0)
    && (!m.selected || !m.failed && !m.partial && !m.rejected && !m.pending));
}
