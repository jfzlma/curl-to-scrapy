# curl2scrapy

**Try it: https://jfzlma.github.io/curl2scrapy/**

A free, open-source converter that turns a `curl` command into **Scrapy** code:

- a snippet to paste into **`scrapy shell`** (builds the request and calls `fetch()`)
- a ready-to-run **spider** (`start_requests()` or `async def start()`, plus a `parse` callback)

For requests with a body you choose the request class:

| Body detected | Options |
| --- | --- |
| `application/x-www-form-urlencoded` | `Request` (body sent byte-for-byte) or `FormRequest` (editable `formdata` dict, repeated keys become lists) |
| JSON | `Request` (`body=json.dumps(payload)`) or `JsonRequest` (`data=payload`) |
| anything else | `Request` with the raw body |

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
  asyncStart: false,             // true → `async def start()` (Scrapy 2.13+)
  dontFilter: false,
});

out.shell;            // code for scrapy shell
out.spider;           // spider module
out.bodyType;         // 'none' | 'form' | 'json' | 'raw' | 'multipart'
out.availableClasses; // classes that fit this body
out.warnings;         // anything that couldn't be converted faithfully
```

## Tests

```bash
npm test
```

To check that the generated code runs in real Scrapy and that the shell and spider snippets build identical requests:

```bash
pip install scrapy
npm run test:python
```

## Contributing

Issues and pull requests are welcome, especially curl commands that convert wrongly. Please add a test case to `test/converter.test.js` with any fix.

## License

[MIT](LICENSE)
