import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 1));
