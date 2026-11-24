'use strict';

// Downloads the installer and the portable exe of the latest GitHub release
// into dist/. Needs the GitHub CLI (gh) signed in. Older files stay.
// Usage: npm run get-release [-- v0.4.0]

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'Rheoniq/Ephor';
const dist = path.join(__dirname, '..', 'dist');
const tag = process.argv[2];

fs.mkdirSync(dist, { recursive: true });
const args = ['release', 'download'];
if (tag) args.push(tag);
args.push('--repo', REPO, '--pattern', 'Ephor-*.exe', '--dir', dist, '--clobber');

try {
  execFileSync('gh', args, { stdio: 'inherit' });
} catch (err) {
  console.error(
    err && err.code === 'ENOENT'
      ? 'The GitHub CLI (gh) is not installed or not on PATH.'
      : 'Download failed. Check that gh is signed in (gh auth status) and that the release exists.',
  );
  process.exit(1);
}

for (const f of fs.readdirSync(dist).filter((n) => /^Ephor-.*\.exe$/.test(n)).sort()) {
  console.log(`dist/${f}  ${(fs.statSync(path.join(dist, f)).size / 1048576).toFixed(1)} MB`);
}
