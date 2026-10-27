(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const input = $('curl-input');
  const outShell = $('out-shell');
  const outSpider = $('out-spider');
  const status = $('status');
  const picker = $('class-picker');
  const hint = $('class-hint');

  const EXAMPLES = {
    get: `curl 'https://quotes.toscrape.com/page/2/' \\
  -H 'accept: text/html,application/xhtml+xml' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'referer: https://quotes.toscrape.com/' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' \\
  -b 'session=abc123; consent=yes' \\
  --compressed`,
    form: `curl 'https://quotes.toscrape.com/login' \\
  -H 'content-type: application/x-www-form-urlencoded' \\
  -H 'origin: https://quotes.toscrape.com' \\
  -b 'session=abc123' \\
  --data-raw 'csrf_token=XyZ123&username=admin&password=admin'`,
    json: `curl 'https://api.example.com/v2/search' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer eyJhbGciOi...' \\
  -H 'content-type: application/json' \\
  --data-raw '{"query":"laptops","page":1,"filters":{"brand":["acme","globex"],"in_stock":true},"id":12345678901234567890}'`,
    cmd: `curl ^"https://quotes.toscrape.com/api/quotes?page=1^" ^
  -H ^"accept: application/json, text/javascript, */*; q=0.01^" ^
  -H ^"x-requested-with: XMLHttpRequest^" ^
  -H ^"user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)^"`,
  };

  const OPTION_IDS = ['opt-cookies', 'opt-managed', 'opt-async', 'opt-dontfilter'];
  const STORE_KEY = 'curl-to-scrapy:options';

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      OPTION_IDS.forEach((id) => { if (id in saved) $(id).checked = !!saved[id]; });
    } catch (e) { /* storage unavailable */ }
  }

  function savePrefs() {
    try {
      const data = {};
      OPTION_IDS.forEach((id) => { data[id] = $(id).checked; });
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) { /* storage unavailable */ }
  }

  // Remember which class the user wants per body type, so switching examples keeps intent.
  const preferredClass = { form: 'FormRequest', json: 'Request' };

  function selectedClass() {
    const el = document.querySelector('input[name="cls"]:checked');
    return el ? el.value : 'Request';
  }

  function configurePicker(bodyType, available) {
    const showPicker = bodyType === 'form' || bodyType === 'json';
    picker.hidden = !showPicker;
    document.querySelectorAll('input[name="cls"]').forEach((r) => {
      const label = r.closest('label');
      const ok = available.includes(r.value);
      label.hidden = !ok;
      r.disabled = !ok;
    });
    if (!showPicker) return 'Request';
    let cls = preferredClass[bodyType];
    if (!available.includes(cls)) cls = 'Request';
    document.querySelector(`input[name="cls"][value="${cls}"]`).checked = true;
    hint.textContent = bodyType === 'form'
      ? 'Form body detected. FormRequest gives you an editable formdata dict; Request sends the body byte-for-byte.'
      : 'JSON body detected. JsonRequest serialises the payload for you; Request uses json.dumps(payload).';
    return cls;
  }

  let lastBodyType = null;

  function render() {
    const text = input.value.trim();
    if (!text) {
      outShell.innerHTML = '<span class="placeholder">Scrapy shell code appears here.</span>';
      outSpider.innerHTML = '<span class="placeholder">Spider code appears here.</span>';
      $('spider-file').textContent = '';
      picker.hidden = true;
      setStatus('', '');
      lastBodyType = null;
      return;
    }

    const opts = {
      cookiesAsDict: $('opt-cookies').checked,
      dropManagedHeaders: $('opt-managed').checked,
      asyncStart: $('opt-async').checked,
      dontFilter: $('opt-dontfilter').checked,
      requestClass: selectedClass(),
    };

    try {
      // First pass tells us the body type so the class picker can be set up.
      const probe = CurlToScrapy.convert(text, opts);
      if (probe.bodyType !== lastBodyType) {
        opts.requestClass = configurePicker(probe.bodyType, probe.availableClasses);
        lastBodyType = probe.bodyType;
      }
      const result = opts.requestClass === probe.requestClass ? probe : CurlToScrapy.convert(text, opts);

      outShell.innerHTML = highlight(result.shell);
      outSpider.innerHTML = highlight(result.spider);
      $('spider-file').textContent = `spiders/${result.spiderName}.py`;

      const r = result.request;
      const summary = `${r.method} ${r.url}` + (result.bodyType !== 'none' ? ` · ${result.bodyType} body` : '');
      if (result.warnings.length) setStatus('warn', summary, result.warnings);
      else setStatus('ok', summary);
    } catch (err) {
      setStatus('error', err.message);
    }
  }

  function setStatus(kind, message, list) {
    status.className = 'status' + (kind ? ' ' + kind : '');
    status.textContent = '';
    if (!message) return;
    const p = document.createElement('p');
    p.textContent = message;
    status.appendChild(p);
    if (list && list.length) {
      const ul = document.createElement('ul');
      list.forEach((w) => {
        const li = document.createElement('li');
        li.textContent = w;
        ul.appendChild(li);
      });
      status.appendChild(ul);
    }
  }

  // Minimal Python highlighter: enough for the code we generate.
  const KEYWORDS = new Set(['import', 'from', 'class', 'def', 'async', 'await', 'yield', 'return', 'for', 'in', 'if', 'else', 'with', 'as']);
  const CONSTANTS = new Set(['True', 'False', 'None', 'self']);

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlight(code) {
    const re = /(#[^\n]*)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(\b\d[\d.eE+-]*\b)|([A-Za-z_]\w*)/g;
    let out = '';
    let last = 0;
    let m;
    let prevWord = '';
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      last = re.lastIndex;
      const [tok, comment, str, num, word] = m;
      if (comment) out += `<span class="tk-c">${esc(tok)}</span>`;
      else if (str) out += `<span class="tk-s">${esc(tok)}</span>`;
      else if (num) out += `<span class="tk-n">${esc(tok)}</span>`;
      else if (word) {
        if (KEYWORDS.has(word)) out += `<span class="tk-k">${word}</span>`;
        else if (CONSTANTS.has(word)) out += `<span class="tk-b">${word}</span>`;
        else if (prevWord === 'class' || prevWord === 'def') out += `<span class="tk-f">${word}</span>`;
        else if (/^[A-Z]/.test(word) || word === 'fetch') out += `<span class="tk-t">${word}</span>`;
        else out += word;
        prevWord = word;
        continue;
      }
      prevWord = '';
    }
    return out + esc(code.slice(last));
  }

  function debounce(fn, ms) {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  input.addEventListener('input', debounce(render, 120));

  document.querySelectorAll('input[name="cls"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (lastBodyType) preferredClass[lastBodyType] = r.value;
      render();
    });
  });

  OPTION_IDS.forEach((id) => $(id).addEventListener('change', () => { savePrefs(); render(); }));

  $('examples').addEventListener('change', (e) => {
    const key = e.target.value;
    if (!key) return;
    input.value = EXAMPLES[key];
    e.target.value = '';
    render();
  });

  $('clear').addEventListener('click', () => {
    input.value = '';
    render();
    input.focus();
  });

  document.querySelectorAll('.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = $(btn.dataset.target);
      if (code.querySelector('.placeholder')) return;
      const text = code.textContent;
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1400);
    });
  });

  loadPrefs();
  render();
})();
