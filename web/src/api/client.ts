export interface ChatSource {
  title: string;
  snippet: string;
  score: number;
  sourcePath: string;
}

export interface ChatResponse {
  answer: string;
  sources: ChatSource[];
  mode: 'rag' | 'llm_only';
  provider: string;
  sessionId?: string | null;
}

export async function sendChat(message: string, sessionId?: string): Promise<ChatResponse> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, sessionId }),
  });

  if (!res.ok) {
    let detail = `请求失败 (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }

  return (await res.json()) as ChatResponse;
}
