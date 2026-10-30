import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const packaged = process.argv.includes('--packaged');
if (!packaged) {
  const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const require = createRequire(import.meta.url);
const output = path.resolve('.cache/official-web-probe');
mkdirSync(output, { recursive: true });
const runId = Date.now();
const env = {
  ...process.env, WIKI_PROFILE_PATH: path.join(output, `fresh-profile-${runId}`),
  WIKI_PROBE_RESULT: path.join(output, `result-${runId}.json`),
  WIKI_CAPTURE_PATH: path.resolve('docs/evidence/prototype-home.png'),
};
delete env.ELECTRON_RUN_AS_NODE;
const executable = packaged ? path.resolve('release/WikiDeskPrototype-win32-x64/WikiDeskPrototype.exe') : require('electron');
const child = spawn(executable, [...(packaged ? [] : ['.']), '--prototype-probe'], { env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill(), 45000);
const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
clearTimeout(timer);
if (!existsSync(env.WIKI_PROBE_RESULT)) {
  console.error(`Prototype exited before writing an observation (exit ${code}).`);
  process.exit(1);
}
const result = JSON.parse(readFileSync(env.WIKI_PROBE_RESULT, 'utf8'));
console.log(JSON.stringify(result, null, 2));
if (code !== 0 || !result.loginPageObserved) process.exit(1);
copyFileSync(env.WIKI_PROBE_RESULT, path.join(output, 'result.json'));
