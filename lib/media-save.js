import { MAX_ZIP_BYTES } from './media-backup.js';
export const SIMPLE_ZIP_BYTES = 50 * 1024 * 1024;
// Choose file saving before requesting access to an entire directory.
export function mediaSaveMode(bytes, { filePicker = false, folderPicker = false } = {}) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unavailable';
  if (bytes <= SIMPLE_ZIP_BYTES) return 'download';
  if (filePicker && bytes < MAX_ZIP_BYTES) return 'file';
  return folderPicker ? 'directory' : 'unavailable';
}
