/*!
 * curl-to-scrapy — convert curl commands into Scrapy code.
 * MIT License. Runs entirely in the browser (and in Node for tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CurlToScrapy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Shell tokenizer (bash, plus Chrome's "Copy as cURL (cmd)" flavour)
  // ---------------------------------------------------------------------------

  function tokenize(input) {
    let s = String(input).trim();

    // Windows cmd: ^ escapes every special char, ^<newline> continues a line.
    if (/\^"/.test(s)) {
      s = s.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1');
    }
    // PowerShell-style backtick continuation.
    s = s.replace(/`\r?\n/g, ' ');

    const tokens = [];
    let cur = '';
    let has = false;
    let i = 0;

    while (i < s.length) {
      const c = s[i];

      if (c === '\\' && s[i + 1] === '\n') { i += 2; continue; }
      if (c === '\\' && s[i + 1] === '\r' && s[i + 2] === '\n') { i += 3; continue; }

      if (/\s/.test(c)) {
        if (has) { tokens.push(cur); cur = ''; has = false; }
        i++;
        continue;
      }

      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end === -1) throw new Error('Unterminated single quote');
        cur += s.slice(i + 1, end);
        has = true;
        i = end + 1;
        continue;
      }

      if (c === '$' && s[i + 1] === "'") {
        const r = readAnsiC(s, i + 2);
        cur += r.value;
        has = true;
        i = r.end;
        continue;
      }

      if (c === '"') {
        i++;
        has = true;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1])) {
            if (s[i + 1] !== '\n') cur += s[i + 1];
            i += 2;
          } else {
            cur += s[i];
            i++;
          }
        }
        if (i >= s.length) throw new Error('Unterminated double quote');
        i++;
        continue;
      }

      if (c === '\\') {
        if (i + 1 < s.length) { cur += s[i + 1]; has = true; }
        i += 2;
        continue;
      }

      cur += c;
      has = true;
      i++;
    }
    if (has) tokens.push(cur);
    return tokens;
  }

  // Bash $'...' (ANSI-C quoting), used by Chrome/Edge when a value has odd chars.
  function readAnsiC(s, i) {
    const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    let out = '';
    while (i < s.length && s[i] !== "'") {
      if (s[i] !== '\\') { out += s[i++]; continue; }
      const n = s[i + 1];
      if (n in simple) { out += simple[n]; i += 2; continue; }
      let m;
      if ((m = /^x([0-9a-fA-F]{1,2})/.exec(s.slice(i + 1)))) {
        out += String.fromCharCode(parseInt(m[1], 16));
      } else if ((m = /^u([0-9a-fA-F]{1,4})/.exec(s.slice(i + 1)))) {
        out += String.fromCharCode(parseInt(m[1], 16));
      } else if ((m = /^U([0-9a-fA-F]{1,8})/.exec(s.slice(i + 1)))) {
        out += String.fromCodePoint(parseInt(m[1], 16));
      } else if ((m = /^([0-7]{1,3})/.exec(s.slice(i + 1)))) {
        out += String.fromCharCode(parseInt(m[1], 8));
      } else {
        out += '\\' + (n === undefined ? '' : n);
        i += 2;
        continue;
      }
      i += 1 + m[0].length;
    }
    if (i >= s.length) throw new Error("Unterminated $'...' string");
    return { value: out, end: i + 1 };
  }

  // ---------------------------------------------------------------------------
  // curl argument parser
  // ---------------------------------------------------------------------------

  // Short flags that consume a value.
  const SHORT_WITH_VALUE = new Set('XHdbuAeFoxTcDmrtwyYzKEUQCP'.split(''));

  // Long flags that consume a value (anything else is treated as a switch).
  const LONG_WITH_VALUE = new Set([
    'request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode',
    'json', 'form', 'form-string', 'cookie', 'cookie-jar', 'user', 'user-agent', 'referer',
    'url', 'url-query', 'proxy', 'proxy-user', 'output', 'max-time', 'connect-timeout',
    'cert', 'key', 'cacert', 'capath', 'resolve', 'connect-to', 'retry', 'retry-delay',
    'retry-max-time', 'limit-rate', 'range', 'write-out', 'dump-header', 'config',
    'upload-file', 'interface', 'local-port', 'max-redirs', 'max-filesize', 'oauth2-bearer',
    'aws-sigv4', 'unix-socket', 'abstract-unix-socket', 'ciphers', 'continue-at',
    'variable', 'expect100-timeout', 'keepalive-time', 'dns-servers', 'cert-type',
    'key-type', 'pass', 'engine', 'proto', 'proto-redir', 'trace', 'trace-ascii', 'stderr',
    'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'preproxy', 'noproxy', 'request-target',
    'happy-eyeballs-timeout-ms', 'happy-eyeballs-timeout', 'tls-max', 'ech', 'ipfs-gateway',
  ]);

  const SHORT_TO_LONG = {
    X: 'request', H: 'header', d: 'data', b: 'cookie', u: 'user', A: 'user-agent',
    e: 'referer', F: 'form', x: 'proxy', G: 'get', I: 'head',
  };

  function parseCurl(input) {
    const tokens = tokenize(input);
    if (tokens[0] && /(^|[\\/])curl(\.exe)?$/i.test(tokens[0])) tokens.shift();
    if (!tokens.length) throw new Error('Paste a curl command to convert');

    const st = {
      url: null, method: null, headers: [], data: [], urlQueries: [], forms: [],
      cookieStrings: [], user: null, get: false, head: false, json: false,
      proxy: null, warnings: [],
    };

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const next = () => {
        if (i + 1 >= tokens.length) throw new Error(`Option ${tok} expects a value`);
        return tokens[++i];
      };

      if (tok === '--') {
        for (i++; i < tokens.length; i++) setUrl(st, tokens[i]);
        break;
      }

      if (tok.startsWith('--')) {
        const name = tok.slice(2);
        if (LONG_WITH_VALUE.has(name)) applyOption(st, name, next());
        else applyOption(st, name, null);
        continue;
      }

      if (tok.startsWith('-') && tok.length > 1) {
        // Combined short flags: -sSL, -XPOST, -H'Accept: x'
        for (let j = 1; j < tok.length; j++) {
          const f = tok[j];
          if (SHORT_WITH_VALUE.has(f)) {
            const value = j + 1 < tok.length ? tok.slice(j + 1) : next();
            applyOption(st, SHORT_TO_LONG[f] || '-' + f, value);
            break;
          }
          applyOption(st, SHORT_TO_LONG[f] || '-' + f, null);
        }
        continue;
      }

      setUrl(st, tok);
    }

    return finalize(st);
  }

  function setUrl(st, value) {
    if (st.url === null) st.url = value;
    else st.warnings.push(`Ignored extra URL: ${value}`);
  }

  function applyOption(st, name, value) {
    switch (name) {
      case 'request': st.method = value; break;
      case 'header': addHeaderLine(st, value); break;
      case 'data':
      case 'data-ascii':
      case 'data-binary':
        if (value.startsWith('@')) st.warnings.push(`Body is read from a file (${value}); paste the file contents instead.`);
        st.data.push(value);
        break;
      case 'data-raw': st.data.push(value); break;
      case 'data-urlencode': st.data.push(urlencodeArg(st, value)); break;
      case 'json':
        if (value.startsWith('@')) st.warnings.push(`JSON body is read from a file (${value}); paste the file contents instead.`);
        st.data.push(value);
        st.json = true;
        break;
      case 'form':
      case 'form-string':
        st.forms.push(value);
        break;
      case 'cookie':
        if (value.includes('=')) st.cookieStrings.push(value);
        else st.warnings.push(`Cookies are read from a file (${value}); they were not included.`);
        break;
      case 'user': st.user = value; break;
      case 'user-agent': st.headers.push(['User-Agent', value]); break;
      case 'referer': st.headers.push(['Referer', value.replace(/;auto$/, '')]); break;
      case 'oauth2-bearer': st.headers.push(['Authorization', 'Bearer ' + value]); break;
      case 'url': setUrl(st, value); break;
      case 'url-query': st.urlQueries.push(value); break;
      case 'proxy': st.proxy = /:\/\//.test(value) ? value : 'http://' + value; break;
      case 'get': st.get = true; break;
      case 'head': st.head = true; break;
      case 'aws-sigv4': st.warnings.push('AWS SigV4 signing is not supported; sign the request yourself.'); break;
      case 'digest':
      case 'ntlm':
      case 'negotiate':
        st.warnings.push(`--${name} auth is not supported by Scrapy out of the box.`);
        break;
      default:
        // Switches like --compressed, -k, -L, -s, -v don't change the request
        // Scrapy sends (it decompresses and follows redirects by default).
        break;
    }
  }

  function addHeaderLine(st, line) {
    if (line.startsWith('@')) {
      st.warnings.push(`Headers are read from a file (${line}); they were not included.`);
      return;
    }
    // "Name;" sends an empty header, "Name:" (no value) removes it in curl.
    const semi = /^([^:;\s]+);\s*$/.exec(line);
    if (semi) { st.headers.push([semi[1], '']); return; }
    const idx = line.indexOf(':', line.startsWith(':') ? 1 : 0);
    if (idx === -1) { st.warnings.push(`Ignored malformed header: ${line}`); return; }
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!value) return;
    st.headers.push([name, value]);
  }

  // --data-urlencode / --url-query value syntax.
  function urlencodeArg(st, value, allowPlus) {
    if (allowPlus && value.startsWith('+')) return value.slice(1);
    const enc = (v) => encodeURIComponent(v).replace(/%20/g, '+');
    if (value.startsWith('@')) {
      st.warnings.push(`Value is read from a file (${value}); paste the file contents instead.`);
      return value;
    }
    const eq = value.indexOf('=');
    const at = value.indexOf('@');
    if (at > 0 && (eq === -1 || at < eq)) {
      st.warnings.push(`Value is read from a file (${value}); paste the file contents instead.`);
      return value;
    }
    if (eq === -1) return enc(value);
    if (eq === 0) return enc(value.slice(1));
    return value.slice(0, eq) + '=' + enc(value.slice(eq + 1));
  }

  function base64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  function finalize(st) {
    if (!st.url) throw new Error('No URL found in the curl command');

    let url = st.url;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url;

    let body = st.data.length ? st.data.join('&') : null;

    const appendQuery = (q) => {
      if (!q) return;
      const hashIdx = url.indexOf('#');
      const hash = hashIdx === -1 ? '' : url.slice(hashIdx);
      const base = hashIdx === -1 ? url : url.slice(0, hashIdx);
      url = base + (base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?') + q + hash;
    };

    if (st.get && body !== null) { appendQuery(body); body = null; }
    st.urlQueries.forEach((q) => appendQuery(urlencodeArg(st, q, true)));

    let method = st.method;
    if (!method) {
      if (st.head) method = 'HEAD';
      else if (body !== null || st.forms.length) method = 'POST';
      else method = 'GET';
    }
    method = method.toUpperCase();

    const headers = st.headers.slice();
    const hasHeader = (n) => headers.some(([k]) => k.toLowerCase() === n);
    if (st.json) {
      if (!hasHeader('content-type')) headers.push(['Content-Type', 'application/json']);
      if (!hasHeader('accept')) headers.push(['Accept', 'application/json']);
    }
    if (st.user !== null && !hasHeader('authorization')) {
      const user = st.user.includes(':') ? st.user : st.user + ':';
      headers.push(['Authorization', 'Basic ' + base64(user)]);
    }

    // Cookies: from -b and from any Cookie header.
    const cookieStrings = st.cookieStrings.slice();
    headers.forEach(([k, v]) => { if (k.toLowerCase() === 'cookie') cookieStrings.push(v); });
    const cookies = [];
    cookieStrings.forEach((cs) => {
      cs.split(';').forEach((part) => {
        const p = part.trim();
        if (!p) return;
        const eq = p.indexOf('=');
        if (eq === -1) cookies.push([p, '']);
        else cookies.push([p.slice(0, eq).trim(), p.slice(eq + 1).trim()]);
      });
    });

    const ctEntry = headers.find(([k]) => k.toLowerCase() === 'content-type');
    let contentType = ctEntry ? ctEntry[1] : null;
    if (!contentType && body !== null && !st.json) {
      contentType = 'application/x-www-form-urlencoded'; // curl's default for -d
    }

    return {
      method, url, headers, cookies, cookieHeader: cookieStrings.join('; '),
      body, forms: st.forms, proxy: st.proxy, contentType, explicitContentType: !!ctEntry,
      warnings: st.warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Body analysis
  // ---------------------------------------------------------------------------

  // Small JSON parser that keeps key order, duplicate keys and number literals
  // exactly as written (JSON.parse would round big ints and reorder "1"-like keys).
  function parseJson(text) {
    let i = 0;
    const fail = () => { throw new Error('Invalid JSON'); };
    const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };

    function str() {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (i >= text.length) fail();
      i++;
      return JSON.parse(text.slice(start, i));
    }

    function val() {
      ws();
      const c = text[i];
      if (c === '{') {
        i++;
        const entries = [];
        ws();
        if (text[i] === '}') { i++; return { t: 'obj', entries }; }
        for (;;) {
          ws();
          if (text[i] !== '"') fail();
          const k = str();
          ws();
          if (text[i++] !== ':') fail();
          entries.push([k, val()]);
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === '}') { i++; return { t: 'obj', entries }; }
          fail();
        }
      }
      if (c === '[') {
        i++;
        const items = [];
        ws();
        if (text[i] === ']') { i++; return { t: 'arr', items }; }
        for (;;) {
          items.push(val());
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return { t: 'arr', items }; }
          fail();
        }
      }
      if (c === '"') return { t: 'str', v: str() };
      for (const [lit, py] of [['true', 'True'], ['false', 'False'], ['null', 'None']]) {
        if (text.startsWith(lit, i)) { i += lit.length; return { t: 'lit', v: py }; }
      }
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
      if (m) { i += m[0].length; return { t: 'num', v: m[0] }; }
      return fail();
    }

    const r = val();
    ws();
    if (i !== text.length) fail();
    return r;
  }

  function parseForm(body) {
    if (!body) return null;
    const parts = body.split('&');
    const map = new Map();
    for (const part of parts) {
      if (part === '') continue;
      const eq = part.indexOf('=');
      if (eq <= 0) return null;
      let k, v;
      try {
        k = decodeURIComponent(part.slice(0, eq).replace(/\+/g, ' '));
        v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
      } catch (e) {
        return null;
      }
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(v);
    }
    return map.size ? Array.from(map.entries()) : null;
  }

  function analyze(req) {
    if (req.forms.length) return { type: 'multipart' };
    if (req.body === null) return { type: 'none' };
    const ct = (req.contentType || '').toLowerCase();
    const looksJson = /^\s*[[{]/.test(req.body);
    if (ct.includes('json') || looksJson) {
      try {
        return { type: 'json', json: parseJson(req.body) };
      } catch (e) { /* fall through */ }
    }
    if (ct.includes('x-www-form-urlencoded')) {
      const form = parseForm(req.body);
      if (form) return { type: 'form', form };
    }
    return { type: 'raw' };
  }

  // ---------------------------------------------------------------------------
  // Python code emitters
  // ---------------------------------------------------------------------------

  function pyStr(s) {
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = '';
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (ch === '\\') out += '\\\\';
      else if (ch === q) out += '\\' + q;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
      else if (code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff)) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += ch;
    }
    return q + out + q;
  }

  const pad = (n) => ' '.repeat(n);

  function pyDict(entries, indent) {
    if (!entries.length) return '{}';
    return '{\n' + entries.map(([k, v]) => `${pad(indent + 4)}${pyStr(k)}: ${v},`).join('\n') + '\n' + pad(indent) + '}';
  }

  function pyJson(node, indent) {
    switch (node.t) {
      case 'obj':
        return pyDict(node.entries.map(([k, v]) => [k, pyJson(v, indent + 4)]), indent);
      case 'arr': {
        if (!node.items.length) return '[]';
        const scalar = node.items.every((n) => n.t !== 'obj' && n.t !== 'arr');
        const inline = '[' + node.items.map((n) => pyJson(n, 0)).join(', ') + ']';
        if (scalar && inline.length + indent < 80) return inline;
        return '[\n' + node.items.map((n) => `${pad(indent + 4)}${pyJson(n, indent + 4)},`).join('\n') + '\n' + pad(indent) + ']';
      }
      case 'str': return pyStr(node.v);
      default: return node.v;
    }
  }

  function pyCall(callee, kwargs, indent) {
    return callee + '(\n' + kwargs.map(([k, v]) => `${pad(indent + 4)}${k}=${v},`).join('\n') + '\n' + pad(indent) + ')';
  }

  // ---------------------------------------------------------------------------
  // Scrapy code generation
  // ---------------------------------------------------------------------------

  const MANAGED_HEADERS = new Set(['host', 'connection', 'accept-encoding']);
  const DEFAULT_CT = {
    FormRequest: 'application/x-www-form-urlencoded',
    JsonRequest: 'application/json',
  };

  function availableClasses(bodyType) {
    if (bodyType === 'form') return ['Request', 'FormRequest'];
    if (bodyType === 'json') return ['Request', 'JsonRequest'];
    return ['Request'];
  }

  function spiderNames(url) {
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { /* ignore */ }
    let base;
    if (!host || /^[\d.]+$/.test(host) || host.includes(':') || host === 'localhost') base = 'local';
    else {
      const parts = host.replace(/^www\./, '').split('.');
      if (parts.length > 1) parts.pop();
      base = parts.join('_');
    }
    base = base.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'my';
    if (/^\d/.test(base)) base = 's_' + base;
    const cls = base.split('_').filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join('') + 'Spider';
    return { name: base, cls, host };
  }

  /**
   * Header dict entries ([name, pythonCode]) for the generated request.
   * defaultCt: Content-Type the client library sets itself (dropped when equal).
   * implicitCt: Content-Type to add when curl would have sent one implicitly.
   */
  function buildHeaders(req, opts, defaultCt, implicitCt) {
    const headerMap = new Map();
    for (const [name, value] of req.headers) {
      const lower = name.toLowerCase();
      if (name.startsWith(':')) continue; // HTTP/2 pseudo headers from devtools
      if (lower === 'content-length') continue;
      if (lower === 'cookie' && opts.cookiesAsDict !== false) continue;
      if (opts.dropManagedHeaders !== false && MANAGED_HEADERS.has(lower)) continue;
      if (lower === 'content-type' && defaultCt && value.trim().toLowerCase() === defaultCt) continue;
      const key = Array.from(headerMap.keys()).find((k) => k.toLowerCase() === lower) || name;
      if (!headerMap.has(key)) headerMap.set(key, []);
      headerMap.get(key).push(value);
    }
    if (implicitCt && req.body !== null && !req.explicitContentType) headerMap.set('Content-Type', [implicitCt]);
    return Array.from(headerMap.entries()).map(([k, vs]) => [
      k, vs.length === 1 ? pyStr(vs[0]) : '[' + vs.map(pyStr).join(', ') + ']',
    ]);
  }

  function pyInlineDict(entries) {
    return '{' + entries.map(([k, v]) => `${pyStr(k)}: ${v}`).join(', ') + '}';
  }

  /**
   * Build the pieces shared by the shell and spider snippets.
   * Returns { cls, imports, vars: [[name, code]], kwargs: [[name, code]], notes }
   */
  function buildRequest(req, analysis, opts, indent, impersonate) {
    const notes = [];
    let cls = opts.requestClass || 'Request';
    if (!availableClasses(analysis.type).includes(cls)) cls = 'Request';

    // curl -d silently sends a form content type; a plain Request must say so explicitly.
    const implicitCt = cls === 'Request' ? (analysis.type === 'json' ? 'application/json' : req.contentType) : null;
    const headerEntries = buildHeaders(req, opts, DEFAULT_CT[cls], implicitCt);

    const vars = [];
    const kwargs = [['url', pyStr(req.url)]];
    const imports = { json: false };

    const defaultMethod = cls === 'Request' ? 'GET' : 'POST';
    if (req.method !== defaultMethod) kwargs.push(['method', pyStr(req.method)]);

    if (headerEntries.length) {
      vars.push(['headers', pyDict(headerEntries, indent)]);
      kwargs.push(['headers', 'headers']);
    }

    if (opts.cookiesAsDict !== false && req.cookies.length) {
      vars.push(['cookies', pyDict(req.cookies.map(([k, v]) => [k, pyStr(v)]), indent)]);
      kwargs.push(['cookies', 'cookies']);
    }

    if (analysis.type === 'form' && cls === 'FormRequest') {
      const entries = analysis.form.map(([k, vs]) => [k, vs.length === 1 ? pyStr(vs[0]) : '[' + vs.map(pyStr).join(', ') + ']']);
      vars.push(['formdata', pyDict(entries, indent)]);
      kwargs.push(['formdata', 'formdata']);
    } else if (analysis.type === 'json' && cls === 'JsonRequest') {
      vars.push(['payload', pyJson(analysis.json, indent)]);
      kwargs.push(['data', 'payload']);
    } else if (analysis.type === 'json') {
      vars.push(['payload', pyJson(analysis.json, indent)]);
      kwargs.push(['body', 'json.dumps(payload)']);
      imports.json = true;
    } else if (analysis.type === 'form' || analysis.type === 'raw') {
      vars.push(['body', pyStr(req.body)]);
      kwargs.push(['body', 'body']);
    } else if (analysis.type === 'multipart') {
      notes.push('multipart/form-data (-F) is not supported natively by Scrapy; the form fields are listed as a comment.');
    }

    const meta = [];
    if (req.proxy) meta.push(['proxy', pyStr(req.proxy)]);
    if (impersonate) meta.push(['impersonate', pyStr(impersonate)]);
    if (meta.length) kwargs.push(['meta', pyInlineDict(meta)]);

    if (cls === 'FormRequest' && req.method === 'GET') {
      notes.push('FormRequest with method GET puts formdata in the URL query string, not the body.');
    }

    return { cls, imports, vars, kwargs, notes };
  }

  function multipartComment(req, indent) {
    if (!req.forms.length) return '';
    return pad(indent) + '# TODO: multipart/form-data fields from curl -F:\n' +
      req.forms.map((f) => `${pad(indent)}#   ${f}`).join('\n') + '\n';
  }

  function expectsJson(req, analysis) {
    const accept = (req.headers.find(([k]) => k.toLowerCase() === 'accept') || [])[1] || '';
    return analysis.type === 'json' || /json/i.test(accept) || /\/api\/|\.json(\?|$)/i.test(req.url);
  }

  function generateShell(req, analysis, opts) {
    const b = buildRequest(req, analysis, opts, 0);
    const lines = ['# Start `scrapy shell`, then paste this:'];
    if (b.imports.json) lines.push('import json');
    lines.push(b.cls === 'JsonRequest' ? 'from scrapy.http import JsonRequest' : `from scrapy import ${b.cls}`);
    lines.push('');
    b.vars.forEach(([name, code]) => { lines.push(`${name} = ${code}`); lines.push(''); });
    const mp = multipartComment(req, 0);
    if (mp) lines.push(mp.trimEnd());
    lines.push('request = ' + pyCall(b.cls, b.kwargs, 0));
    lines.push('fetch(request)');
    lines.push('');
    if (expectsJson(req, analysis)) lines.push('# data = response.json()');
    else lines.push("# response.css('title::text').get()");
    const simpleGet = req.method === 'GET' && b.vars.length === 0 && !req.proxy;
    if (simpleGet) {
      lines.push('');
      lines.push('# Simple GET, so this also works straight from your terminal:');
      lines.push(`#   scrapy shell ${shellQuote(req.url)}`);
    }
    return { code: lines.join('\n') + '\n', cls: b.cls, notes: b.notes };
  }

  function shellQuote(s) {
    return /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
  }

  function impersonateTarget(opts) {
    return opts.impersonateTarget || 'chrome';
  }

  function generateSpider(req, analysis, opts) {
    const impersonate = opts.scrapyImpersonate ? impersonateTarget(opts) : null;
    const b = buildRequest(req, analysis, opts, 8, impersonate);
    const names = spiderNames(req.url);
    const callee = b.cls === 'JsonRequest' ? 'JsonRequest' : `scrapy.${b.cls}`;
    const kwargs = b.kwargs.concat([['callback', 'self.parse']]);
    if (opts.dontFilter) kwargs.push(['dont_filter', 'True']);

    const lines = [];
    if (impersonate) lines.push('# pip install scrapy-impersonate');
    if (b.imports.json) lines.push('import json', '');
    lines.push('import scrapy');
    if (b.cls === 'JsonRequest') lines.push('from scrapy.http import JsonRequest');
    lines.push('', '');
    lines.push(`class ${names.cls}(scrapy.Spider):`);
    lines.push(`    name = ${pyStr(names.name)}`);
    if (names.host) lines.push(`    allowed_domains = [${pyStr(names.host)}]`);
    if (impersonate) {
      lines.push('    custom_settings = {');
      lines.push("        # curl_cffi gives requests a real browser's TLS fingerprint.");
      lines.push("        'DOWNLOAD_HANDLERS': {");
      lines.push("            'http': 'scrapy_impersonate.ImpersonateDownloadHandler',");
      lines.push("            'https': 'scrapy_impersonate.ImpersonateDownloadHandler',");
      lines.push('        },');
      lines.push("        'TWISTED_REACTOR': 'twisted.internet.asyncioreactor.AsyncioSelectorReactor',");
      lines.push("        # Empty, so curl_cffi sends the User-Agent of the impersonated browser.");
      lines.push("        'USER_AGENT': '',");
      lines.push('    }');
    }
    lines.push('');
    // Scrapy 2.13 added start(); newer versions no longer call start_requests() on their own.
    if (opts.legacyStartRequests) {
      lines.push('    async def start(self):');
      lines.push('        for request in self.start_requests():');
      lines.push('            yield request');
      lines.push('');
      lines.push('    # Used directly by Scrapy < 2.13.');
      lines.push('    def start_requests(self):');
    } else {
      lines.push('    async def start(self):');
    }
    b.vars.forEach(([name, code]) => { lines.push(`        ${name} = ${code}`); lines.push(''); });
    const mp = multipartComment(req, 8);
    if (mp) lines.push(mp.trimEnd());
    lines.push('        yield ' + pyCall(callee, kwargs, 8));
    lines.push('');
    lines.push('    def parse(self, response):');
    if (expectsJson(req, analysis)) {
      lines.push('        data = response.json()');
      lines.push('        yield {');
      lines.push("            'url': response.url,");
      lines.push("            'data': data,");
      lines.push('        }');
    } else {
      lines.push('        yield {');
      lines.push("            'url': response.url,");
      lines.push("            'status': response.status,");
      lines.push("            'title': response.css('title::text').get(),");
      lines.push('        }');
    }
    return { code: lines.join('\n') + '\n', cls: b.cls, notes: b.notes, spiderName: names.name };
  }

  const CFFI_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

  function generateCurlCffi(req, analysis, opts) {
    const target = impersonateTarget(opts);
    const notes = [];
    const defaultCt = { json: 'application/json', form: 'application/x-www-form-urlencoded' }[analysis.type];
    const implicitCt = analysis.type === 'raw' ? req.contentType : null;
    const headerEntries = buildHeaders(req, opts, defaultCt, implicitCt);

    const vars = [];
    const kwargs = [];
    if (headerEntries.length) {
      vars.push(['headers', pyDict(headerEntries, 0)]);
      kwargs.push(['headers', 'headers']);
    }
    if (opts.cookiesAsDict !== false && req.cookies.length) {
      vars.push(['cookies', pyDict(req.cookies.map(([k, v]) => [k, pyStr(v)]), 0)]);
      kwargs.push(['cookies', 'cookies']);
    }
    if (analysis.type === 'json') {
      vars.push(['json_data', pyJson(analysis.json, 0)]);
      kwargs.push(['json', 'json_data']);
    } else if (analysis.type === 'form') {
      // curl_cffi stringifies list values in a dict, so repeated keys need (key, value) pairs.
      const repeated = analysis.form.some(([, vs]) => vs.length > 1);
      const code = repeated
        ? '[\n' + analysis.form.flatMap(([k, vs]) => vs.map((v) => `    (${pyStr(k)}, ${pyStr(v)}),`)).join('\n') + '\n]'
        : pyDict(analysis.form.map(([k, vs]) => [k, pyStr(vs[0])]), 0);
      vars.push(['data', code]);
      kwargs.push(['data', 'data']);
    } else if (analysis.type === 'raw') {
      vars.push(['data', pyStr(req.body)]);
      kwargs.push(['data', 'data']);
    } else if (analysis.type === 'multipart') {
      notes.push('curl_cffi: multipart fields are listed as a comment; build them with curl_cffi.CurlMime.');
    }
    if (req.proxy) kwargs.push(['proxy', pyStr(req.proxy)]);
    kwargs.push(['impersonate', pyStr(target)]);

    const lines = ['# pip install curl_cffi', 'from curl_cffi import requests', ''];
    vars.forEach(([name, code]) => { lines.push(`${name} = ${code}`); lines.push(''); });
    const mp = multipartComment(req, 0);
    if (mp) lines.push(mp.trimEnd());
    const callee = CFFI_METHODS.has(req.method) ? `requests.${req.method.toLowerCase()}` : 'requests.request';
    const args = (callee === 'requests.request' ? [pyStr(req.method)] : []).concat(pyStr(req.url));
    lines.push(`response = ${callee}(`);
    args.forEach((a) => lines.push(`    ${a},`));
    kwargs.forEach(([k, v]) => lines.push(`    ${k}=${v},`));
    lines.push(')');
    lines.push('print(response.status_code)');
    lines.push(expectsJson(req, analysis) ? 'print(response.json())' : 'print(response.text[:500])');
    return { code: lines.join('\n') + '\n', notes };
  }

  // A copied User-Agent wins over the one curl_cffi would send; flag obvious mismatches.
  function userAgentNote(req, opts) {
    const ua = (req.headers.find(([k]) => k.toLowerCase() === 'user-agent') || [])[1];
    if (!ua) return null;
    const target = impersonateTarget(opts);
    const family = target.replace(/[\d_].*$/, '');
    const matches = {
      chrome: /Chrome\//.test(ua) && !/Edg\//.test(ua),
      edge: /Edg\//.test(ua),
      firefox: /Firefox\//.test(ua),
      tor: /Firefox\//.test(ua),
      safari: /Safari\//.test(ua) && !/Chrome\//.test(ua),
    }[family];
    if (matches !== false) return null;
    return `The copied User-Agent doesn't look like ${family}, but it overrides the one curl_cffi sends for impersonate='${target}'. Remove it, or impersonate the browser it came from.`;
  }

  /**
   * Convert a curl command into Scrapy shell + spider code, plus a curl_cffi snippet.
   * @param {string} curl
   * @param {{requestClass?: 'Request'|'FormRequest'|'JsonRequest', cookiesAsDict?: boolean,
   *          dropManagedHeaders?: boolean, legacyStartRequests?: boolean, dontFilter?: boolean,
   *          scrapyImpersonate?: boolean, impersonateTarget?: string}} [opts]
   */
  function convert(curl, opts) {
    opts = opts || {};
    const req = parseCurl(curl);
    const analysis = analyze(req);
    const shell = generateShell(req, analysis, opts);
    const spider = generateSpider(req, analysis, opts);
    const cffi = generateCurlCffi(req, analysis, opts);
    const uaNote = userAgentNote(req, opts);
    return {
      request: req,
      bodyType: analysis.type,
      availableClasses: availableClasses(analysis.type),
      requestClass: shell.cls,
      shell: shell.code,
      spider: spider.code,
      spiderName: spider.spiderName,
      curlCffi: cffi.code,
      warnings: req.warnings.concat(shell.notes, cffi.notes, uaNote ? [uaNote] : []),
    };
  }

  return { tokenize, parseCurl, parseJson, analyze, pyStr, convert };
});
