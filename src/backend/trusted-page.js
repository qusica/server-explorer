const path = require('node:path');
const { fileURLToPath } = require('node:url');
function isTrustedPage(url, expectedFile) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || parsed.search || parsed.hash) return false;
    const actual = path.resolve(fileURLToPath(parsed));
    const expected = path.resolve(expectedFile);
    return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  } catch { return false; }
}
module.exports = { isTrustedPage };
