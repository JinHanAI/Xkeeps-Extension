import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMediaInventory } from '../lib/media-backup.js';
import { writeMediaPackages, planMediaPackages } from '../lib/media-package.js';
import { offlineHtml, safeLocalMediaPath } from '../lib/offline-view.js';

const png = size => { const data = Buffer.alloc(size); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(data); return data; };
const document = { source: 'bookmarks', bookmarks: [1,2,3].map(id => ({ tweet_id: String(id),
  full_text: `正文 ${id}`, author: { name: '示例作者', screen_name: 'example' },
  media: [{ type: 'photo', url: `https://pbs.twimg.com/${id}.png` }] })) };
function setup() {
  const inventory = buildMediaInventory(document, { photos: true });
  for (const item of inventory.items) item.expected_bytes = 80000;
  const outputs = new Map();
  const writable = key => { const chunks = []; outputs.set(key, chunks); return {
    async write(bytes) { chunks.push(Buffer.from(bytes)); }, async close() {},
    async abort() { outputs.delete(key); }
  }; };
  const fetchImpl = async url => {
    const response = new Response(png(80000), { headers: { 'content-type': 'image/png', 'content-length': '80000' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  };
  return { inventory, outputs, options: { document, inventory, directoryMode: true, maxBytes: 160000,
    openPart: async index => writable(`part-${index}.zip`), openLarge: async item => writable(`large/${item.path}`), fetchImpl } };
}
function checkZip(outputs, maxBytes) {
  const dir = mkdtempSync(join(tmpdir(), 'xkeeps-parts-'));
  try {
    const contents = new Map();
    for (const [name, chunks] of outputs) {
      if (!name.endsWith('.zip')) continue;
      const data = Buffer.concat(chunks); assert.ok(data.length <= maxBytes, `${name}: ${data.length}`);
      const path = join(dir, name); writeFileSync(path, data);
      const integrity = spawnSync('unzip', ['-t', path], { encoding: 'utf8' });
      assert.equal(integrity.status, 0, integrity.stdout + integrity.stderr);
      const decoded = spawnSync('python3', ['-c', 'import zipfile,json,base64,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({p:base64.b64encode(z.read(p)).decode() for p in z.namelist()}))', path], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      assert.equal(decoded.status, 0, decoded.stderr);
      for (const [file, encoded] of Object.entries(JSON.parse(decoded.stdout))) {
        const bytes=Buffer.from(encoded,'base64'); contents.set(file,bytes);
        if (/\.(?:html|json|md|txt)$/.test(file)) assert.doesNotMatch(bytes.toString(), /xk-support-prompt|support_link_clicked|ko-fi\.com\/xkeeps_test_fixture/, 'offline files must not contain support UI');
      }
    }
    return contents;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('offline reader preserves text and names, escapes evidence, and never embeds remote media', () => {
  const malicious = { likes: [{ tweet_id: '1', full_text: '<script>alert(1)</script>',
    author: { name: '<img src=x onerror=alert(1)>', screen_name: 'someone' },
    media: [{ type: 'photo', url: 'https://evil.example/track' }, { type: 'video' }] }] };
  const html = offlineHtml(malicious, { items: [
    { status: 'complete', path: 'https://evil.example/track', tweet_ids: ['1'], type: 'photo' },
    { status: 'partial', path: 'media/photo/1_12345678.png', tweet_ids: ['1'], type: 'photo' },
    { status: 'complete', path: 'media/avatar/1_12345678.png', tweet_ids: ['1'], type: 'avatar' }
  ] });
  assert.match(html, /&lt;script&gt;alert/); assert.match(html, /@someone/);
  assert.doesNotMatch(html, /<script|onerror="|src="https?:|href="javascript:/);
  assert.match(html, /src="media\/avatar/); assert.match(html, /未包含照片文件/);
  assert.match(html, /未包含可播放的视频文件/);
  for (const path of ['../media/photo/1_12345678.png', 'media/photo/../../file', '//evil.test/x', 'part-001/media/photo/1_12345678.png?x']) assert.equal(safeLocalMediaPath(path), null);
  assert.equal(safeLocalMediaPath('part-001/media/photo/1_12345678.png'), 'part-001/media/photo/1_12345678.png');
});

test('multipart exports preserve every complete file with valid CRC and root-reader paths', async () => {
  const { options, outputs, inventory } = setup();
  assert.ok(planMediaPackages(document, inventory, options.maxBytes).partCount > 1);
  const result = await writeMediaPackages(options);
  assert.equal(result.counts.complete, 3); assert.equal(result.parts.length, 3);
  const files = checkZip(outputs, options.maxBytes);
  for (const item of result.inventory.items) {
    assert.ok(files.has(item.saved_path)); assert.equal(files.get(item.saved_path).length, 80000);
    const prefix = item.saved_path.split('/')[0];
    assert.deepEqual(JSON.parse(files.get(`${prefix}/archive.json`)), document);
    assert.match(files.get(`${prefix}/打开查看.html`).toString(), /src="media\/photo\//);
  }
  const root = offlineHtml(document, result.inventory, { root: true });
  for (const item of result.inventory.items) assert.ok(root.includes(`src="${item.saved_path}"`));
});

test('unknown lengths retry in a fresh part and oversized files stream separately', async () => {
  const { options, outputs } = setup();
  options.inventory.items = options.inventory.items.slice(0, 1);
  let calls = 0;
  options.fetchImpl = async url => {
    calls++; let position = 0; const bytes = png(240000);
    const response = new Response(new ReadableStream({ pull(controller) {
      if (position >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(position, position + 40000)); position += 40000;
    } }), { headers: { 'content-type': 'image/png' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  };
  const result = await writeMediaPackages(options);
  assert.equal(result.counts.complete, 1); assert.equal(calls, 3);
  assert.match(result.inventory.items[0].saved_path, /^large\//);
  assert.equal(Buffer.concat(outputs.get(result.inventory.items[0].saved_path)).length, 240000);
  checkZip(outputs, options.maxBytes);
});

test('known oversized file avoids retry and preserves an independently saved file', async () => {
  const { options, outputs } = setup(); options.inventory.items = options.inventory.items.slice(0, 1);
  options.fetchImpl = async url => {
    const response = new Response(png(240000), { headers: { 'content-type': 'image/png', 'content-length': '240000' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  };
  const result = await writeMediaPackages(options);
  assert.equal(result.parts.length, 1); assert.equal(result.counts.complete, 1);
  assert.equal(Buffer.concat(outputs.get(result.inventory.items[0].saved_path)).length, 240000);
  checkZip(outputs, options.maxBytes);
});

test('CDN failures remain explicit without linking broken files', async () => {
  const { options, outputs } = setup(); const original = options.fetchImpl;
  options.fetchImpl = (url, init) => url.endsWith('/2.png') ? Promise.reject(new Error('network failure')) : original(url, init);
  const result = await writeMediaPackages(options);
  assert.equal(result.status, 'partial'); assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.complete, 2);
  const failed = result.inventory.items.find(item => item.status === 'failed');
  assert.equal(failed.saved_path, undefined);
  assert.ok(!offlineHtml(document, result.inventory).includes(`src="${failed.path}"`));
  const files = checkZip(outputs, options.maxBytes);
  const manifests = [...files].filter(([path]) => path.endsWith('media-manifest.json')).map(([, data]) => JSON.parse(data));
  assert.ok(manifests.some(manifest => manifest.media.some(item => item.status === 'failed' && item.error === 'network failure')));
});

test('cancellation retains complete media, valid ZIPs, and marks remaining items cancelled', async () => {
  const { options, outputs } = setup(); const controller = new AbortController();
  options.signal = controller.signal;
  options.onProgress = ({ index }) => { if (index === 2) controller.abort(); };
  const result = await writeMediaPackages(options);
  assert.equal(result.cancelled, true); assert.equal(result.counts.complete, 1);
  assert.equal(result.counts.cancelled, 2); checkZip(outputs, options.maxBytes);
});

test('filesystem write failures are fatal and cannot be reported as a successful media export', async () => {
  const { options } = setup(); let writes = 0;
  options.openPart = async () => ({ async write() { if (++writes > 3) throw new Error('disk full'); }, async close() {}, async abort() {} });
  await assert.rejects(writeMediaPackages(options), /storage_write_failed/);
});

test('a truncated response never becomes complete and its partial file is not displayed', async () => {
  const { options, outputs } = setup(); options.inventory.items = options.inventory.items.slice(0, 1);
  options.fetchImpl = async url => {
    const response = new Response(png(200), { headers: { 'content-type': 'image/png', 'content-length': '80000' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  };
  const result = await writeMediaPackages(options);
  assert.equal(result.counts.complete, 0); assert.equal(result.counts.failed, 1);
  assert.equal(result.inventory.items[0].error, 'media_body_truncated');
  assert.doesNotMatch(offlineHtml(document, result.inventory), /src="media\/photo/);
  checkZip(outputs, options.maxBytes);
});

test('single downloadable ZIP contains records, local avatars and reader without folder access', async () => {
  const doc = { export_metadata:{screen_name:'example',exported_at:'2026-10-04T15:00:00Z'}, bookmarks:[{tweet_id:'1',full_text:'正文✨',author:{name:'作者',screen_name:'example',profile_image_url:'https://pbs.twimg.com/a.png'}}] };
  const inventory=buildMediaInventory(doc,{avatars:true});const outputs=new Map();const chunks=[];outputs.set('single.zip',chunks);
  const result=await writeMediaPackages({ document:doc,inventory,directoryMode:false,maxBytes:50*1024*1024,
    openPart:async()=>({async write(b){chunks.push(Buffer.from(b));},async close(){},async abort(){chunks.length=0;}}),
    fetchImpl:async url=>{const response=new Response(png(100),{headers:{'content-type':'image/png','content-length':'100'}});Object.defineProperty(response,'url',{value:url});return response;},
    additionalFiles:[{name:'archive.csv',body:'昵称,正文\n作者,正文✨'},{name:'archive.md',body:'# 作者\n正文✨'}] });
  assert.equal(result.status,'complete');assert.equal(result.parts.length,1);
  const content=checkZip(outputs,50*1024*1024);
  assert.deepEqual(JSON.parse(content.get('archive.json').toString()),doc);
  assert.equal(content.get('archive.csv').toString(),'昵称,正文\n作者,正文✨');
  assert.equal(content.get('archive.md').toString(),'# 作者\n正文✨');
  assert.equal([...content.keys()].filter(k=>k.startsWith('media/avatar/')).length,1);
  assert.match(content.get('打开查看.html').toString(), /media\/avatar\/1_/);
  assert.doesNotMatch(content.get('打开查看.html').toString(), /src="https?:/);
});

test('additional selected formats are within ZIP budget; unsafe names abort before saving',async()=>{
  const {options}=setup(); options.additionalFiles=[{name:'../../outside.csv',body:'secret'}];
  await assert.rejects(writeMediaPackages(options),/invalid_export_filename/);
  options.additionalFiles=[{name:'archive.csv',body:'x'.repeat(options.maxBytes)}];
  await assert.rejects(writeMediaPackages(options),/package_metadata_too_large/);
});

test('avatar downloads overlap with a bounded pool and retain one ZIP with complete records and local reader', async () => {
  const doc={source:'bookmarks',bookmarks:Array.from({length:9},(_,n)=>({tweet_id:String(n+1),full_text:`正文 ${n} ✨`,author:{name:`作者 ${n}`,screen_name:`author_${n}`,profile_image_url:`https://pbs.twimg.com/avatar-${n%8}.png`}}))};
  const inventory=buildMediaInventory(doc,{avatars:true});const chunks=[];let active=0,peak=0,calls=0;
  const result=await writeMediaPackages({document:doc,inventory,maxBytes:8*1024*1024,
    openPart:async()=>({async write(b){chunks.push(Buffer.from(b));},async close(){},async abort(){}}),
    fetchImpl:async url=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,8));active--;
      const res=new Response(png(128),{headers:{'content-type':'image/png','content-length':'128'}});Object.defineProperty(res,'url',{value:url});return res;},
  });
  assert.equal(calls,8,'shared avatar is requested only once');assert.ok(peak>1,'network requests must overlap');assert.ok(peak<=4);
  assert.equal(result.status,'complete');assert.equal(result.parts.length,1);assert.equal(result.counts.complete,8);
  const files=checkZip(new Map([['avatar.zip',chunks]]),8*1024*1024);
  assert.deepEqual(JSON.parse(files.get('archive.json')),doc);
  for(const item of result.inventory.items){assert.equal(files.get(item.saved_path).length,128);assert.ok(files.get('打开查看.html').toString().includes(item.path));}
});
test('concurrent avatar errors remain partial, while valid avatars and the ZIP survive',async()=>{
  const doc={bookmarks:[1,2,3].map(n=>({tweet_id:String(n),author:{name:'作者',profile_image_url:`https://pbs.twimg.com/a-${n}.png`}}))};
  const chunks=[];
  const result=await writeMediaPackages({document:doc,inventory:buildMediaInventory(doc,{avatars:true}),maxBytes:1024*1024,
    openPart:async()=>({async write(b){chunks.push(Buffer.from(b));},async close(){},async abort(){}}),
    fetchImpl:async url=>{const bad=url.includes('a-2');const res=new Response(bad?'denied':png(64),{status:bad?429:200,headers:{'content-type':'image/png'}});Object.defineProperty(res,'url',{value:url});return res;}});
  assert.equal(result.status,'partial');assert.equal(result.counts.complete,2);assert.equal(result.counts.failed,1);
  checkZip(new Map([['partial.zip',chunks]]),1024*1024);
});
test('oversized avatars leave the bounded buffer path and retain streaming support',async()=>{
  const doc={bookmarks:[{tweet_id:'1',author:{profile_image_url:'https://pbs.twimg.com/large-avatar.png'}}]};let calls=0;const chunks=[];
  const result=await writeMediaPackages({document:doc,inventory:buildMediaInventory(doc,{avatars:true}),maxBytes:4*1024*1024,
    openPart:async()=>({async write(b){chunks.push(Buffer.from(b));},async close(){},async abort(){}}),
    fetchImpl:async url=>{calls++;const data=png(1024*1024+1);const res=new Response(data,{headers:{'content-type':'image/png','content-length':String(data.length)}});Object.defineProperty(res,'url',{value:url});return res;}});
  assert.equal(result.status,'complete');assert.equal(calls,2);assert.equal(result.inventory.items[0].actual_bytes,1024*1024+1);
});

test('cancelling a parallel avatar export stops queued requests and never schedules the remaining collection',async()=>{
  const doc={bookmarks:Array.from({length:8},(_,i)=>({tweet_id:String(i+1),author:{profile_image_url:`https://pbs.twimg.com/cancel-${i+1}.png`}}))};
  const controller=new AbortController();let calls=0,active=0;const chunks=[];
  const result=await writeMediaPackages({document:doc,inventory:buildMediaInventory(doc,{avatars:true}),maxBytes:1024*1024,signal:controller.signal,
    openPart:async()=>({async write(b){chunks.push(Buffer.from(b));},async close(){},async abort(){}}),
    onProgress:({index})=>{if(index===2)controller.abort();},
    fetchImpl:async(url,{signal})=>{calls++;active++;await new Promise((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);active--;reject(new DOMException('Cancelled','AbortError'));};
      const timer=setTimeout(()=>{active--;signal.removeEventListener('abort',done);resolve();},url.includes('cancel-1.')?2:500);
      signal.addEventListener('abort',done,{once:true});
    });const res=new Response(png(64),{headers:{'content-type':'image/png','content-length':'64'}});Object.defineProperty(res,'url',{value:url});return res;},
  });
  assert.equal(calls,4);assert.equal(active,0);assert.equal(result.cancelled,true);assert.equal(result.counts.complete,1);assert.equal(result.counts.cancelled,7);
  checkZip(new Map([['cancelled.zip',chunks]]),1024*1024);
});
