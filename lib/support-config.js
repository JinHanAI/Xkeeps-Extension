// Evidence dates identify configuration verification, not payment acceptance.
export const APPROVED_LINKS = Object.freeze({ support: null, review: null, repository: null,
  productSite: 'https://xkeeps.jinhanai.com/', privacy: 'https://xkeeps.jinhanai.com/privacy.html',
  feedback: 'https://jinhanai.com/#email-link', website: 'https://jinhanai.com/', github: 'https://github.com/JinHanAI', x: 'https://x.com/AIJinHan' });
// Public releases link to the verified author website; no personal email is embedded.
export const APPROVED_FEEDBACK_EMAIL = Object.freeze([]);
const disabled = () => ({ enabled: false, url: null, verifiedAt: null });
const verified = url => ({ enabled: true, url, verifiedAt: '2026-10-04' });
export const SUPPORT_CONFIG = { support: { ...disabled(), receivingVerified: false }, review: disabled(),
  repository: disabled(), productSite: { ...verified(APPROVED_LINKS.productSite), verifiedAt: '2026-10-06' },
  privacy: { ...verified(APPROVED_LINKS.privacy), verifiedAt: '2026-10-06' }, feedback: verified(APPROVED_LINKS.feedback),
  feedbackEmail: { enabled: false, addressParts: [], verifiedAt: null },
  author: { name: 'JinHanAI', website: verified(APPROVED_LINKS.website), github: verified(APPROVED_LINKS.github), x: verified(APPROVED_LINKS.x) } };
export function validatedLink(config, target, approved = APPROVED_LINKS) {
  try {
    const link = ['website', 'github', 'x'].includes(target) ? config.author?.[target] : config[target];
    if (!link?.enabled || typeof link.url !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(link.verifiedAt || '') || !approved[target]) return null;
    const url = new URL(link.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.href !== approved[target] || link.url !== url.href) return null;
    if (target === 'support' && (url.hostname !== 'ko-fi.com' || !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname) || ['account','login','dashboard','manage'].includes(url.pathname.slice(1).toLowerCase()) || link.receivingVerified !== true)) return null;
    if (target === 'review' && (url.hostname !== 'chromewebstore.google.com' || !/^\/detail\/[^/]+\/[a-p]{32}(?:\/reviews)?$/.test(url.pathname))) return null;
    return url.href;
  } catch { return null; }
}

export function validatedFeedbackRecipient(config = SUPPORT_CONFIG) {
  if (APPROVED_FEEDBACK_EMAIL.length !== 2) return null;
  const email = config?.feedbackEmail;
  if (!email?.enabled || !/^\d{4}-\d{2}-\d{2}$/.test(email.verifiedAt || '') || !Array.isArray(email.addressParts) || email.addressParts.length !== 2) return null;
  if (!email.addressParts.every((part, index) => part === APPROVED_FEEDBACK_EMAIL[index])) return null;
  return email.addressParts.join('@');
}
