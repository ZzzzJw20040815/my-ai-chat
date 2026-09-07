// Vite-only browser QA fixtures. Not imported by the Vercel API or any UI module.
const wait = (ms, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});
export function qaTransport(scenario) {
  return async function* (_, params, signal) {
      await wait(250, signal);
      if (scenario === '429') throw { status: 429 };
      if (scenario === 'model') throw { status: 404 };
      if (scenario === 'network') throw new TypeError('QA upstream network error');
      if (scenario === 'server') throw new Error('QA internal stack must not be exposed');
      const chunks = ['## 本地流式测试\n\n', '**逐段显示**，*无需等待整篇结束*。\n\n', '- Markdown 列表\n- 安全渲染\n\n',
        '| 项目 | 状态 |\n| --- | --- |\n| Streaming | 测试数据 |\n\n',
        '`inline code` 和 [示例链接](https://example.com)。\n\n',
        '```javascript\nconst longValue = "' + 'long_code_'.repeat(35) + '";\nconsole.log(longValue);\n```\n\n',
        '长文本：' + 'longtext'.repeat(50) + '\n\n',
        '<script>alert("must remain text")</script>\n\n'];
      for (const text of chunks) { yield { text }; await wait(scenario === 'slow' ? 2000 : 400, signal); }
      yield { text: '测试完成。这不是 Gemini 实际回复。', candidates: [{ finishReason: 'STOP' }] };
  };
}
