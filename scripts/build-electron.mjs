import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

execFileSync('npx', ['tsc', '-p', 'tsconfig.electron.json'], { stdio: 'inherit' });

const outDir = path.resolve('dist-electron');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
  'utf8'
);
