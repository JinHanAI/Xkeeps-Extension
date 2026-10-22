import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportBatch, eligibleExport, confirmedReceipt, fileReceipt } from '../lib/export-outcome.js';
import { SUPPORT_CONFIG, APPROVED_LINKS, validatedLink, validatedFeedbackRecipient } from '../lib/support-config.js';
import { feedbackEmail } from '../lib/support-ui.js';
import { VERSION } from '../version.js';
import { buildEvent, summarizeEvents } from '../lib/analytics.js';
const receipt = { state:'complete', downloadId:7 };
const batch = (extra={}) => new ExportBatch({operationId:crypto.randomUUID(),entry:'home',itemCount:2,...extra});
const complete = extra => { const b=batch(extra); b.require('json'); b.saved('json',receipt); return b.finish(); };

test('T01/02/11: positive manual saves with incomplete collection coverage are eligible', () => {
  for (const entry of ['home','browse','media']) assert.equal(eligibleExport(complete({entry})),true);
  const outcome=complete(); outcome.collection={bookmarks:'partial'};
  assert.equal(eligibleExport(outcome),true);
});
test('T03: one batch is eligible only after every selected format saves and seals', () => {
  const b=batch(); for (const id of ['json','csv','md']) b.require(id);
  b.saved('json',receipt); b.saved('csv',receipt);
  assert.equal(eligibleExport(b.outcome),false);
  b.saved('md',receipt); assert.equal(eligibleExport(b.outcome),false);
  assert.equal(eligibleExport(b.finish()),true);
  assert.throws(()=>b.require('late'));
});
test('T04/08: interrupted, cancelled or late failing formats do not lose prior files or qualify', () => {
  for (const result of ['cancelled','error','partial','requested']) {
    const b=batch(); b.saved('json',receipt); b.require('md');
    const out=b.finish(result); assert.equal(eligibleExport(out),false); assert.deepEqual(out.savedArtifacts,['json']);
  }
});
test('T05/06: dynamic split parts, large media, reader and manifest all need closed receipts', () => {
  for (const missing of ['part-002.zip','large/video.mp4','reader.html','media-manifest.json']) {
    const b=batch(); for (const id of ['part-001.zip','part-002.zip','large/video.mp4','reader.html','media-manifest.json']) {
      b.require(id); if(id!==missing) b.saved(id,fileReceipt());
    }
    b.media({status:'complete',counts:{complete:3},inventory:{items:[],rejected:[]}});
    assert.equal(eligibleExport(b.finish()),false);
  }
});
test('T07: saved media with failed, partial, rejected or pending outcomes never qualifies', () => {
  for(const mutation of [{status:'partial'},{counts:{failed:1}},{counts:{partial:1}},{counts:{cancelled:1}},{inventory:{rejected:[{}]}},{inventory:{items:[{status:'pending'}]}}]) {
    const b=batch(); b.saved('media.zip',receipt); b.media({status:'complete',counts:{complete:3},inventory:{items:[],rejected:[]},...mutation});
    assert.equal(eligibleExport(b.finish()),false);
  }
});
test('T09: created, requested, wrong IDs and unclosed streams are not receipts', () => {
  for(const value of [undefined,{}, {state:'requested',downloadId:1}, {state:'complete'}, {state:'complete',downloadId:-1}, {state:'complete',downloadId:'7'}, {state:'complete',method:'filesystem',closed:false}]) assert.equal(confirmedReceipt(value),false);
  assert.equal(confirmedReceipt(fileReceipt()),true);
});
test('T10/13/14: empty, scheduled, diagnostics, unsealed and unstable selections are ineligible', () => {
  for(const props of [{itemCount:0},{origin:'scheduled'},{purpose:'diagnostics'},{entry:'settings'}]) assert.equal(eligibleExport(complete(props)),false);
  for(const props of [{terminal:false},{selectionStable:false},{requiredArtifacts:[]},{media:null}]) assert.equal(eligibleExport({...complete(),...props}),false);
});
test('T03/05: child receipts coordinate across formats and media without early success', () => {
  const parent=batch(); const m=batch({entry:'media'}); m.saved('part-1.zip',fileReceipt()); m.media({status:'complete',counts:{complete:1}});
  parent.include('media',m.finish()); parent.include('json',complete());
  assert.equal(eligibleExport(parent.outcome),false); assert.equal(eligibleExport(parent.finish()),true);
  const bad=batch(); bad.include('json',complete()); const failed=batch(); failed.require('md'); bad.include('md',failed.finish('cancelled'));
  assert.equal(eligibleExport(bad.finish()),false);
});
test('T20/24/25: verified official pages open independently; support, store and private repository stay closed', () => {
  for(const key of ['support','review','repository']) assert.equal(validatedLink(SUPPORT_CONFIG,key),null);
  for(const key of ['productSite','privacy','website','github','x','feedback']) assert.equal(validatedLink(SUPPORT_CONFIG,key),APPROVED_LINKS[key]);
});
test('T22: injection, credentials, spoofed domains, parameters, normalized URLs are rejected', () => {
  for(const url of ['http://jinhanai.com/','javascript:alert(1)','data:text/html,hello','https://jinhanai.com.evil.test/','https://user:pass@jinhanai.com/','https://jinhanai.com/?account=private','https://jinhanai.com:444/','https://JINHANAI.com/']) {
    const config=structuredClone(SUPPORT_CONFIG); config.author.website.url=url;
    assert.equal(validatedLink(config,'website'),null,url);
  }
});
test('T21/23/24: payment readiness and exact approved public endpoint are required even in isolated fixture', () => {
  const url='https://ko-fi.com/test_fixture'; const config={support:{enabled:true,url,verifiedAt:'2026-10-04',receivingVerified:true},review:{enabled:true,url:'https://chromewebstore.google.com/detail/test/'+ 'a'.repeat(32)+'/reviews',verifiedAt:'2026-10-04'}};
  const approved={support:url,review:config.review.url};
  assert.equal(validatedLink(config,'support',approved),url); assert.equal(validatedLink(config,'review',approved),config.review.url);
  config.support.receivingVerified=false; assert.equal(validatedLink(config,'support',approved),null);
  for(const path of ['login','dashboard','manage','account']) { config.support={...config.support,receivingVerified:true,url:'https://ko-fi.com/'+path}; assert.equal(validatedLink(config,'support',{support:config.support.url}),null); }
});
test('T26: all support events reject private fields and cannot represent payment or successful reviews', () => {
  const names={support_prompt_shown:{entry:'home',prompt_version:1},support_prompt_dismissed:{prompt_version:1},support_link_clicked:{placement:'settings'},review_link_clicked:{placement:'settings'},feedback_link_clicked:{placement:'settings'},feedback_template_copied:{placement:'settings'},creator_link_clicked:{placement:'settings',channel:'github'},external_link_open_failed:{target:'support',error_class:'unknown'}};
  for(const [name,fields] of Object.entries(names)) {
    assert.equal(buildEvent(name,fields).event_name,name);
    for(const key of ['account','url','filename','path','text','payment','amount','review_result']) assert.throws(()=>buildEvent(name,{...fields,[key]:'private'}),/Disallowed/);
  }
  const summary=summarizeEvents([buildEvent('support_link_clicked',{placement:'settings'}),buildEvent('review_link_clicked',{placement:'settings'})]);
  assert.equal(summary.successful_exports,0); assert.equal(summary.counts.support_link_clicked,1);
});

// Navigation placement must survive the privacy whitelist after the UI moves.
test('feedback page and sidebar actions keep only approved analytics fields', () => {
  for (const page of ['feedback','author']) {
    assert.equal(buildEvent('page_viewed', {page}).page, page);
    assert.throws(()=>buildEvent('page_viewed',{page,account:'private'}),/Disallowed/);
  }
  assert.throws(()=>buildEvent('page_viewed',{page:'feedback',account:'private'}),/Disallowed/);
  for (const event of ['feedback_link_clicked','feedback_template_copied','creator_link_clicked']) {
    const fields={placement:'sidebar',...(event==='creator_link_clicked'?{channel:'github'}:{})};
    assert.equal(buildEvent(event,fields).placement,'sidebar');
    for(const field of ['url','path','body','account']) assert.throws(()=>buildEvent(event,{...fields,[field]:'private'}),/Disallowed/);
  }
});

test('public feedback uses the verified website and embeds no email recipient', () => {
  assert.equal(feedbackEmail(), null);
  assert.equal(validatedFeedbackRecipient(), null);
  assert.equal(SUPPORT_CONFIG.feedbackEmail.enabled, false);
  assert.deepEqual(SUPPORT_CONFIG.feedbackEmail.addressParts, []);
  assert.equal(validatedLink(SUPPORT_CONFIG, 'feedback'), 'https://jinhanai.com/#email-link');
});
test('unapproved email and header-injection configurations cannot enable direct mail', () => {
  assert.equal(feedbackEmail(null),null);
  for (const addressParts of [null, [], ['demo','example.invalid'], ['demo\r\nBcc:other','example.invalid'], [undefined,undefined]]) {
    const config=structuredClone(SUPPORT_CONFIG);
    config.feedbackEmail={enabled:true,verifiedAt:'2026-10-22',addressParts};
    assert.equal(validatedFeedbackRecipient(config), null);
    assert.equal(feedbackEmail(config),null);
  }
});
test('switching interface language cannot restore a personal email destination', () => {
  globalThis.XKeepsI18n={language:'en'};
  try { assert.equal(feedbackEmail(),null);assert.ok(validatedLink(SUPPORT_CONFIG,'feedback')); }
  finally { delete globalThis.XKeepsI18n; }
});
