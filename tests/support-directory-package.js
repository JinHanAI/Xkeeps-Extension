// TEST ONLY: use the production writer with a 160 kB part limit.
import { writeMediaPackages as original } from '/lib/media-package.js?original=directory-test';
export { planMediaPackages } from '/lib/media-package.js?original=directory-test';
export function writeMediaPackages(options) { return original({ ...options, maxBytes:160000 }); }
