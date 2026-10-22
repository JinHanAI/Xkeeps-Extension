// Isolated synthetic endpoints for browser QA. Never packaged or publicly enabled.
import { SUPPORT_CONFIG as production, validatedLink as validate, validatedFeedbackRecipient } from '../lib/support-config.js?production-fixture';
export const SUPPORT_CONFIG=structuredClone(production);
SUPPORT_CONFIG.support={enabled:true,url:'https://ko-fi.com/xkeeps_test_fixture',verifiedAt:'2026-10-04',receivingVerified:true};
SUPPORT_CONFIG.review={enabled:true,url:'https://chromewebstore.google.com/detail/xkeeps-test/'+ 'a'.repeat(32)+'/reviews',verifiedAt:'2026-10-04'};
const approved={support:SUPPORT_CONFIG.support.url,review:SUPPORT_CONFIG.review.url,productSite:production.productSite.url,privacy:production.privacy.url,feedback:production.feedback.url,website:production.author.website.url,github:production.author.github.url,x:production.author.x.url};
export const validatedLink=(config,target)=>validate(config,target,approved);

export { validatedFeedbackRecipient };
