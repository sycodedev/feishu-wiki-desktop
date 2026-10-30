import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';

const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync('dist/ui', { recursive: true });
cpSync('ui', 'dist/ui', { recursive: true });
console.log('Build completed.');
