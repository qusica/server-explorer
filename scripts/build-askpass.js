const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
if (process.platform !== 'win32') throw new Error('目前此应用面向 Windows。');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'resources', 'askpass.exe');
const source = path.join(root, 'resources', 'Askpass.cs');
if (!fs.existsSync(output) || fs.statSync(source).mtimeMs > fs.statSync(output).mtimeMs) {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/target:winexe', '/optimize+', `/out:${output}`, source], { windowsHide: true, stdio: 'inherit' });
}
