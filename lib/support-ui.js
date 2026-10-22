import { SUPPORT_CONFIG, validatedLink, validatedFeedbackRecipient } from './support-config.js';
import { consumeSupportOpportunity } from './support-preferences.js';
import { eligibleExport } from './export-outcome.js';
import { recordEvent, operationId } from './analytics.js';
import { VERSION } from '../version.js';

const PROMPT_VERSION = 1;
// Chinese copy approved on 2026-10-05; English candidate shares this logic.
const copy = (zh, en) => globalThis.XKeepsI18n?.language === 'en' ? en : zh;
const element = (tag, text, className = '') => { const e = document.createElement(tag); e.textContent = text; e.className = className; return e; };
function visible(anchor) { return document.visibilityState === 'visible' && anchor?.isConnected && anchor.getClientRects().length > 0; }
function makeLink(target, label, placement, status, operation) {
  const url = validatedLink(SUPPORT_CONFIG, target); if (!url) return null;
  const link = element('a', label, 'xk-external-link'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
  let opening = false;
  link.addEventListener('click', async event => {
    event.preventDefault(); if (event.detail > 1 || opening || !validatedLink(SUPPORT_CONFIG, target)) return;
    opening = true;
    const id = operation || operationId();
    const creator = ['website', 'github', 'x'].includes(target);
    recordEvent(creator ? 'creator_link_clicked' : `${target}_link_clicked`, { placement, ...(creator ? { channel: target } : {}) }, id);
    if (target === 'support' && placement === 'settings') await consumeSupportOpportunity('manual_support').catch(() => {});
    try { await chrome.tabs.create({ url, active: true }); status.textContent = ''; }
    catch { status.textContent = copy('暂时无法打开，请稍后重试。', 'Could not open the page. Try again later.');
      recordEvent('external_link_open_failed', { target: creator ? 'creator' : target, error_class: 'unknown' }, id); }
    finally { opening = false; }
  });
  return link;
}
export async function offerSupport(outcome, anchor) {
  // A failed optional module cannot turn a completed save into an export error.
  try {
    if (!eligibleExport(outcome) || !visible(anchor) || !validatedLink(SUPPORT_CONFIG, 'support')) return false;
    if (!await consumeSupportOpportunity('automatic_prompt') || !visible(anchor)) return false;
    const card = element('section', '', 'xk-support-prompt'); card.setAttribute('aria-label', copy('自愿支持开发', 'Optional developer support'));
    const status = element('p', '', 'help'); status.setAttribute('role', 'status');
    const actions = element('div', '', 'button-row');
    const link = makeLink('support', copy('支持开发', 'Support development'), 'success_card', status, outcome.operationId);
    const dismiss = element('button', copy('关闭', 'Dismiss'), 'secondary'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', copy('关闭支持提示', 'Dismiss support invitation'));
    dismiss.addEventListener('click', () => { card.remove(); recordEvent('support_prompt_dismissed', { prompt_version: PROMPT_VERSION }, outcome.operationId); });
    actions.append(link, dismiss);
    const title = element('h3'); const description = element('p'); const help = element('p', '', 'help');
    function localize() {
      card.setAttribute('aria-label', copy('自愿支持开发', 'Optional developer support'));
      title.textContent = copy('文件已保存到本地', 'Files saved to your device');
      description.textContent = copy('如果 Xkeeps 帮您省下了时间，欢迎请开发者喝杯咖啡，支持持续维护。', 'If Xkeeps saved you time, you can buy the developer a coffee to support ongoing maintenance.');
      help.textContent = copy('是否支持，都不影响免费使用。支持链接将在 Ko-fi 打开。', 'Supporting is optional. Xkeeps remains free to use. The link opens Ko-fi.');
      link.textContent = copy('支持开发', 'Support development');
      dismiss.textContent = copy('关闭', 'Dismiss');
      dismiss.setAttribute('aria-label', copy('关闭支持提示', 'Dismiss support invitation'));
    }
    localize();
    window.addEventListener('xkeeps:language-changed', localize);
    dismiss.addEventListener('click', () => window.removeEventListener('xkeeps:language-changed', localize));
    card.append(title, description, help, actions, status);
    anchor.after(card);
    if (!visible(card)) { card.remove(); return false; }
    recordEvent('support_prompt_shown', { entry: outcome.entry, prompt_version: PROMPT_VERSION }, outcome.operationId);
    return true;
  } catch { return false; }
}
export function feedbackTemplate() {
  return copy(`Xkeeps 版本：${VERSION}\n问题或建议：\n复现步骤：\n预期结果：\n实际结果：\n\n请勿粘贴 Cookie、账号凭据或私人存档。`,
    `Xkeeps version: ${VERSION}\nIssue or suggestion:\nSteps to reproduce:\nExpected result:\nActual result:\n\nDo not paste cookies, credentials or private archives.`);
}
export function feedbackEmail(config = SUPPORT_CONFIG) {
  const recipient = validatedFeedbackRecipient(config);
  if (!recipient) return null;
  const subject = copy(`Xkeeps v${VERSION} 问题反馈`, `Xkeeps v${VERSION} feedback`);
  // Only the fixed template and version enter a draft; no account, archive or diagnostics.
  const body = feedbackTemplate().replace(/\r?\n/g, '\r\n');
  return { recipient, subject, body, uri: `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` };
}
function feedbackEmailText(draft) {
  return copy(`收件人：${draft.recipient}\n主题：${draft.subject}\n\n${draft.body}`, `To: ${draft.recipient}\nSubject: ${draft.subject}\n\n${draft.body}`);
}
function makeFeedbackEmailLink(placement) {
  const draft = feedbackEmail();
  if (!draft) return null;
  const link = element('a', copy('邮件反馈 ↗', 'Email feedback ↗'), 'xk-external-link');
  link.href = draft.uri; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
  link.addEventListener('click', event => {
    if (event.detail > 1 || !feedbackEmail()) { event.preventDefault(); return; }
    // Native mailto in a separate context preserves the product page and its state.
    // Do not expand recovery UI or claim a client opened: Chrome owns that handoff.
    recordEvent('feedback_link_clicked', { placement });
  });
  return link;
}
// Menu actions share the same hit area and icon column; no extra network assets.
const menuIcons = {
  feedback: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2V11.5a9 9 0 0 1 18 0Z"/><path d="M7 9h8M7 13h5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  website: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  github: '<path d="M9 20c-4 1-4-2-6-2M15 22v-4a4 4 0 0 0-1-3c4-.4 7-2 7-6a5 5 0 0 0-1.5-3.5 5 5 0 0 0-.1-3.5s-1.5-.5-4.4 1a15 15 0 0 0-7 0C5.1 1.5 3.6 2 3.6 2a5 5 0 0 0-.1 3.5A5 5 0 0 0 2 9c0 4 3 5.6 7 6a4 4 0 0 0-1 3v4"/>',
  x: '<path fill="currentColor" stroke="none" d="M18.244 2.25h3.308l-7.227 8.26L22.827 21.75H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L.827 2.25H7.65l4.713 6.231zm-1.161 17.52h1.833L6.655 4.126H4.688z"/>',
  external: '<path d="M8 5h11v11M19 5 5 19"/>',
};
function menuAction(action, icon, external = false) {
  const label = element('span', action.textContent.replace(/ ↗$/, ''), 'xk-menu-label');
  const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  glyph.setAttribute('viewBox', '0 0 24 24'); glyph.setAttribute('aria-hidden', 'true');
  glyph.innerHTML = menuIcons[icon];
  action.replaceChildren(glyph, label); action.classList.add('xk-menu-action');
  if (external) {
    const arrow = glyph.cloneNode(false); arrow.classList.add('xk-menu-external');
    arrow.innerHTML = menuIcons.external; action.append(arrow);
  }
}
export function mountSupportSettings(about, { sections = 'all', placement = 'settings', presentation = 'section' } = {}) {
  const root = element('div', '', `xk-support-settings${presentation === 'menu' ? ' xk-support-menu' : ''}`);
  function render() {
    root.replaceChildren();
    const status = element('p', '', 'help'); status.setAttribute('role', 'status');
    let fallback;
    if (sections === 'all' || sections === 'support') {
      const links = element('div', '', 'button-row xk-official-links');
      for (const [target, label] of [['productSite', copy('产品官网 ↗', 'Xkeeps website ↗')], ['privacy', copy('隐私说明 ↗', 'Privacy policy ↗')]]) {
        const url = validatedLink(SUPPORT_CONFIG, target);
        if (!url) continue;
        const link = element('a', label, 'xk-external-link');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
        links.append(link);
      }
      if (links.childElementCount) root.append(links);
    }
    if (sections === 'all' || sections === 'support') for (const [target, title, label] of [['support','支持开发','支持开发 ↗'],['review','评价 Xkeeps','评价 Xkeeps ↗']]) {
      if (!validatedLink(SUPPORT_CONFIG, target)) continue;
      const section = element('section', '', 'xk-support-row'); section.append(element('h3', copy(title, target === 'support' ? 'Support development' : 'Review Xkeeps')), makeLink(target, copy(label, target === 'support' ? 'Support development ↗' : 'Review Xkeeps ↗'), 'settings', status)); root.append(section);
    }
    if (sections === 'all' || sections === 'feedback') {
      const feedback = element('section', '', 'xk-support-row'); feedback.append(element('h3', copy('问题反馈', 'Feedback')));
      fallback = element('details', '', 'xk-feedback-fallback');
      const draft = feedbackEmail();
      const recovery = element('summary', draft ? copy('打开失败', 'Email did not open?') : copy('联系遇到问题？', 'Need help contacting?'));
      fallback.append(recovery);
      const contact = makeFeedbackEmailLink(placement) || makeLink('feedback', copy('联系作者 ↗', 'Contact the author ↗'), placement, status);
      if (contact) { if (presentation === 'menu') menuAction(contact, draft ? 'mail' : 'feedback', true); feedback.append(contact); }
      const button = element('button', draft ? copy('复制邮件', 'Copy email') : copy('复制反馈内容', 'Copy feedback'), 'secondary'); button.type = 'button';
      if (presentation === 'menu') menuAction(button, 'copy');
      const textarea = document.createElement('textarea'); textarea.className = 'xk-feedback-template'; textarea.readOnly = true; textarea.hidden = true;
      textarea.setAttribute('aria-label', copy('反馈内容（尚未发送）', 'Feedback contents (not sent)'));
      button.addEventListener('click', async () => {
        const currentDraft = feedbackEmail();
        const text = currentDraft ? feedbackEmailText(currentDraft) : feedbackTemplate();
        try { await navigator.clipboard.writeText(text); textarea.hidden = true; status.textContent = copy('反馈内容已复制，尚未发送。请补充内容后通过作者官网联系。', 'Feedback copied, not sent. Add your details and contact the author through the website.'); recordEvent('feedback_template_copied', { placement }); }
        catch { textarea.value = text; textarea.hidden = false; status.textContent = copy('复制失败，请手动复制反馈内容，尚未发送。', 'Copy failed. Copy the feedback manually; it has not been sent.'); }
      });
      fallback.open = !draft;
      fallback.append(button, textarea); root.append(feedback);
    }
    if (sections === 'all' || sections === 'author') {
      const author = element('section', '', 'xk-support-row xk-author-row'); author.append(element('h3', copy('关于作者', 'About the author')));
      const links = element('div', '', 'xk-author-links');
      for (const [target, label] of [['website',copy('作者网站 ↗','Website ↗')],['github',copy('公开项目 ↗','GitHub · Public projects ↗')],['x',copy('作者动态 ↗','Author on X ↗')]]) {
        const link = makeLink(target, label, placement, status); if (link) { if (presentation === 'menu') menuAction(link, target, true); links.append(link); }
      }
      author.append(links); root.append(author);
    }
    if (fallback) root.append(fallback);
    root.hidden = root.childElementCount === 0;
    if (!root.hidden) root.append(status);
  }
  about.append(root); render(); window.addEventListener('xkeeps:language-changed', render);
}
