// Node-only, user-invoked public article retrieval for the executing agent. No
// Worker proxy, cookies or redirects; addresses checked at socket lookup to
// prevent DNS rebinding. In the Claude cloud sandbox all egress goes through
// an HTTPS proxy (HTTPS_PROXY), which Node's https module ignores, so there we
// fetch through curl instead. Behind that proxy the agent cannot reach any
// private network, so the local DNS check is replaced by the URL checks in
// publicArticleTarget plus curl's https-only, no-redirect, size/time limits.
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
const SOCIAL = new Set(['youtube.com','youtu.be','tiktok.com','instagram.com','threads.com','threads.net','x.com','twitter.com','facebook.com','pinterest.com','pin.it']);
const MAX_BYTES = 1048576;
const failure = (code, extra={}) => Object.assign(new Error(code), { code, ...extra });
const MAX_REDIRECTS = 3;
const CAPTCHA_PATH = /captcha|verify|challenge/i;
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

// Node 20+ (autoSelectFamily) calls a custom lookup with { all: true } and
// expects an address list; older paths expect (address, family). Every
// resolved IPv4 address must be public, otherwise the connection is refused.
export function guardedLookup(lookupImpl=dns.lookup) {
  return (host,options,callback)=>{
    const wantAll=Boolean(options && options.all);
    lookupImpl(host,{family:4,all:true},(err,addresses)=>{
      if(err) return callback(err);
      const list=(Array.isArray(addresses)?addresses:[{address:addresses,family:4}])
        .filter(a=>a && isIP(a.address)===4);
      if(!list.length || list.some(a=>!publicIPv4(a.address))) return callback(failure('blocked_address'));
      if(wantAll) return callback(null,list.map(a=>({address:a.address,family:4})));
      callback(null,list[0].address,4);
    });
  };
}

const proxyConfigured = env => Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
export function articleTransport(env=process.env) { return proxyConfigured(env) ? 'curl' : 'direct'; }

const META = '\n__PA_ARTICLE_META__';
export function articleCurlArgs(url, { timeoutMs=8000, allowHttpForTest=false, env=process.env }={}) {
  return ['-sS','--proto',allowHttpForTest?'=https,http':'=https','--max-redirs','0',
    ...(env.CURL_CA_BUNDLE ? ['--cacert', env.CURL_CA_BUNDLE] : []),
    '--max-time',String(Math.ceil(timeoutMs/1000)),'--max-filesize',String(MAX_BYTES),
    '-H','Accept: text/html','-H','Accept-Encoding: identity','-H','User-Agent: PocketArchiveCodexEvidence/1.0',
    '-o','-','-w',META+'%{http_code}\t%{redirect_url}\t%{content_type}',url];
}

export function curlArticleHtml(url, { timeoutMs=8000, allowHttpForTest=false }={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('curl',articleCurlArgs(url,{timeoutMs,allowHttpForTest}),{stdio:['ignore','pipe','pipe']});
    const chunks=[];let n=0;let tooLarge=false;
    child.stdout.on('data',buf=>{
      n+=buf.length;
      if(n>MAX_BYTES+512){tooLarge=true;child.kill();return;}
      chunks.push(buf);
    });
    child.stderr.resume();
    child.on('error',()=>reject(failure('unavailable')));
    child.on('close',code=>{
      if(tooLarge) return reject(failure('too_large'));
      if(code===28) return reject(failure('timeout'));
      if(code===63) return reject(failure('too_large'));
      const buffer=Buffer.concat(chunks);
      const at=buffer.lastIndexOf(Buffer.from(META));
      if(code!==0 || at<0) return reject(failure('unavailable'));
      const [statusText='',location='',type='']=buffer.subarray(at+META.length).toString().trim().split('\t');
      const status=Number(statusText);
      if(status>=300 && status<400) return reject(failure('redirect_blocked',{location}));
      if(status===401||status===403) return reject(failure('auth_required'));
      if(status!==200) return reject(failure('unavailable'));
      if(!/^text\/html\b/i.test(type)) return reject(failure('not_html'));
      resolve(buffer.subarray(0,at).toString('utf8'));
    });
  });
}

// Follows at most MAX_REDIRECTS redirects, only within the same host and
// always over https (an http Location on the same host is upgraded). Every hop
// is re-validated. A redirect to a captcha/verification page is never followed.
export async function fetchPublicArticleHtml(raw, { lookupImpl=dns.lookup, timeoutMs=8000, env=process.env, fetchOnce }={}) {
  let url=publicArticleTarget(raw);
  if (!url) throw failure('blocked_target');
  const host=url.hostname.toLowerCase();
  const once=fetchOnce || (href=>articleTransport(env)==='curl' ? curlArticleHtml(href,{timeoutMs}) : directArticleHtml(href,{lookupImpl,timeoutMs}));
  for (let hop=0; ; hop++) {
    try { return await once(url.href); }
    catch (error) {
      if (error?.code!=='redirect_blocked' || !error.location) throw error;
      let next;
      try { next=new URL(error.location, url); } catch { throw failure('redirect_blocked'); }
      if (CAPTCHA_PATH.test(next.pathname)) throw failure('captcha_required');
      if (next.hostname.toLowerCase()!==host || hop>=MAX_REDIRECTS) throw failure('redirect_blocked');
      if (next.protocol==='http:') next.protocol='https:';
      const checked=publicArticleTarget(next.href);
      if (!checked) throw failure('redirect_blocked');
      url=checked;
    }
  }
}

function directArticleHtml(url, { lookupImpl, timeoutMs }) {
  return new Promise((resolve,reject)=>{
    const req=https.request(url,{
      method:'GET',agent:false,timeout:timeoutMs,
      headers:{Accept:'text/html','Accept-Encoding':'identity','User-Agent':'PocketArchiveCodexEvidence/1.0'},
      lookup:guardedLookup(lookupImpl)
    },res=>{
      const status=res.statusCode||0;
      if(status>=300 && status<400){res.destroy();reject(failure('redirect_blocked',{location:String(res.headers.location||'')}));return;}
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
    const status=['auth_required','captcha_required'].includes(e?.code)?'auth_required':['blocked_target','blocked_address','redirect_blocked'].includes(e?.code)?'blocked':'unavailable';
    return {status,kind:'metadata',excerpt:'',source_url:url,observed_at:stamp,reason:String(e?.code||'network_error').slice(0,80)};
  }
}
