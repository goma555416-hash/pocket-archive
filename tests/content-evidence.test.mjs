import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntry, createInboxEnvelope, readOrganized } from '../lib.mjs';
import { extractArticleText, publicArticleTarget, publicIPv4, collectArticleEvidence } from '../codex-article-reader.mjs';

const at='2026-10-23T14:00:00.000Z';
const url='https://example.org/article';
const entry=createEntry({url,title:'Public article',note:''});
const exportId='export-content-test';
const base={format:'pocket-archive-organized',schema_version:2,source_export_id:exportId};
const e=(status,kind,excerpt,extra={})=>({status,kind,excerpt,source_url:entry.url,observed_at:at,...extra});
const parse=(row,records=[entry])=>readOrganized({ ...base,items:[row] },{exportIds:[exportId],entries:records});
const row=(receipt,status='completed',tags=['排版'],confidence='medium')=>({
 id:entry.id,analysis_status:status,suggested_categories:[],
 suggested_tags:tags,summary:status==='completed'?'根據已讀文章，討論排版和介面視覺層級。':'',
 reason:'來源證據',confidence,evidence:receipt
});

test('actual article body receipt allows content-supported tags and retains excerpt',()=>{
 const text='文章逐段討論排版、視覺閱讀順序以及不同版面密度如何影響使用者的閱讀體驗，提供了具體的設計案例與改善建議。'.repeat(3);
 const result=parse(row(e('content_read','article_body',text)));
 assert.equal(result.accepted.length,1);
 assert.equal(result.rejected.length,0);
 assert.equal(result.accepted[0].evidence.status,'content_read');
 assert.equal(result.accepted[0].tags[0],'排版');
});

test('metadata-only result cannot silently claim completed/high-confidence content tags',()=>{
 const metadata=e('metadata_only','metadata','');
 const result=parse(row(metadata));
 assert.equal(result.accepted.length,0);
 assert.match(result.rejected[0].reason,/只取得標題|不得輸出/);
 const low=parse(row(metadata,'insufficient_data',[],'low'));
 assert.equal(low.accepted[0].analysisStatus,'insufficient_data');
 assert.equal(low.accepted[0].evidence.status,'metadata_only');
});

test('untrusted or mismatched evidence rejected (no invented article or stolen image)',()=>{
 const text='This real article text is long enough to be recognizable as a content excerpt. '.repeat(3);
 for(const receipt of [
 e('content_read','article_body',text,{source_url:'https://evil.example/page'}),
 e('content_read','article_body','too short'),
 e('content_read','user_share_text',text),
 e('image_read','attached_image',text,{attachment_sha256:'a'.repeat(64)}),
 e('blocked','metadata','',{}),
 e('content_read','article_body',text,{observed_at:'not-a-date'})
 ]) {
 const result=parse(row(receipt));
 assert.equal(result.accepted.length,0,receipt.kind);
 }
});

test('actual shared user text is constrained to the original note, never guessed',()=>{
 const text='這段分享文字是使用者在收藏時明確貼上的原始內容，可以作為分類依據，然而仍應註明它不是平台自行取得的正文。';
 const withNote=createEntry({url, note:text});
 const evidence={status:'content_read',kind:'user_share_text',excerpt:text,source_url:withNote.url,observed_at:at};
 const answer={ ...row(evidence),id:withNote.id};
 assert.equal(parse(answer,[withNote]).accepted.length,1);
 assert.equal(parse(answer).rejected.length,1);
});

test('image receipt is bound to original attachment hash',()=>{
 const image=createEntry({url, title:'Saved screenshot'});
 const im={...image,id:'image1',kind:'image',url:'',attachment:{hash:'c'.repeat(64)}};
 const evidence={status:'image_read',kind:'attached_image',excerpt:'圖片內容為具有明確排版資訊與多層次細節的介面設計參考。',source_url:'',observed_at:at,attachment_sha256:im.attachment.hash};
 const good={...row(evidence),id:'image1'};
 assert.equal(parse(good,[im]).accepted.length,1);
 assert.equal(parse({...good,evidence:{...evidence,attachment_sha256:'d'.repeat(64)}},[im]).rejected.length,1);
});

test('legacy schema-v2 organized results stay importable but never claim verified evidence',()=>{
 const result=parse({...row(undefined),evidence:undefined});
 assert.equal(result.accepted[0].evidence.status,'legacy_unverified');
 const inbox=createInboxEnvelope([entry],exportId);
 assert.equal(inbox.schema_version,2);
});

test('only safe public article targets are eligible for background HTTP acquisition',()=>{
 for(const u of [
 'http://public.example.org/article','https://127.0.0.1/secrets',
 'https://[::1]/private','https://localhost/secrets','https://server.local/',
 'https://admin:token@news.example.org/article',
 'https://youtube.com/watch?v=dQw4w9WgXcQ',
 'https://www.threads.net/@user/post/xyz',
 'https://example.com:8443/a'
 ]) assert.equal(publicArticleTarget(u),null,u);
 assert.equal(publicArticleTarget('https://www.theguardian.com/design/article')?.protocol,'https:');
 for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','172.31.0.1','169.254.169.254','100.64.0.1','8.8.8.8']) {
   assert.equal(publicIPv4(ip),ip==='8.8.8.8',ip);
 }
 assert.equal(publicIPv4('::ffff:127.0.0.1'),false);
});

test('article extractor does not classify page title, dynamic placeholder or script as content',()=>{
 assert.equal(extractArticleText('<title>Beautiful wallpaper</title><p>Subscribe now</p>'),'');
 assert.equal(extractArticleText('<main><h1>Title</h1><p>Please sign in.</p></main>'),'');
 const paragraph='The author compares typography weights and visual hierarchy using concrete design examples. '.repeat(4);
 const html='<html><head><title>Tempting title</title></head><body><main><nav>unrelated</nav><article><p>'+paragraph+'</p><script>bad script</script></article></main></body></html>';
 const text=extractArticleText(html);
 assert.ok(text.includes('visual hierarchy'));
 assert.equal(text.includes('bad script'),false);
});

test('synthetic article fetch creates readable receipt; blocked and social remain unavailable',async()=>{
 const text='Article content about presentation design and its coherent visual structure. '.repeat(4);
 const fetched=await collectArticleEvidence({url:'https://www.somepublicsite.org/article'},{
   fetchHtml:async target=>'<main><p>'+text+'</p></main>',observedAt:()=>at
 });
 assert.equal(fetched.status,'content_read');
 assert.equal(fetched.kind,'article_body');
 assert.ok(fetched.excerpt.length>80);
 const blocked=await collectArticleEvidence({url:'https://www.somepublicsite.org/article'},{
   fetchHtml:async()=>{throw Object.assign(new Error('private'),{code:'auth_required'});},observedAt:()=>at
 });
 assert.equal(blocked.status,'auth_required');
 const social=await collectArticleEvidence({url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},{
   fetchHtml:async()=>{throw new Error('must not fetch social content');},observedAt:()=>at
 });
 assert.equal(social.status,'unavailable');
});
