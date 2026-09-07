export async function consumeStream(response, onEvent, signal) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.body || (!contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson')))
    throw new Error('服务器未返回有效数据流，请重试。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', terminal = false;
  const processLine = line => {
    if (!line.trim()) return;
    const payload = line.startsWith('data:') ? line.slice(5).trimStart() : line;
    if (!payload) return;
    const event = JSON.parse(payload);
    if (!['start','delta','done','error'].includes(event.type)) throw new Error('无效的数据流。');
    if (event.type === 'done' || event.type === 'error') terminal = true;
    onEvent(event);
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { processLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (buffer.length > 300000) throw new Error('数据流过大，请重试。');
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
    if (!terminal) throw new Error('连接意外中断，请点击 Retry 重试。');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
