export type StorageKind = 'local' | 'session';

function getStorage(kind: StorageKind): Storage | null {
  try {
    const root = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
    return kind === 'local' ? root.localStorage ?? null : root.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readStorage(kind: StorageKind, key: string): string | null {
  try {
    return getStorage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(kind: StorageKind, key: string, value: string): boolean {
  try {
    const storage = getStorage(kind);
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeStorage(kind: StorageKind, key: string): boolean {
  try {
    const storage = getStorage(kind);
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
