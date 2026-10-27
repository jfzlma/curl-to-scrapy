'use strict';

// Runs generated snippets through real Scrapy and curl_cffi to make sure they are
// valid and send the request curl would send.
// Needs: pip install scrapy scrapy-impersonate curl_cffi
// Usage: node test/check_python.js [python]
const http = require('node:http');
const { execFile } = require('node:child_process');
const { convert } = require('../src/converter.js');

const python = process.argv[2] || 'python3';

// ${BASE} is replaced with the local echo server, which the curl_cffi snippet calls.
const CASES = [
  [`curl '\${BASE}/p?a=1' -H 'Accept: text/html' -b 'sid=1; t=x=y' --compressed`, {}],
  [`curl \${BASE}/login --data-raw 'user=a+b&tag=1&tag=2&city=S%C3%A3o'`, { requestClass: 'FormRequest' }],
  [`curl \${BASE}/login --data-raw 'user=a+b&tag=1&tag=2'`, { requestClass: 'Request', impersonateTarget: 'firefox' }],
  [`curl \${BASE}/api -H 'content-type: application/json' --data-raw '{"q":"it\\u0027s","n":[1,2.5e3],"ok":true,"z":null}'`, { requestClass: 'JsonRequest' }],
  [`curl \${BASE}/api --json '{"q":"x"}'`, { requestClass: 'Request', legacyStartRequests: true, scrapyImpersonate: true, impersonateTarget: 'safari' }],
  [`curl -X PATCH \${BASE}/r -H 'content-type: text/plain' -d $'line1\\nline2 \\'q\\''`, { dontFilter: true, scrapyImpersonate: true }],
  [`curl \${BASE}/up -F 'file=@a.png'`, {}],
];

const HARNESS = `
import contextlib, io, json, sys, asyncio, inspect
from urllib.parse import parse_qsl
import scrapy
from scrapy_impersonate import RequestParser

def describe(req):
    return {
        "cls": type(req).__name__,
        "method": req.method,
        "url": req.url,
        "body": req.body.decode(),
        "headers": {k.decode(): [v.decode() for v in vs] for k, vs in req.headers.items()},
        "cookies": req.cookies,
        "meta": dict(req.meta),
    }

shell_code, spider_code, cffi_code, impersonate = json.loads(sys.stdin.read())

# scrapy shell stand-in: fetch() just records the request.
seen = []
ns = {"fetch": seen.append}
exec(shell_code, ns)
shell_req = describe(seen[0])

ns = {}
exec(spider_code, ns)
spider_cls = next(v for v in ns.values() if isinstance(v, type) and issubclass(v, scrapy.Spider) and v is not scrapy.Spider)
spider = spider_cls()
async def first():
    async for r in spider.start():
        return r
req = asyncio.run(first())
if "start_requests" in spider_cls.__dict__:
    assert describe(next(iter(spider.start_requests()))) == describe(req)
spider_req = describe(req)

# The shell and spider must build the same request (apart from impersonation meta).
a, b = dict(shell_req), dict(spider_req)
b["meta"] = {k: v for k, v in b["meta"].items() if k != "impersonate"}
assert a == b, (a, b)

settings = getattr(spider_cls, "custom_settings", None) or {}
if impersonate:
    assert settings["DOWNLOAD_HANDLERS"]["https"] == "scrapy_impersonate.ImpersonateDownloadHandler"
    assert settings["USER_AGENT"] == ""
    assert RequestParser(req).impersonate == impersonate
else:
    assert "DOWNLOAD_HANDLERS" not in settings

# curl_cffi snippet hits the echo server; compare what arrived with Scrapy's request.
ns = {}
with contextlib.redirect_stdout(io.StringIO()):
    exec(cffi_code, ns)
got = ns["response"].json()
assert got["method"] == shell_req["method"], (got["method"], shell_req["method"])
ct = got["headers"].get("content-type", "")
def norm(body):
    if "json" in ct:
        return json.loads(body)
    if "x-www-form-urlencoded" in ct:
        return sorted(parse_qsl(body, keep_blank_values=True))
    return body
if "multipart" not in str(shell_req["headers"]):
    assert norm(got["body"]) == norm(shell_req["body"]), (got["body"], shell_req["body"])
cookies = shell_req["cookies"]
if cookies:
    sent = dict(p.split("=", 1) for p in got["headers"]["cookie"].split("; "))
    assert sent == cookies, (sent, cookies)

print(json.dumps({"cls": shell_req["cls"], "method": shell_req["method"], "path": got["url"], "body": got["body"], "ua": got["headers"].get("user-agent", "")[:40]}))
`;

function run(input) {
  return new Promise((resolve, reject) => {
    const child = execFile(python, ['-I', '-c', HARNESS], (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
  });
});

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;
  for (const [template, opts] of CASES) {
    const curl = template.replace(/\$\{BASE\}/g, base);
    const out = convert(curl, opts);
    const impersonate = opts.scrapyImpersonate ? (opts.impersonateTarget || 'chrome') : null;
    try {
      const r = JSON.parse(await run(JSON.stringify([out.shell, out.spider, out.curlCffi, impersonate])));
      console.log(`ok   ${r.cls.padEnd(11)} ${r.method.padEnd(5)} ${r.path.padEnd(12)} ua=${JSON.stringify(r.ua)} body=${JSON.stringify(r.body.slice(0, 50))}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${curl}\n${e.message}\n--- shell ---\n${out.shell}\n--- spider ---\n${out.spider}\n--- curl_cffi ---\n${out.curlCffi}`);
    }
  }
  server.close();
  process.exit(failed ? 1 : 0);
});
