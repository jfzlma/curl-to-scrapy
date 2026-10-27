# curl-to-scrapy

**Try it: https://jfzlma.github.io/curl-to-scrapy/**

A free, open-source converter that turns a `curl` command into **Scrapy** code:

- a snippet to paste into **`scrapy shell`** (builds the request and calls `fetch()`)
- a ready-to-run **spider** (`async def start()` plus a `parse` callback, optionally with `start_requests()` for Scrapy < 2.13)
- a standalone **[curl_cffi](https://github.com/lexiforest/curl_cffi)** snippet, to quickly check whether a request gets through with a real browser's TLS fingerprint

For requests with a body you choose the request class:

| Body detected | Options |
| --- | --- |
| `application/x-www-form-urlencoded` | `Request` (body sent byte-for-byte) or `FormRequest` (editable `formdata` dict, repeated keys become lists) |
| JSON | `Request` (`body=json.dumps(payload)`) or `JsonRequest` (`data=payload`) |
| anything else | `Request` with the raw body |

### Browser impersonation

Sites that block Scrapy often fingerprint its TLS handshake. Pick a browser to impersonate (`chrome`, `edge`, `firefox`, `safari`, `chrome_android`, `safari_ios`) and:

- the **curl_cffi** snippet always uses it (`impersonate='firefox'`)
- with **Use scrapy-impersonate** ticked, the spider gets the [scrapy-impersonate](https://github.com/jxlil/scrapy-impersonate) download handler in `custom_settings` and `meta={'impersonate': ...}` on the request, so Scrapy sends it through curl_cffi

You'll get a warning if the copied `User-Agent` header doesn't match the browser you're impersonating, since it overrides the one curl_cffi would send.

Everything runs in your browser. Copied curl commands usually contain cookies and tokens, and nothing you paste is sent anywhere.

## Features

- Bash quoting, `$'…'` strings, `\` line continuations, and Chrome/Edge **"Copy as cURL (cmd)"** on Windows
- `-X`, `-H`, `-d`/`--data-raw`/`--data-binary`/`--data-urlencode`, `--json`, `-b`, `-u`, `-A`, `-e`, `-G`, `-I`, `-x`, `--url-query`, `--oauth2-bearer`, combined short flags (`-sSL`, `-XPOST`)
- Cookies pulled out into a `cookies={}` dict (optional)
- Drops headers Scrapy manages itself (`Host`, `Connection`, `Accept-Encoding`, `Content-Length`) and HTTP/2 pseudo headers such as `:authority`
- JSON payloads become Python literals with key order, duplicate keys and large numbers kept exactly as written
- Warns about things Scrapy can't reproduce directly (bodies read from `@file`, `-F` multipart uploads, digest/NTLM auth)

## Usage

Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

Then go to http://localhost:8000. It's a static site with no build step and no dependencies.

### Deploying

Pushes to `main` run the tests and deploy to GitHub Pages via [.github/workflows/pages.yml](.github/workflows/pages.yml). In the repo, set **Settings → Pages → Source** to **GitHub Actions** once.

### As a library

`src/converter.js` works in Node and in the browser (`window.CurlToScrapy`):

```js
const { convert } = require('./src/converter.js');

const out = convert(`curl https://example.com/login -d 'user=a&pass=b'`, {
  requestClass: 'FormRequest',   // 'Request' | 'FormRequest' | 'JsonRequest'
  cookiesAsDict: true,
  dropManagedHeaders: true,
  legacyStartRequests: false,    // true → also emit start_requests() for Scrapy < 2.13
  dontFilter: false,
  scrapyImpersonate: false,      // true → spider uses scrapy-impersonate
  impersonateTarget: 'chrome',   // browser for scrapy-impersonate and curl_cffi
});

out.shell;            // code for scrapy shell
out.spider;           // spider module
out.curlCffi;         // standalone curl_cffi script
out.bodyType;         // 'none' | 'form' | 'json' | 'raw' | 'multipart'
out.availableClasses; // classes that fit this body
out.warnings;         // anything that couldn't be converted faithfully
```

## Tests

```bash
npm test
```

To check the generated code against the real libraries: the shell and spider snippets must build identical requests, scrapy-impersonate must pick up the impersonation settings, and the curl_cffi snippet must send the same request to a local echo server:

```bash
pip install scrapy scrapy-impersonate curl_cffi
npm run test:python
```

## Contributing

Issues and pull requests are welcome, especially curl commands that convert wrongly. Please add a test case to `test/converter.test.js` with any fix.

## License

[MIT](LICENSE)
