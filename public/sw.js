// Intercepta qualquer tentativa de chamar o explorer direto e redireciona ao proxy local
self.addEventListener('fetch', event => {
  try{
    const url = new URL(event.request.url);
    const m = url.hostname === 'scan.pulsechain.com'
      ? url.pathname.match(/\/api\/v2\/addresses\/(0x[a-fA-F0-9]{40})\/?$/i)
      : null;
    if(m){
      const proxied = '/api/explorer/addresses/' + m[1];
      event.respondWith(fetch(proxied, { headers: { accept: 'application/json' } }));
      return;
    }
  }catch(_){}
  // default
});

