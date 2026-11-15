// Verschiebt aeltere Installer aus dist\ nach dist\alt\ (laeuft vor jedem "npm run dist")
const fs = require('fs');
const path = require('path');
const dist = path.join(__dirname, '..', 'dist');
const version = require('../package.json').version;
if (!fs.existsSync(dist)) process.exit(0);
const alt = path.join(dist, 'alt');
for (const f of fs.readdirSync(dist)) {
  if (!/^Glowline-Setup-.*\.exe(\.blockmap)?$/.test(f) || f.includes(`-${version}.exe`)) continue;
  fs.mkdirSync(alt, { recursive: true });
  fs.renameSync(path.join(dist, f), path.join(alt, f));
  console.log('nach dist\alt:', f);
}
