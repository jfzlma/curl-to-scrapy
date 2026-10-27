'use strict';

// Runs generated snippets through real Scrapy to make sure they are valid and
// build the request curl would send. Usage: node test/check_python.js [python]
const { execFileSync } = require('node:child_process');
const { convert } = require('../src/converter.js');

const python = process.argv[2] || 'python3';

const CASES = [
  [`curl 'https://x.io/p?a=1' -H 'Accept: text/html' -b 'sid=1; t=x=y' --compressed`, {}],
  [`curl https://x.io/login --data-raw 'user=a+b&tag=1&tag=2&city=S%C3%A3o'`, { requestClass: 'FormRequest' }],
  [`curl https://x.io/login --data-raw 'user=a+b&tag=1&tag=2'`, { requestClass: 'Request' }],
  [`curl https://x.io/api -H 'content-type: application/json' --data-raw '{"q":"it\\u0027s","n":[1,2.5e3],"ok":true,"z":null}'`, { requestClass: 'JsonRequest' }],
  [`curl https://x.io/api --json '{"q":"x"}'`, { requestClass: 'Request', asyncStart: true }],
  [`curl -X PATCH https://x.io/r -H 'content-type: text/plain' -d $'line1\\nline2 \\'q\\''`, { dontFilter: true }],
  [`curl https://x.io -F 'file=@a.png'`, {}],
];

// Stand-in for the scrapy shell: fetch() just records the request.
const HARNESS = `
import json, sys, asyncio, inspect
import scrapy

def describe(req):
    return {
        "cls": type(req).__name__,
        "method": req.method,
        "url": req.url,
        "body": req.body.decode(),
        "headers": {k.decode(): [v.decode() for v in vs] for k, vs in req.headers.items()},
        "cookies": req.cookies,
    }

shell_code, spider_code = json.loads(sys.stdin.read())

seen = []
ns = {"fetch": seen.append}
exec(shell_code, ns)
shell_req = describe(seen[0])

ns = {}
exec(spider_code, ns)
spider_cls = next(v for v in ns.values() if isinstance(v, type) and issubclass(v, scrapy.Spider) and v is not scrapy.Spider)
spider = spider_cls()
if hasattr(spider_cls, "start") and inspect.isasyncgenfunction(spider_cls.__dict__.get("start")):
    async def first():
        async for r in spider.start():
            return r
    spider_req = asyncio.run(first())
else:
    spider_req = next(iter(spider.start_requests()))

a, b = shell_req, describe(spider_req)
assert a == b, (a, b)
print(json.dumps(a))
`;

let failed = 0;
for (const [curl, opts] of CASES) {
  const out = convert(curl, opts);
  try {
    const res = execFileSync(python, ['-I', '-c', HARNESS], { input: JSON.stringify([out.shell, out.spider]) });
    const req = JSON.parse(res);
    console.log(`ok   ${req.cls.padEnd(11)} ${req.method.padEnd(5)} ${req.url}  body=${JSON.stringify(req.body)}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${curl}\n${e.stderr || e.message}\n--- shell ---\n${out.shell}\n--- spider ---\n${out.spider}`);
  }
}
process.exit(failed ? 1 : 0);
