const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const overlayDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(overlayDir, '..');
const outputDir = path.join(overlayDir, 'dist', 'backend');
const outputFile = path.join(outputDir, 'mtga-tracker-scraper.exe');
const target = process.env.BUN_BACKEND_TARGET || 'bun-windows-x64';

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(outputFile, { force: true });

console.log(`[scraper:build] Building ${outputFile} with target ${target}`);

const result = spawnSync(
  'bun',
  [
    'build',
    path.join(repoRoot, 'scraper', 'scraper.ts'),
    '--compile',
    `--target=${target}`,
    '--minify',
    '--sourcemap',
    '--bytecode',
    '--outfile',
    outputFile
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit'
  }
);

if (result.status !== 0) {
  process.exit(result.status || 1);
}
