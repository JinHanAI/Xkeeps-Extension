// TEST ONLY: force the real directory coordinator without gigabyte downloads.
export { SIMPLE_ZIP_BYTES } from '/lib/media-save.js?original=directory-test';
export function mediaSaveMode() { return 'directory'; }
