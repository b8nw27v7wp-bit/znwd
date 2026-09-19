import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/session/store.ts';
import { RateLimiter } from '../src/http/rateLimit.ts';
import { LruCache, answerCacheKey, adminOk, JsonlStore } from '../src/http/cache.ts';
import { adminTokenRequired, errorPayload, messageLogFields, hashStr } from '../src/http/errors.ts';
import { expandQueryText } from '../src/knowledge/synonyms.ts';
import { buildGroundedAnswer } from '../src/llm/grounded.ts';
import { MockChatModel } from '../src/llm/mock.ts';
import { HybridRetriever } from '../src/knowledge/hybridRetriever.ts';
import { VectorStore } from '../src/knowledge/vectorStore.ts';
import { runChat, streamChat } from '../src/rag/runChat.ts';
import { parseChatInput, normalizeSessionId, validationMessage } from '../src/http/request.ts';
import { decideOrigin, resolveCorsOrigins, corsHeadersFor } from '../src/http/cors.ts';
import { chunkText } from '../src/knowledge/loader.ts';
import { Retriever } from '../src/knowledge/retriever.ts';
import { rewriteForRetrieval } from '../src/rag/rewrite.ts';
import { readState, writeState } from '../src/state/persist.ts';
import type { EmbeddingProvider } from '../src/embedding/types.ts';
import type { KnowledgeChunk } from '../src/knowledge/loader.ts';
import { Analytics } from '../src/analytics/stats.ts';

test('SessionStore append/peek/reset', () => {
  const s = new SessionStore();
  s.append('a', '你好', '您好');
  const h = s.peek('a');
  assert.ok(h);
  assert.equal(h.messages.length, 2);
  assert.equal(s.reset('a'), true);
  assert.equal(s.peek('a'), null);
});

test('SessionStore history without id', () => {
  const s = new SessionStore();
  assert.deepEqual(s.history(undefined), []);
});

test('RateLimiter blocks after limit', () => {
  const r = new RateLimiter(2, 60_000);
  assert.equal(r.allow('ip'), null);
  assert.equal(r.allow('ip'), null);
  const wait = r.allow('ip');
  assert.ok(wait !== null && wait >= 1);
});

test('LruCache evicts oldest', () => {
  const c = new LruCache<number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.size, 2);
});

test('adminOk open when no token; closed when set', () => {
  assert.equal(adminOk(undefined, undefined), true);
  assert.equal(adminOk(undefined, 'secret'), false);
  assert.equal(adminOk('Bearer secret', 'secret'), true);
  assert.equal(adminOk('secret', 'secret'), true);
});

test('adminOk requireToken rejects missing token', () => {
  assert.equal(adminOk(undefined, undefined, { requireToken: true }), false);
  assert.equal(adminOk('Bearer secret', 'secret', { requireToken: true }), true);
  assert.equal(adminOk(undefined, undefined, { requireToken: false }), true);
  assert.equal(adminOk('Bearer wrong', 'secret', { requireToken: true }), false);
});

test('adminTokenRequired by NODE_ENV / flag', () => {
  assert.equal(adminTokenRequired({} as NodeJS.ProcessEnv), false);
  assert.equal(adminTokenRequired({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), false);
  assert.equal(adminTokenRequired({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), true);
  assert.equal(adminTokenRequired({ NODE_ENV: 'staging' } as NodeJS.ProcessEnv), true);
  assert.equal(adminTokenRequired({ REQUIRE_ADMIN_TOKEN: 'true' } as NodeJS.ProcessEnv), true);
  assert.equal(adminTokenRequired({ REQUIRE_ADMIN_TOKEN: '1' } as NodeJS.ProcessEnv), true);
});

test('errorPayload shape has no stack', () => {
  const body = errorPayload('internal_error', '服务内部错误', 'req-1');
  assert.equal(body.error, 'internal_error');
  assert.equal(body.message, '服务内部错误');
  assert.equal(body.requestId, 'req-1');
  assert.ok(!JSON.stringify(body).includes('Error:'));
});

test('messageLogFields hash mode hides full message', () => {
  const long = '这是一个很长的机密问题'.repeat(20);
  const f = messageLogFields(long, 'hash');
  assert.ok(f.messagePreview);
  assert.ok(!f.messagePreview!.includes(long));
  assert.ok(f.messagePreview!.includes(String(long.length)));
  const p = messageLogFields(long, 'preview');
  assert.equal(p.messagePreview, long.slice(0, 80));
  assert.ok(hashStr('a') === hashStr('a'));
});

test('JsonlStore hash sanitize + flush + rotate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-jsonl-'));
  const store = new JsonlStore(dir, 'events', { maxBytes: 200, messageMode: 'hash' });
  const secret = '完整敏感问题'.repeat(30);
  store.append({ type: 'chat', message: secret, answerPreview: 'ans' });
  await store.flush();
  const raw = await readFile(store.path, 'utf8');
  assert.ok(raw.length > 0);
  assert.ok(!raw.includes(secret));
  assert.ok(raw.includes('messagePreview'));
  // force rotate
  for (let i = 0; i < 8; i++) {
    store.append({ type: 'chat', message: 'x'.repeat(80) });
  }
  await store.flush();
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith('events.') && f !== 'events.jsonl'));
});

test('HybridRetriever generation increments on replace', async () => {
  const bag: EmbeddingProvider = {
    name: 'bag-test',
    dims: 8,
    semantic: false,
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = new Array(8).fill(0);
        for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) % 17;
        return v;
      });
    },
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-vec-'));
  const store = new VectorStore(bag, path.join(dir, 'v.json'));
  const r = new HybridRetriever(store);
  assert.equal(r.generation(), 0);
  const mk = (id: string, text: string): KnowledgeChunk => ({
    id,
    title: id,
    sourcePath: id + '.md',
    text,
    zone: 'z',
    zoneTitle: 'Z',
    tags: [],
  });
  await r.replace([mk('a', '光伏清洁无人机 航线作业')]);
  assert.equal(r.generation(), 1);
  assert.equal(r.list().length, 1);
  const genBefore = r.generation();
  const listBefore = r.list().map((c) => c.id);
  const p1 = r.replace([mk('b', '风场检测 停机')]);
  const p2 = r.replace([mk('c', '服务合作')]);
  await Promise.all([p1, p2]);
  assert.equal(r.generation(), genBefore + 2);
  const ids = r.list().map((c) => c.id);
  assert.ok(!ids.includes(listBefore[0]!));
  assert.ok(ids.includes('c'));
  assert.equal(r.stats().generation, r.generation());
});

test('runChat mock path returns answer and writes session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-run-'));
  const bag: EmbeddingProvider = {
    name: 'bag-test',
    dims: 2,
    semantic: false,
    async embed(texts: string[]) {
      return texts.map(() => [0, 0]);
    },
  };
  const vstore = new VectorStore(bag, path.join(dir, 'v.json'));
  const retriever = new HybridRetriever(vstore);
  await retriever.replace([]);
  const sessions = new SessionStore();
  const answerCache = new LruCache(10);
  const logStore = new JsonlStore(dir, 'events', { messageMode: 'hash' });
  const deps = {
    retriever,
    model: new MockChatModel(),
    sessions,
    analytics: new Analytics(),
    answerCache,
    logStore,
  };
  const res = await runChat(deps, { message: '光伏清洁是做什么的', sessionId: 's1' });
  assert.ok(res.answer.length > 0);
  assert.equal(res.sessionId, 's1');
  assert.equal(res.cached, false);
  const h = sessions.peek('s1');
  assert.ok(h && h.messages.length >= 2);
  await logStore.flush();
  const raw = await readFile(logStore.path, 'utf8');
  assert.ok(raw.includes('messagePreview'));
  assert.ok(!raw.includes('"message"'));
});

test('expandQueryText adds synonyms', () => {
  const q = expandQueryText('光伏清洁怎么做');
  assert.ok(q.includes('光伏'));
  assert.ok(q.includes('太阳能') || q.includes('组件'));
  assert.equal(expandQueryText('abc'), 'abc');
});

test('grounded mock uses knowledge lines', () => {
  const ctx =
    'sys\n\n【企业知识】\n【片段 1｜光伏产品｜pv-clean｜01/x.md】\n## 核心能力\n光伏组件表面清洁\n通过航线自动作业';
  const ans = buildGroundedAnswer({
    question: '光伏清洁无人机是做什么的',
    context: ctx,
    historyTurns: 0,
  });
  assert.ok(ans.includes('光伏'));
  assert.ok(ans.includes('Mock'));
});

test('grounded mock no-hit branch', () => {
  const ans = buildGroundedAnswer({
    question: 'xyz',
    context: '【企业知识】\n（未检索到相关资料）',
    historyTurns: 0,
  });
  assert.ok(ans.includes('展厅资料中没有'));
  assert.ok(ans.includes('未命中知识片段'));
});

test('MockChatModel stream yields pieces', async () => {
  const m = new MockChatModel();
  const pieces: string[] = [];
  for await (const p of m.stream({
    messages: [
      { role: 'system', content: '【企业知识】\n（无命中片段）' },
      { role: 'user', content: '测试问题' },
    ],
  })) {
    pieces.push(p);
  }
  assert.ok(pieces.length >= 1);
  assert.ok(pieces.join('').includes('测试问题'));
});

test('answerCacheKey includes generation', () => {
  assert.equal(answerCacheKey('  太阳能  ', 'mock', 0), answerCacheKey('太阳能', 'mock', 0));
  assert.notEqual(answerCacheKey('太阳能', 'mock', 0), answerCacheKey('太阳能', 'mock', 2));
});

test('expandQueryText covers eval synonyms', () => {
  const q = expandQueryText('太阳能组件怎么清洗');
  assert.ok(q.includes('光伏') || q.includes('清洁') || q.includes('清洗'));
  const w = expandQueryText('风机叶片裂纹');
  assert.ok(w.includes('检测') || w.includes('缺陷') || w.includes('风电'));
});

test('Analytics feedbackStats groups down by question', () => {
  const a = new Analytics();
  a.logFeedback({ at: 1, sessionId: 's1', rating: 'down', question: '叶片检测要停机吗？' });
  a.logFeedback({ at: 2, sessionId: 's2', rating: 'down', question: '叶片检测要停机吗？', comment: '讲不清' });
  a.logFeedback({ at: 3, sessionId: 's3', rating: 'up', question: '光伏清洁' });
  const s = a.feedbackStats();
  assert.equal(s.total, 3);
  assert.equal(s.down, 2);
  assert.equal(s.topDown[0]?.question, '叶片检测要停机吗？');
  assert.equal(s.topDown[0]?.down, 2);
  const csv = a.feedbackCsv();
  assert.ok(csv.startsWith('at,sessionId,rating,question,comment'));
  assert.ok(csv.includes('叶片检测要停机吗？'));
});

test('parseChatInput 拒绝非字符串与非对象入参（不再 500）', () => {
  assert.equal(parseChatInput({ message: 12345 }).ok, false);
  assert.deepEqual(parseChatInput({ message: 12345 }), { ok: false, reason: 'message_not_string' });
  assert.equal(parseChatInput(null).ok, false);
  assert.equal(parseChatInput([1, 2]).ok, false);
  assert.equal(parseChatInput({}).ok, false);
  assert.equal(parseChatInput({ message: '   ' }).ok, false);
  assert.equal(validationMessage('message_not_string'), 'message must be a string');
});

test('parseChatInput 截断超长 message 并记录 truncated', () => {
  const long = '光'.repeat(3000);
  const r = parseChatInput(long === '' ? {} : { message: long });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.message.length, 2000);
    assert.equal(r.value.truncated, true);
  }
  const short = parseChatInput({ message: ' 你好 ' });
  assert.ok(short.ok);
  if (short.ok) {
    assert.equal(short.value.message, '你好');
    assert.equal(short.value.truncated, false);
  }
});

test('normalizeSessionId 剔除控制字符与路径片段', () => {
  assert.equal(normalizeSessionId('s-1_ok.9'), 's-1_ok.9');
  assert.equal(normalizeSessionId('../etc/passwd\u0000<script>'), '..etcpasswdscript');
  assert.equal(normalizeSessionId('x'.repeat(100))!.length, 64);
  assert.equal(normalizeSessionId(42), undefined);
  assert.equal(normalizeSessionId('   '), undefined);
  assert.equal(normalizeSessionId('!!!'), undefined);
  // sessionId 只作内存键，不含 '/' 与 '\\' 即不可能被当成路径片段
  assert.ok(!normalizeSessionId('a/b\\c')!.includes('/'));
});

test('CORS：白名单外 Origin 不放行，本地开发源放行', () => {
  assert.equal(decideOrigin('https://evil.example', []).allowed, false);
  assert.equal(decideOrigin('http://localhost:5173', []).allowed, true);
  assert.equal(decideOrigin('http://127.0.0.1:5173', []).allowed, true);
  assert.equal(decideOrigin(undefined, []).allowed, true);

  const allow = resolveCorsOrigins({ CORS_ORIGINS: 'https://a.example, https://b.example/' } as NodeJS.ProcessEnv);
  assert.deepEqual(allow, ['https://a.example', 'https://b.example']);
  assert.equal(decideOrigin('https://a.example', allow).allowed, true);
  assert.equal(decideOrigin('http://localhost:5173', allow).allowed, false, '配置白名单后本地默认源不再放行');
  assert.equal(decideOrigin('https://evil.example', resolveCorsOrigins({ CORS_ORIGINS: '*' } as NodeJS.ProcessEnv)).allowed, true);
  assert.equal(corsHeadersFor('https://evil.example', []).vary, 'Origin');
});

test('chunkText 标题感知分块且单块有上限', () => {
  const doc = [
    '# 产品概述',
    '光伏组件表面清洁说明。'.repeat(12),
    '',
    '## 适用场景',
    '陆上及海上风电场巡检。'.repeat(12),
    '',
    '## 作业流程',
    '航线规划后自动作业。'.repeat(12),
  ].join('\n');
  const chunks = chunkText(doc, 200, 40);
  assert.ok(chunks.length >= 3, `chunks=${chunks.length}`);
  assert.ok(chunks[0]!.startsWith('产品概述'));
  assert.ok(chunks.some((c) => c.includes('适用场景')));
  for (const c of chunks) assert.ok(c.length <= 200 * 1.5 + 40, `too long: ${c.length}`);
});

test('chunkText 超长段落滑窗切分并带重叠', () => {
  const one = '长段落内容。'.repeat(120); // 720 字，单段
  const chunks = chunkText(one, 200, 50);
  assert.ok(chunks.length >= 4, `chunks=${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 200);
  // 相邻块共享重叠区：前一块尾部应出现在后一块开头
  const tail = chunks[0]!.slice(-50);
  assert.ok(chunks[1]!.startsWith(tail));
});

test('Retriever：单字命中不再给分，域外问题无候选', () => {
  const r = new Retriever();
  r.replace([
    { id: 'a', title: '光伏清洁', sourcePath: 'a.md', text: '光伏组件表面清洁作业', zone: 'z', zoneTitle: 'Z', tags: [] },
    { id: 'b', title: '风场检测', sourcePath: 'b.md', text: '风机叶片裂纹与雷击痕迹检测', zone: 'y', zoneTitle: 'Y', tags: [] },
  ]);
  assert.equal(r.retrieve('天').length, 0, '单字查询无 bigram，不应命中');
  assert.ok(r.retrieve('叶片裂纹怎么发现').length > 0);
  assert.equal(r.retrieve('今天上海天气怎么样').length, 0);
  const hit = r.retrieve('叶片裂纹怎么发现')[0]!;
  assert.ok(hit.matchedTokens >= 1);
  assert.ok(hit.matched.includes('叶片'));
});

test('HybridRetriever：bag 非语义时闸门拦截域外问题且 mode 如实上报', async () => {
  const bag: EmbeddingProvider = {
    name: 'bag-test',
    dims: 4,
    semantic: false,
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0, 0]);
    },
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-gate-'));
  const store = new VectorStore(bag, path.join(dir, 'v.json'));
  // 阈值标定依赖真实知识库规模（23 chunks ≈ 3.5）；小样本语料用低阈值只验证闸门逻辑
  const r = new HybridRetriever(store, { minKeywordScore: 1 });
  const mk = (id: string, text: string): KnowledgeChunk => ({
    id,
    title: id,
    sourcePath: id + '.md',
    text,
    zone: 'z',
    zoneTitle: 'Z',
    tags: [],
  });
  await r.replace([
    mk('pv', '光伏组件表面清洁 航线自动作业 积灰 鸟粪 清洗'),
    mk('wind', '风机叶片裂纹 雷击痕迹 涂层脱落 检测 停机'),
  ]);

  const inDomain = await r.retrieveWithDiagnostics('叶片裂纹怎么发现？');
  assert.ok(inDomain.hits.length > 0);
  assert.equal(inDomain.diagnostics.gated, false);
  assert.equal(inDomain.diagnostics.reason, 'keyword_hit');
  assert.equal(inDomain.diagnostics.mode, 'keyword');

  const ood = await r.retrieveWithDiagnostics('今天上海天气怎么样？');
  assert.equal(ood.hits.length, 0);
  assert.equal(ood.diagnostics.gated, true);
  assert.ok(
    ['below_threshold', 'no_candidates'].includes(ood.diagnostics.reason),
    `reason=${ood.diagnostics.reason}`,
  );

  const raw = await r.retrieve('今天上海天气怎么样？');
  assert.ok(raw.length > 0, '未加闸门的原始检索仍可看到向量路噪声命中（供排查）');
  assert.equal(r.stats().mode, 'keyword');
  assert.equal(r.stats().semantic, false);
  assert.ok(r.stats().degradedReason);
});

test('HybridRetriever：语义向量可用时向量路可兜底并上报 hybrid', async () => {
  const semanticEmbed: EmbeddingProvider = {
    name: 'semantic-test',
    dims: 3,
    semantic: true,
    async embed(texts: string[]) {
      return texts.map(() => [0.6, 0.8, 0]);
    },
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-sem-'));
  const store = new VectorStore(semanticEmbed, path.join(dir, 'v.json'));
  const r = new HybridRetriever(store, { minKeywordScore: 1, minVectorScore: 0.35 });
  await r.replace([
    { id: 'a', title: '光伏清洁', sourcePath: 'a.md', text: '光伏组件清洁', zone: 'z', zoneTitle: 'Z', tags: [] },
  ]);
  const out = await r.retrieveWithDiagnostics('完全不相干的提问');
  assert.equal(out.hits.length, 1, '余弦 1.0 ≥ 阈值时向量路兜底');
  assert.equal(out.diagnostics.reason, 'vector_hit');
  assert.equal(out.diagnostics.mode, 'hybrid');
  assert.equal(r.stats().mode, 'hybrid');
});

test('RateLimiter：活跃键不被淘汰（LRU）', () => {
  const r = new RateLimiter(5, 60_000);
  for (let i = 0; i < 1100; i++) r.allow(`ip-${i}`);
  assert.equal(r.allow('ip-1099'), null, '最近访问的键应仍在窗口内');
});

test('Analytics 统计 noHit（知识库未覆盖）次数', () => {
  const a = new Analytics();
  a.logChat({ at: 1, sessionId: 's', mode: 'llm_only', provider: 'mock', messagePreview: 'p', answerPreview: '', latencyMs: 1, noHit: true });
  a.logChat({ at: 2, sessionId: 's', mode: 'rag', provider: 'mock', messagePreview: 'p', answerPreview: '', latencyMs: 1, noHit: false });
  const s = a.stats(1);
  assert.equal(s.chatTotal, 2);
  assert.equal(s.ragHits, 1);
  assert.equal(s.noHit, 1);
  assert.equal(s.recent[0]!.noHit, false);
  assert.equal(s.recent[1]!.noHit, true);
});

test('runChat：域外问题 noHit=true 且计入统计', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-nohit-'));
  const bag: EmbeddingProvider = {
    name: 'bag-test',
    dims: 2,
    semantic: false,
    async embed(texts: string[]) {
      return texts.map(() => [1, 1]);
    },
  };
  const store = new VectorStore(bag, path.join(dir, 'v.json'));
  const retriever = new HybridRetriever(store, { minKeywordScore: 1 });
  await retriever.replace([
    { id: 'a', title: '光伏清洁', sourcePath: 'a.md', text: '光伏组件清洁作业', zone: 'z', zoneTitle: 'Z', tags: [] },
  ]);
  const analytics = new Analytics();
  const deps = {
    retriever,
    model: new MockChatModel(),
    sessions: new SessionStore(),
    analytics,
    answerCache: new LruCache(10),
    logStore: new JsonlStore(dir, 'events', { messageMode: 'hash' }),
  };
  const res = await runChat(deps, { message: '今天上海天气怎么样？', sessionId: 's1' });
  assert.equal(res.noHit, true);
  assert.equal(res.mode, 'llm_only');
  assert.equal(res.retrieval, 'keyword');
  assert.equal(res.sources.length, 0);
  assert.ok(res.answer.includes('展厅资料中没有'));
  assert.equal(analytics.stats(1).noHit, 1);
});

test('rewriteForRetrieval：省略式追问继承上一轮主题词', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-rw-'));
  const bag: EmbeddingProvider = {
    name: 'bag-test',
    dims: 3,
    semantic: false,
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
  };
  const store = new VectorStore(bag, path.join(dir, 'v.json'));
  const r = new HybridRetriever(store, { minKeywordScore: 1 });
  await r.replace([
    {
      id: 'svc',
      title: '服务、培训与合作',
      sourcePath: 'svc.md',
      text: '提供设备操作培训 与 区域运维伙伴合作 报名',
      zone: 'service',
      zoneTitle: '服务与合作',
      tags: [],
    },
    {
      id: 'pv',
      title: '光伏清洁',
      sourcePath: 'pv.md',
      text: '光伏组件表面清洁作业',
      zone: 'pv-clean',
      zoneTitle: '光伏清洁无人机',
      tags: [],
    },
  ]);

  // 1) 本轮检索不到 → 继承上一轮主题
  const rw = rewriteForRetrieval(r, '那怎么报名？', [
    { role: 'user', content: '提供培训吗？' },
    { role: 'assistant', content: '……' },
  ]);
  assert.equal(rw.rewritten, true);
  assert.equal(rw.reason, 'ellipsis_merged');
  assert.ok(rw.carriedTokens.length > 0);
  assert.equal(rw.carriedTopic, '服务、培训与合作');
  assert.ok(rw.query.includes('培训') || rw.query.includes('服务'));

  // 2) 本轮自己能检索到 → 不动
  const selfHit = rewriteForRetrieval(r, '光伏组件表面清洁怎么做？', [
    { role: 'user', content: '提供培训吗？' },
  ]);
  assert.equal(selfHit.rewritten, false);
  assert.equal(selfHit.reason, 'none');
  assert.equal(selfHit.query, '光伏组件表面清洁怎么做？');

  // 3) 无上文 → 不硬接
  const noHistory = rewriteForRetrieval(r, '那怎么报名？', []);
  assert.equal(noHistory.rewritten, false);
  assert.equal(noHistory.reason, 'no_history');

  // 4) 上一轮也是弱问题 → 不硬接
  const prevWeak = rewriteForRetrieval(r, '那怎么报名？', [{ role: 'user', content: '今天天气如何？' }]);
  assert.equal(prevWeak.rewritten, false);
  assert.equal(prevWeak.reason, 'prev_weak');

  // 5) 长问句不走省略式改写
  const longAsk = rewriteForRetrieval(
    r,
    '那你们能不能告诉我到底应该怎么联系相关负责人和后续的流程安排呢？',
    [{ role: 'user', content: '提供培训吗？' }],
  );
  assert.equal(longAsk.rewritten, false);
});

test('Analytics：未覆盖问题清单（明文留存、限量、可关闭）', () => {
  const a = new Analytics(2);
  const base = { sessionId: 's', mode: 'llm_only' as const, provider: 'mock', messagePreview: 'p', answerPreview: '', latencyMs: 1 };
  a.logChat({ ...base, at: 1, noHit: true, question: '洗手间怎么走' });
  a.logChat({ ...base, at: 2, noHit: true, question: '今天上海天气' });
  a.logChat({ ...base, at: 3, noHit: true, question: '午饭吃什么' });
  a.logChat({ ...base, at: 4, noHit: false, question: '不该留存的问题' });
  const list = a.uncoveredList();
  assert.equal(list.length, 2, '上限 2，只留最新两条');
  assert.equal(list[0]!.question, '午饭吃什么');
  assert.ok(!list.some((i) => i.question === '不该留存的问题'), '命中知识的问题不进清单');
  assert.equal(a.stats(1).uncoveredCount, 2);

  const off = new Analytics(0);
  off.logChat({ ...base, at: 5, noHit: true, question: '关闭时不留存' });
  assert.equal(off.uncoveredList().length, 0);
  assert.equal(off.stats(1).uncoveredCount, 0);
});

test('持久化：会话/统计/反馈 落盘后可恢复（PERSIST_STATE 路径）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-state-'));

  const sessions = new SessionStore();
  sessions.append('s1', '光伏清洁无人机是做什么的？', '它是……');
  const analytics = new Analytics(5);
  analytics.logChat({
    at: Date.now(),
    sessionId: 's1',
    mode: 'rag',
    provider: 'mock',
    messagePreview: 'p',
    answerPreview: 'a',
    latencyMs: 3,
  });
  analytics.logFeedback({ at: Date.now(), sessionId: 's1', rating: 'down', question: '叶片检测要停机吗？' });
  analytics.logChat({
    at: Date.now(),
    sessionId: 's1',
    mode: 'llm_only',
    provider: 'mock',
    messagePreview: 'p',
    answerPreview: '',
    latencyMs: 1,
    noHit: true,
    question: '会议室在哪里',
  });

  const s = analytics.exportState();
  await writeState(dir, {
    stats: {
      startedAt: s.startedAt,
      chatTotal: s.chatTotal,
      ragHits: s.ragHits,
      errors: s.errors,
      noHits: s.noHits,
      rewritten: s.rewritten,
    },
    feedback: s.feedback,
    uncovered: s.uncovered,
    sessions: sessions.exportState(),
  });

  // 模拟重启：新实例从盘上恢复
  const restored = await readState(dir);
  assert.ok(restored, 'state.json 应能读回');
  const s2 = new SessionStore();
  const loadedSessions = s2.importState(restored!.sessions);
  assert.equal(loadedSessions, 1);
  assert.equal(s2.peek('s1')?.messages.length, 2);

  const a2 = new Analytics(5);
  a2.importState({ ...restored!.stats, feedback: restored!.feedback, uncovered: restored!.uncovered });
  const stats = a2.stats(1);
  assert.equal(stats.chatTotal, 2);
  assert.equal(stats.ragHits, 1);
  assert.equal(stats.noHit, 1);
  assert.equal(stats.feedback.down, 1);
  assert.equal(a2.feedbackStats().topDown[0]?.question, '叶片检测要停机吗？');
  assert.equal(a2.uncoveredList()[0]?.question, '会议室在哪里');

  // 损坏文件不应炸：读到 null，按空状态启动
  await writeFile(path.join(dir, 'state.json'), '{ 坏掉的 json', 'utf8');
  assert.equal(await readState(dir), null);
});

test('streamChat：与非流式共用答案缓存', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'znwd-ssecache-'));
  const bag: EmbeddingProvider = {
    name: 'bag-test',
    dims: 2,
    semantic: false,
    async embed(texts: string[]) {
      return texts.map(() => [1, 1]);
    },
  };
  const store = new VectorStore(bag, path.join(dir, 'v.json'));
  const retriever = new HybridRetriever(store, { minKeywordScore: 1 });
  await retriever.replace([
    { id: 'a', title: '光伏清洁', sourcePath: 'a.md', text: '光伏组件清洁作业 航线自动', zone: 'z', zoneTitle: 'Z', tags: [] },
  ]);
  const deps = {
    retriever,
    model: new MockChatModel(),
    sessions: new SessionStore(),
    analytics: new Analytics(),
    answerCache: new LruCache(10),
    logStore: new JsonlStore(dir, 'events', { messageMode: 'hash' }),
  };
  let sseText = '';
  for await (const ev of streamChat(deps, { message: '光伏组件清洁作业', sessionId: 'sse' })) {
    if (ev.type === 'delta') sseText += ev.text;
  }
  assert.ok(sseText.length > 0);
  const second = await runChat(deps, { message: '光伏组件清洁作业', sessionId: 'other' });
  assert.equal(second.cached, true, 'SSE 写过的答案，非流式请求应命中缓存');
  const third = await streamChat(deps, { message: '光伏组件清洁作业', sessionId: 'third' }).next();
  assert.equal(third.done, false);
});
