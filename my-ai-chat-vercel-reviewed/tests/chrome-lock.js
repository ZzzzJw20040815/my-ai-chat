import { mkdir, rm } from 'node:fs/promises';

const LOCK = '/tmp/my-ai-chat-chrome.lock';

export async function acquireChromeLock() {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(LOCK);
      return;
    } catch {
      if (Date.now() - started > 180000) throw new Error('Timed out waiting for the Chrome test lock');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

export async function releaseChromeLock() {
  await rm(LOCK, { recursive: true, force: true });
}
