'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, parseCurl, convert } = require('../src/converter.js');

test('tokenizes bash quoting and line continuations', () => {
  assert.deepEqual(
    tokenize(`curl 'https://x.io/a b' \\\n  -H "X-A: \\"q\\"" $'it\\'s\\n' plain\\ word`),
    ['curl', 'https://x.io/a b', '-H', 'X-A: "q"', "it's\n", 'plain word'],
  );
});

test('tokenizes Chrome "Copy as cURL (cmd)"', () => {
  const t = tokenize('curl ^"https://x.io/?a=1^&b=2^" ^\n  -H ^"accept: */*^"');
  assert.deepEqual(t, ['curl', 'https://x.io/?a=1&b=2', '-H', 'accept: */*']);
});

test('GET with headers and cookies', () => {
  const r = parseCurl(`curl 'https://x.io/p' -H 'Accept: text/html' -H 'Cookie: a=1; b=x=y' --compressed`);
  assert.equal(r.method, 'GET');
  assert.deepEqual(r.cookies, [['a', '1'], ['b', 'x=y']]);
  const out = convert(`curl 'https://x.io/p' -H 'Accept: text/html' -b 'a=1'`);
  assert.equal(out.bodyType, 'none');
  assert.deepEqual(out.availableClasses, ['Request']);
  assert.match(out.shell, /from scrapy import Request/);
  assert.match(out.shell, /fetch\(request\)/);
  assert.match(out.spider, /cookies=cookies/);
  assert.doesNotMatch(out.spider, /method=/);
});

test('combined short flags and -X attached value', () => {
  const r = parseCurl(`curl -sSL -XPUT -H'A: b' https://x.io -d 'k=v'`);
  assert.equal(r.method, 'PUT');
  assert.deepEqual(r.headers, [['A', 'b']]);
  assert.equal(r.body, 'k=v');
});

test('form POST offers Request and FormRequest', () => {
  const curl = `curl https://x.io/login --data-raw 'user=a+b&tag=1&tag=2&city=S%C3%A3o'`;
  const asForm = convert(curl, { requestClass: 'FormRequest' });
  assert.equal(asForm.bodyType, 'form');
  assert.deepEqual(asForm.availableClasses, ['Request', 'FormRequest']);
  assert.equal(asForm.requestClass, 'FormRequest');
  assert.match(asForm.spider, /'user': 'a b'/);
  assert.match(asForm.spider, /'tag': \['1', '2'\]/);
  assert.match(asForm.spider, /'city': 'São'/);
  assert.doesNotMatch(asForm.spider, /method=/);

  const asReq = convert(curl, { requestClass: 'Request' });
  assert.match(asReq.spider, /method='POST'/);
  assert.match(asReq.spider, /body = 'user=a\+b&tag=1&tag=2&city=S%C3%A3o'/);
  // curl -d implies a form content type, so a plain Request must send it.
  assert.match(asReq.spider, /'Content-Type': 'application\/x-www-form-urlencoded'/);
});

test('JSON POST keeps key order and big numbers', () => {
  const curl = `curl https://x.io/api -H 'content-type: application/json' --data-raw '{"b":1,"a":[true,null],"id":12345678901234567890,"n":{"2":"x","1":"y"}}'`;
  const out = convert(curl, { requestClass: 'JsonRequest' });
  assert.equal(out.bodyType, 'json');
  assert.deepEqual(out.availableClasses, ['Request', 'JsonRequest']);
  assert.match(out.spider, /from scrapy.http import JsonRequest/);
  assert.match(out.spider, /'id': 12345678901234567890/);
  assert.match(out.spider, /'a': \[True, None\]/);
  assert.ok(out.spider.indexOf("'2'") < out.spider.indexOf("'1'"));
  assert.doesNotMatch(out.spider, /content-type/); // JsonRequest sets it

  const asReq = convert(curl, { requestClass: 'Request' });
  assert.match(asReq.spider, /^import json/);
  assert.match(asReq.spider, /body=json\.dumps\(payload\)/);
});

test('FormRequest falls back to Request for non-form bodies', () => {
  const out = convert(`curl https://x.io -H 'content-type: text/plain' -d 'hello'`, { requestClass: 'FormRequest' });
  assert.equal(out.bodyType, 'raw');
  assert.equal(out.requestClass, 'Request');
});

test('-G moves data into the query string', () => {
  const r = parseCurl(`curl -G https://x.io/s?x=1 -d q=a --data-urlencode 'w=b c'`);
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://x.io/s?x=1&q=a&w=b+c');
  assert.equal(r.body, null);
});

test('--json, -u and proxy', () => {
  const r = parseCurl(`curl --json '{"a":1}' -u user:pw -x 127.0.0.1:8080 https://x.io`);
  assert.equal(r.method, 'POST');
  assert.ok(r.headers.some(([k, v]) => k === 'Authorization' && v === 'Basic dXNlcjpwdw=='));
  const out = convert(`curl --json '{"a":1}' -x 127.0.0.1:8080 https://x.io`);
  assert.match(out.spider, /meta=\{'proxy': 'http:\/\/127\.0\.0\.1:8080'\}/);
});

test('drops headers Scrapy manages and HTTP/2 pseudo headers', () => {
  const curl = `curl https://x.io -H ':authority: x.io' -H 'Host: x.io' -H 'Accept-Encoding: gzip, br, zstd' -H 'Content-Length: 3' -H 'X-Keep: 1'`;
  const out = convert(curl);
  assert.doesNotMatch(out.spider, /authority|Host|Accept-Encoding|Content-Length/);
  assert.match(out.spider, /'X-Keep': '1'/);
  const kept = convert(curl, { dropManagedHeaders: false });
  assert.match(kept.spider, /Accept-Encoding/);
  assert.doesNotMatch(kept.spider, /Content-Length/);
});

test('spider naming and async start', () => {
  const out = convert(`curl https://www.books-to-scrape.com/`, { dontFilter: true });
  assert.match(out.spider, /class BooksToScrapeSpider\(scrapy\.Spider\):/);
  assert.match(out.spider, /name = 'books_to_scrape'/);
  assert.match(out.spider, /async def start\(self\):/);
  assert.doesNotMatch(out.spider, /start_requests/);
  const legacy = convert(`curl https://x.io/`, { legacyStartRequests: true }).spider;
  assert.match(legacy, /async def start\(self\):\n        for request in self\.start_requests\(\):\n            yield request/);
  assert.match(legacy, /def start_requests\(self\):/);
  assert.match(out.spider, /dont_filter=True/);
});

test('reports helpful errors', () => {
  assert.throws(() => convert(''), /Paste a curl command/);
  assert.throws(() => convert(`curl -H 'A: b'`), /No URL/);
  assert.throws(() => convert(`curl 'https://x.io`), /Unterminated/);
});

test('scrapy-impersonate adds settings and meta to the spider only', () => {
  const curl = `curl https://x.io/a -x 127.0.0.1:8080`;
  const out = convert(curl, { scrapyImpersonate: true, impersonateTarget: 'safari' });
  assert.match(out.spider, /^# pip install scrapy-impersonate/);
  assert.match(out.spider, /'https': 'scrapy_impersonate\.ImpersonateDownloadHandler'/);
  assert.match(out.spider, /'TWISTED_REACTOR': 'twisted\.internet\.asyncioreactor\.AsyncioSelectorReactor'/);
  assert.match(out.spider, /'USER_AGENT': ''/);
  assert.match(out.spider, /meta=\{'proxy': 'http:\/\/127\.0\.0\.1:8080', 'impersonate': 'safari'\}/);
  assert.doesNotMatch(out.shell, /impersonate/);
  assert.doesNotMatch(convert(curl).spider, /impersonate/);
});

test('curl_cffi snippet per body type', () => {
  const get = convert(`curl 'https://x.io/p' -b 's=1'`).curlCffi;
  assert.match(get, /from curl_cffi import requests/);
  assert.match(get, /response = requests\.get\(\n    'https:\/\/x\.io\/p',\n    cookies=cookies,\n    impersonate='chrome',\n\)/);

  const json = convert(`curl https://x.io/api -H 'content-type: application/json' -d '{"a":1}'`, { impersonateTarget: 'firefox' }).curlCffi;
  assert.match(json, /json_data = \{\n    'a': 1,\n\}/);
  assert.match(json, /json=json_data/);
  assert.match(json, /impersonate='firefox'/);
  assert.doesNotMatch(json, /content-type/);
  assert.match(json, /print\(response\.json\(\)\)/);

  const form = convert(`curl https://x.io -d 'a=1&a=2&b=3'`).curlCffi;
  assert.match(form, /data = \[\n    \('a', '1'\),\n    \('a', '2'\),\n    \('b', '3'\),\n\]/);
  assert.match(convert(`curl https://x.io -d 'a=1&b=2'`).curlCffi, /data = \{\n    'a': '1',\n    'b': '2',\n\}/);

  const custom = convert(`curl -X PROPFIND https://x.io`).curlCffi;
  assert.match(custom, /requests\.request\(\n    'PROPFIND',\n    'https:\/\/x\.io',/);
});

test('warns when the copied User-Agent contradicts the impersonated browser', () => {
  const curl = `curl https://x.io -A 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36'`;
  assert.equal(convert(curl).warnings.length, 0);
  assert.match(convert(curl, { impersonateTarget: 'firefox' }).warnings.join(), /doesn't look like firefox/);
});
