import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const cache = path.resolve('.cache/electron');
const temp = path.resolve('.cache/runtime-temp');
mkdirSync(cache, { recursive: true });
mkdirSync(temp, { recursive: true });
const result = spawnSync(process.execPath, ['node_modules/electron/install.js'], {
  stdio: 'inherit',
  env: { ...process.env, electron_config_cache: cache, ELECTRON_CACHE: cache, TEMP: temp, TMP: temp },
});
process.exit(result.status ?? 1);
