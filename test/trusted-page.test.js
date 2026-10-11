const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTrustedPage } = require('../src/backend/trusted-page');
test('accepts Chromium and Node encodings of the same portable short-path page',()=>{
  const file = path.resolve('portable~1','resources','app.asar','src','renderer','index.html');
  const encoded = pathToFileURL(file).href;
  assert.equal(isTrustedPage(encoded,file),true);
  assert.equal(isTrustedPage(encoded.replace(/%7e/gi,'~'),file),true);
});
test('rejects other files, protocols, query strings, fragments and malformed encodings',()=>{
  const file = path.resolve('resources','app.asar','src','renderer','index.html');
  const url = pathToFileURL(file).href;
  for (const candidate of ['https://example.com/index.html',url.replace('index.html','evil.html'),url+'?other=1',url+'#frame',url.replace('index.html','%2Findex.html'),'invalid']) assert.equal(isTrustedPage(candidate,file),false,candidate);
});
