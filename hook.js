(function() {
  if (window.__moaHooksInjected) return;
  window.__moaHooksInjected = true;

  const _fetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = (typeof input === 'string' ? input : input?.url) || '';
    const resp = await _fetch.apply(this, arguments);
    
    if (url.includes('/api/boot/mdirect') || url.includes('/api/mdirect/warehouse') || url.includes('/api/mdirect/seller')) {
      try {
        resp.clone().json().then(json => {
          window.postMessage({ source: 'moa-hook', type: 'API_JSON', url: url, json: json }, '*');
        }).catch(() => {});
      } catch(e) {}
    }
    return resp;
  };

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, url) {
    this.__moaUrl = url || '';
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', () => {
      if ((this.__moaUrl || '').includes('/api/boot/mdirect') || (this.__moaUrl || '').includes('/api/mdirect/warehouse') || (this.__moaUrl || '').includes('/api/mdirect/seller')) {
        try {
          const json = JSON.parse(this.responseText);
          window.postMessage({ source: 'moa-hook', type: 'API_JSON', url: this.__moaUrl, json: json }, '*');
        } catch(e) {}
      }
    });
    return _send.apply(this, arguments);
  };
})();
