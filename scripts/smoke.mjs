import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const require = createRequire(import.meta.url);
const output = path.resolve('.cache/prototype-smoke');
const run = path.join(output, `run-${Date.now()}`);
mkdirSync(run, { recursive: true });
for (const phase of ['seed', 'verify']) {
  const resultPath = path.join(run, `${phase}.json`);
  const env = { ...process.env, WIKI_PROFILE_PATH: path.join(run, 'isolated-profile'), WIKI_SMOKE_PHASE: phase, WIKI_SMOKE_RESULT: resultPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['.', '--prototype-smoke'], { env, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); console.error('Prototype smoke timed out.'); }, 60000);
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  clearTimeout(timer);
  if (!existsSync(resultPath)) {
    console.error(`Electron exited before producing a result (exit ${code}).`);
    process.exit(1);
  }
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  console.log(JSON.stringify(result, null, 2));
  if (code !== 0 || !result.passed) process.exit(1);
  copyFileSync(resultPath, path.join(output, `${phase}.json`));
}
