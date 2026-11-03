import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const extensionDir = resolve(rootDir, 'extension');
const safariDir = resolve(rootDir, 'safari');

console.log('ImageCrate: Safari Web Extension conversion tool');

// 1. Check if xcrun and safari-web-extension-converter are available
const probe = spawnSync('xcrun', ['--find', 'safari-web-extension-converter'], { encoding: 'utf8' });
if (probe.status !== 0 || !probe.stdout?.trim()) {
  console.log('NOTICE: xcrun safari-web-extension-converter is not available in this environment.');
  console.log('Skipping Safari project generation. (This step requires macOS with Xcode Command Line Tools).');
  process.exit(0);
}

if (!existsSync(safariDir)) {
  mkdirSync(safariDir, { recursive: true });
}

console.log(`Generating Safari Web Extension project from "${extensionDir}" to "${safariDir}"...`);

// Run converter without --copy-resources so it references the original extension/ directory directly
const args = [
  'safari-web-extension-converter',
  extensionDir,
  '--project-location', safariDir,
  '--app-name', 'ImageCrate',
  '--bundle-identifier', 'com.imagecrate.app',
  '--swift',
  '--no-open',
  '--no-prompt',
  '--force',
];

const result = spawnSync('xcrun', args, { encoding: 'utf8' });

if (result.stdout) {
  console.log(result.stdout.trim());
}

if (result.status !== 0) {
  if (result.stderr) console.error(result.stderr.trim());
  console.error(`ERROR: safari-web-extension-converter failed with code ${result.status}`);
  process.exit(result.status || 1);
}

console.log('\nSuccess! Safari Web Extension project is configured at:');
console.log(`  ${resolve(safariDir, 'ImageCrate')}`);
console.log('\nKey benefits of this configuration:');
console.log('  • Direct reference: Extension assets are referenced directly from extension/.');
console.log('  • No duplicate sources: Edits in extension/ apply immediately to both Chrome and Safari.');
console.log('  • Targets: iOS (App & Extension) + macOS (App & Extension).');
console.log('\nTo build and run on iOS device or simulator:');
console.log('  open safari/ImageCrate/ImageCrate.xcodeproj');
console.log('  Select "ImageCrate (iOS)" target and press Cmd+R.');
