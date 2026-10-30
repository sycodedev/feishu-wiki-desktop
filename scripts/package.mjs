import { spawnSync } from 'node:child_process';
import { mkdirSync, cpSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { packager } from '@electron/packager';

const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const staging = path.resolve('.cache/prototype-package');
const output = path.resolve(process.env.WIKI_PACKAGE_OUTPUT || 'release');
if (!staging.startsWith(process.cwd() + path.sep) || !output.startsWith(process.cwd() + path.sep)) throw new Error('Packaging must stay in the workspace');
mkdirSync(staging, { recursive: true });
cpSync('dist', path.join(staging, 'dist'), { recursive: true });
writeFileSync(path.join(staging, 'package.json'), JSON.stringify({
  name: 'feishu-wiki-desktop', productName: '飞书知识库',
  version: '0.1.0', type: 'module', main: 'dist/main.js',
}, null, 2));
const folders = await packager({
  dir: staging, out: output, platform: 'win32', arch: 'x64',
  name: 'FeishuWiki', executableName: 'FeishuWiki',
  electronVersion: '45.1.0', overwrite: true, asar: true,
  download: { cacheRoot: path.resolve('.cache/electron') },
});

// Prune unused locales to save ~48MB (keep zh-CN and en-US only)
for (const folder of folders) {
  const localesDir = path.join(folder, 'locales');
  if (existsSync(localesDir)) {
    for (const file of readdirSync(localesDir)) {
      if (file !== 'zh-CN.pak' && file !== 'en-US.pak') {
        try { unlinkSync(path.join(localesDir, file)); } catch {}
      }
    }
  }
  const licenseFile = path.join(folder, 'LICENSES.chromium.html');
  if (existsSync(licenseFile)) {
    try { unlinkSync(licenseFile); } catch {}
  }
}

console.log(folders.join('\n'));

