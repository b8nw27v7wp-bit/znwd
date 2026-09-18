const B = 'http://127.0.0.1:8787';
async function j(u, opt) {
  const r = await fetch(B + u, opt);
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: t };
  }
}
const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(ok ? 'PASS' : 'FAIL', name, detail ?? '');
}

(async () => {
  const h = await j('/api/health');
  rec('health', h.status === 200 && h.body.ok === true, `chunks=${h.body.knowledgeChunks} cache=${h.body.answerCacheSize}`);

  const z = await j('/api/zones');
  rec('zones', z.status === 200 && z.body.zones?.length >= 2, `n=${z.body.zones?.length}`);

  const s = await j('/api/suggestions?zone=wind-inspect');
  rec('suggestions-zone', s.status === 200 && Array.isArray(s.body.items) && s.body.items.length > 0, JSON.stringify(s.body.items));

  const empty = await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '  ' }),
  });
  rec('chat-400-empty', empty.status === 400, String(empty.status));

  const c1 = await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '光伏清洁无人机是做什么的？', sessionId: 'audit1' }),
  });
  rec(
    'chat-pv',
    c1.status === 200 && c1.body.mode === 'rag' && (c1.body.sources || []).length > 0 && String(c1.body.answer).includes('光伏'),
    `mode=${c1.body.mode} src=${c1.body.sources?.[0]?.title}`,
  );

  const cacheQ = '如何联系合作？';
  const ca = await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: cacheQ, sessionId: 'cache-a' }),
  });
  const c1b = await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: cacheQ, sessionId: 'cache-b' }),
  });
  rec(
    'chat-cache',
    ca.body.cached === false && c1b.status === 200 && c1b.body.cached === true,
    `A=${ca.body.cached} B=${c1b.body.cached}`,
  );

  const c2 = await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '太阳能组件怎么清洗？', sessionId: 'audit3' }),
  });
  rec(
    'chat-synonym-pv',
    c2.status === 200 &&
      c2.body.mode === 'rag' &&
      (c2.body.sources || []).some((x) => /光伏|清洁|产品概述/.test(x.title + x.sourcePath)),
    `mode=${c2.body.mode} t=${c2.body.sources?.[0]?.title}`,
  );

  const c3 = await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '叶片检测要停机吗？', sessionId: 'audit4' }),
  });
  rec(
    'chat-wind',
    c3.status === 200 && c3.body.mode === 'rag' && /叶片|风场/.test(JSON.stringify(c3.body.sources) + c3.body.answer),
    c3.body.sources?.[0]?.title,
  );

  // use unique question so cache path is also isolated; then follow-up
  await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '清洁作业流程是怎样的？', sessionId: 'mt1' }),
  });
  await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '那检测呢？', sessionId: 'mt1' }),
  });
  const ses = await j('/api/sessions/mt1');
  rec('session-history', ses.status === 200 && ses.body.messages?.length >= 4, `msgs=${ses.body.messages?.length}`);

  // cache-hit must still write session（随机 id，避免进程内旧会话）
  const qCache = '展厅有哪些安全注意事项？';
  const sidSrc = `cache-src-${Date.now()}`;
  const sidHit = `cache-hit-${Date.now()}`;
  await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: qCache, sessionId: sidSrc }),
  });
  const cHit = await j('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: qCache, sessionId: sidHit }),
  });
  const sesC = await j(`/api/sessions/${sidHit}`);
  rec(
    'cache-writes-session',
    cHit.body.cached === true && sesC.body.messages?.length >= 2,
    `cached=${cHit.body.cached} msgs=${sesC.body.messages?.length}`,
  );

  const fb = await j('/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'mt1', rating: 'up' }),
  });
  rec('feedback-ok', fb.status === 200 && fb.body.ok === true);
  const fbBad = await j('/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rating: 'x' }),
  });
  rec('feedback-400', fbBad.status === 400);

  const st = await j('/api/stats');
  rec('stats', st.status === 200 && typeof st.body.chatTotal === 'number', `total=${st.body.chatTotal} rag=${st.body.ragHits}`);

  const streamRes = await fetch(B + '/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '风场检测无人机是做什么的？', sessionId: 'sse1' }),
  });
  const text = await streamRes.text();
  rec(
    'sse-stream',
    streamRes.status === 200 && text.includes('event: meta') && text.includes('event: done'),
    `len=${text.length} hasDelta=${text.includes('event: delta')}`,
  );

  const kl = await j('/api/knowledge/list');
  rec(
    'knowledge-list',
    kl.status === 200 && kl.body.fileCount >= 4 && kl.body.retrieval?.mode === 'hybrid',
    `files=${kl.body.fileCount}`,
  );

  const rel = await j('/api/knowledge/reload', { method: 'POST' });
  rec('knowledge-reload', rel.status === 200 && rel.body.ok === true, `chunks=${rel.body.knowledgeChunks}`);

  const oa = await j('/api/openapi.json');
  rec('openapi', oa.status === 200 && !!oa.body.paths?.['/api/chat']);

  const del = await j('/api/sessions/mt1', { method: 'DELETE' });
  rec('session-delete', del.status === 200 && del.body.ok === true);

  const ls = await j('/api/sessions/mt1');
  rec('session-gone', ls.status === 404);

  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile('E:/znwd/server/data/events.jsonl', 'utf8');
    rec('jsonl-log', raw.trim().length > 0, `bytes=${raw.length}`);
  } catch (e) {
    rec('jsonl-log', false, String(e));
  }

  const fail = results.filter((r) => !r.ok);
  console.log('\nSUMMARY', `${results.length - fail.length}/${results.length} passed`);
  if (fail.length) {
    console.log('FAILED', fail.map((f) => f.name).join(','));
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
