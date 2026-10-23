// Node-only, user-invoked public article retrieval for Codex. No Worker proxy,
// cookies or redirects; addresses checked at socket lookup to prevent DNS rebinding.
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
const SOCIAL = new Set(['youtube.com','youtu.be','tiktok.com','instagram.com','threads.com','threads.net','x.com','twitter.com','facebook.com','pinterest.com','pin.it']);
const MAX_BYTES = 1048576;
const failure = code => Object.assign(new Error(code), { code });
const socialHost = host => [...SOCIAL].some(d => host === d || host.endsWith('.' + d));

export function publicArticleTarget(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.href.length > 2048 || isIP(url.hostname) || !url.hostname.includes('.') ||
      /\.(local|internal|localhost|test|example|invalid)$/i.test(url.hostname) ||
      socialHost(url.hostname.toLowerCase())) return null;
  url.hash = '';
  return url;
}

export function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 ||
    (a===100 && b>=64 && b<=127) || (a===169 && b===254) ||
    (a===172 && b>=16 && b<=31) ||
    (a===192 && (b===168 || b===0 || (b===88 && c===99) || (b===0 && c===2))) ||
    (a===198 && (b===18 || b===19 || (b===51 && c===100))) ||
    (a===203 && b===0 && c===113));
}

const entity = text => text
  .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_,v) => {
    const n = v[0].toLowerCase()==='x' ? parseInt(v.slice(1),16) : Number(v);
    return n>0 && n<=0x10ffff && !(n>=0xd800&&n<=0xdfff) ? String.fromCodePoint(n) : ' ';
  })
  .replace(/&(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash);/gi, (whole,v) =>
    ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…',mdash:'—',ndash:'–'})[v.toLowerCase()]||whole);

export function extractArticleText(html) {
  if (typeof html !== 'string' || html.length > MAX_BYTES) return '';
  // Require an actual main/article region. Do not mistake title/embed for body.
  const article = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(html);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html);
  const selected = article?.[1] || main?.[1] || '';
  if (!selected) return '';
  const clean = selected
    .replace(/<!--[\s\S]*?-->/g,' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote)>/gi,'\n')
    .replace(/<[^>]+>/g,' ');
  const text = entity(clean).replace(/\s+/g,' ').trim();
  return text.length >= 120 ? text : '';
}

export async function fetchPublicArticleHtml(raw, { lookupImpl=dns.lookup, timeoutMs=8000 }={}) {
  const url=publicArticleTarget(raw);
  if (!url) throw failure('blocked_target');
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{
      method:'GET',agent:false,timeout:timeoutMs,
      headers:{Accept:'text/html','Accept-Encoding':'identity','User-Agent':'PocketArchiveCodexEvidence/1.0'},
      lookup(host,options,callback) {
        lookupImpl(host,{family:4,all:false},(err,address)=>{
          if(err) return callback(err);
          if(!publicIPv4(address)) return callback(failure('blocked_address'));
          callback(null,address,4);
        });
      }
    },res=>{
      const status=res.statusCode||0;
      if(status>=300 && status<400){res.destroy();reject(failure('redirect_blocked'));return;}
      if(status===401||status===403){res.destroy();reject(failure('auth_required'));return;}
      if(status!==200){res.destroy();reject(failure('unavailable'));return;}
      if(!/^text\/html\b/i.test(String(res.headers['content-type']||''))){
        res.destroy();reject(failure('not_html'));return;
      }
      const chunks=[];let n=0;
      res.on('data',buf=>{
        n+=buf.length;
        if(n>MAX_BYTES){res.destroy(failure('too_large'));return;}
        chunks.push(buf);
      });
      res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(failure('timeout')));
    req.on('error',reject);req.end();
  });
}

export async function collectArticleEvidence(item,{ fetchHtml=fetchPublicArticleHtml,
  observedAt=()=>new Date().toISOString() }={}) {
  const url=item.url||'', stamp=observedAt(), target=publicArticleTarget(url);
  if(!target) return {status:'unavailable',kind:'metadata',excerpt:'',source_url:url,observed_at:stamp,reason:'unsupported_or_private_url'};
  try {
    const text=extractArticleText(await fetchHtml(target.href));
    if(text) return {status:'content_read',kind:'article_body',excerpt:text.slice(0,900),source_url:url,observed_at:stamp,text_chars:text.length,reason:'article_html'};
    return {status:'metadata_only',kind:'metadata',excerpt:'',source_url:url,observed_at:stamp,reason:'no_readable_body'};
  } catch(e) {
    const status=e?.code==='auth_required'?'auth_required':['blocked_target','blocked_address','redirect_blocked'].includes(e?.code)?'blocked':'unavailable';
    return {status,kind:'metadata',excerpt:'',source_url:url,observed_at:stamp,reason:String(e?.code||'network_error').slice(0,80)};
  }
}
