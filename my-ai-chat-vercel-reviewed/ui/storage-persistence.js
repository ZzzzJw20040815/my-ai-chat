export async function storagePersistenceStatus(storageManager = globalThis.navigator?.storage) {
  if (!storageManager || typeof storageManager.persisted !== 'function' || typeof storageManager.persist !== 'function') {
    return { state: 'unsupported', supported: false };
  }
  try {
    return await storageManager.persisted()
      ? { state: 'persistent', supported: true }
      : { state: 'best-effort', supported: true };
  } catch {
    return { state: 'best-effort', supported: true };
  }
}

export async function requestStoragePersistence(storageManager = globalThis.navigator?.storage) {
  const current = await storagePersistenceStatus(storageManager);
  if (!current.supported || current.state === 'persistent') return current;
  try {
    return await storageManager.persist()
      ? { state: 'persistent', supported: true }
      : { state: 'denied', supported: true };
  } catch {
    return { state: 'denied', supported: true };
  }
}
