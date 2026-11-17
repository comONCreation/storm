// Locates the built-in extensions folder of the local VS Code installation.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function findExtensionsDir() {
  const candidates = [];
  try {
    const code = execSync(process.platform === 'win32' ? 'where code.cmd' : 'which code', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    // <install>/bin/code(.cmd) → <install>/<commit>/resources/app/extensions (Windows) or <install>/resources/app/extensions
    const install = path.dirname(path.dirname(fs.realpathSync(code)));
    candidates.push(path.join(install, 'resources', 'app', 'extensions'));
    for (const d of fs.readdirSync(install)) candidates.push(path.join(install, d, 'resources', 'app', 'extensions'));
  } catch {
    /* fall through */
  }
  candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/extensions', '/usr/share/code/resources/app/extensions');
  const found = candidates.find((c) => fs.existsSync(path.join(c, 'theme-defaults', 'package.json')));
  if (!found) throw new Error('VS Code installation not found: pass the path of resources/app/extensions as argument');
  return found;
}

module.exports = findExtensionsDir();
