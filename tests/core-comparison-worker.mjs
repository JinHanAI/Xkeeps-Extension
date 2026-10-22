// Read-only worker for T28: run this file against baseline and candidate roots,
// then compare its deterministic JSON output. No Chrome APIs or CDN requests.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]);
const load=name=>import(pathToFileURL(join(root,'lib',name+'.js')));
await load('archive');
const likes=await load('likes-archive'),time=await load('time-range'),formats=await load('export-formats');
const media=await load('media-backup'),packages=await load('media-package'),browse=await load('browse-archive');
const raw=JSON.parse(readFileSync(process.argv[3],'utf8'));
const input=structuredClone(raw);
input.export_metadata.collection={bookmarks:'complete',folders:'complete',mode:'full',reason:'complete'};
input.bookmarks[1].created_at='2026-01-01T00:00:00Z';
const newer=structuredClone(input);newer.export_metadata.exported_at='2026-10-05T04:00:00Z';
newer.export_metadata.collection={bookmarks:'partial',folders:'unknown',mode:'quick',reason:'quick_boundary'};
newer.bookmarks=[{...newer.bookmarks[0],full_text:'更新正文 ✨✅'}, {...newer.bookmarks[0],tweet_id:'1011',full_text:'新增正文 中文✨'}];
const merged=globalThis.XArchive.merge(input,newer);
const oldLikes=likes.likesDocument({userId:'42',likes:input.bookmarks,mode:'full',coverage:'complete',reason:'complete',exportedAt:input.export_metadata.exported_at});
const newLikes=likes.likesDocument({userId:'42',likes:newer.bookmarks,mode:'quick',coverage:'partial',reason:'quick_boundary',exportedAt:newer.export_metadata.exported_at});
const mergedLikes=likes.mergeLikes(oldLikes,newLikes);
const at='2026-10-05T04:00:00Z';const now=Date.parse(at);
const output={merged,mergedLikes,filtered:{},formats:{csv:formats.buildCsv(merged.data,{exportedAt:at}),markdown:formats.buildMarkdown(merged.data,{exportedAt:at}),likesCsv:formats.buildLikesCsv(mergedLikes.data,{exportedAt:at}),likesMarkdown:formats.buildLikesMarkdown(mergedLikes.data)},selected:browse.selectedDocument(merged.data,['1009'])};
for(const period of ['all','year','half','month','week','custom'])output.filtered[period]=time.filterPosts(merged.data,period,{now,from:'2026-10-01',to:'2026-10-05'});
const png=Buffer.from('89504e470d0a1a0a0000000d494844520000000000000000','hex');
const mp4=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
const inventory=media.buildMediaInventory(merged.data,{photos:true,avatars:true,videos:true,thumbnails:true});
const chunks=[];
output.package=await packages.writeMediaPackages({document:merged.data,inventory,maxBytes:1024*1024,
 openPart:async()=>({async write(bytes){chunks.push(Buffer.from(bytes));},async close(){},async abort(){}}),
 fetchImpl:async url=>{const bytes=url.includes('.mp4')?mp4:png;const r=new Response(bytes,{headers:{'content-type':url.includes('.mp4')?'video/mp4':'image/png','content-length':String(bytes.length)}});Object.defineProperty(r,'url',{value:url});return r;}});
const temporary=mkdtempSync(join(tmpdir(),'xkeeps-core-proof-'));
try {
 const zip=join(temporary,'export.zip');writeFileSync(zip,Buffer.concat(chunks));
 const crc=spawnSync('unzip',['-t',zip],{encoding:'utf8'});assert.equal(crc.status,0,crc.stdout+crc.stderr);
 const decoded=spawnSync('python3',['-c','import zipfile,sys,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({"hashes":{name:hashlib.sha256(z.read(name)).hexdigest() for name in sorted(z.namelist())},"html":z.read(next(n for n in z.namelist() if n.endswith(".html"))).decode()}))',zip],{encoding:'utf8'});assert.equal(decoded.status,0,decoded.stderr);
 const proof=JSON.parse(decoded.stdout);output.zipContentHashes=proof.hashes;
 const html=proof.html;
 assert.doesNotMatch(html,/src="https?:|xk-support-prompt|ko-fi/);
 assert.match(html,/示例作者/);assert.match(html,/更新正文/);assert.match(html,/<video/);
 output.offlineChecks={localMedia:true,author:true,text:true,video:true,noMarketing:true,crc:true};
} finally {rmSync(temporary,{recursive:true,force:true});}
process.stdout.write(JSON.stringify(output,null,2)+'\n');
