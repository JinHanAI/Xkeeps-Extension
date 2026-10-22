import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { VERSION } from '../version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (manifest.version !== VERSION) throw new Error('Manifest and release version disagree.');
const dist = join(root, 'dist');
const store = process.argv.includes('--store');
if (store && process.argv.includes('--staging')) throw new Error('Choose --store or --staging.');
const name = `Xkeeps-v${VERSION}-${store ? 'store' : process.argv.includes('--staging') ? 'staging' : 'local'}`;
const target = join(dist, name);
const zip = `${target}.zip`;
if (process.argv.includes('--replace')) {
  // Only discard this generated release pair, never a user-selected directory.
  rmSync(target, { recursive: true, force: true });
  rmSync(zip, { force: true });
}
if (existsSync(target) || existsSync(zip)) throw new Error(`Release already exists: ${target}`);
mkdirSync(target, { recursive: true });
try {
  const rootFiles = ['LICENSE', 'README.md', 'background.js', 'content.js', 'licenses.html',
    'likes-ui.js', 'manifest.json', 'media-ui.js', 'options.css', 'options.html', 'options.js',
    'schedule-ui.js', 'search-ui.js', 'shell-ui.js', 'shell.css', 'ui-locale-init.js', 'version.js', 'viewer.html', 'viewer.js'];
  for (const file of rootFiles.filter(file => !store || file !== 'README.md')) cpSync(join(root, file), join(target, file));
  if (!store) for (const file of ['README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md']) cpSync(join(root, file), join(target, file));
  for (const folder of ['_locales', 'icons', 'lib', 'vendor']) cpSync(join(root, folder), join(target, folder), { recursive: true });
  mkdirSync(join(target, 'docs'));
  for (const file of store ? ['third-party-notices.md'] : ['maintenance.md', 'third-party-notices.md', 'privacy.md']) cpSync(join(root, 'docs', file), join(target, 'docs', file));
  for (const path of [manifest.background.service_worker, manifest.options_page, ...Object.values(manifest.icons)]) {
    if (!existsSync(join(target, path))) throw new Error(`Missing runtime asset: ${path}`);
  }
  const result = spawnSync('zip', ['-q', '-r', zip, store ? '.' : name, '-x', '*.DS_Store', '*/.DS_Store'], { cwd: store ? target : dist, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'ZIP packaging failed.');
  function count(dir) { return readdirSync(dir).reduce((total, entry) => total + (statSync(join(dir, entry)).isDirectory() ? count(join(dir, entry)) : 1), 0); }
  process.stdout.write(`${target}\n${zip}\n${count(target)} files\n`);
} catch (error) {
  rmSync(target, { recursive: true, force: true });
  rmSync(zip, { force: true });
  throw error;
}
