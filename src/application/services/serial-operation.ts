/** Shared by manual, batch and smart entrypoints in this single-host application. */
const tails = new Map<string, Promise<void>>();

export async function withSerialOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const next = previous.then(() => held);
  tails.set(key, next);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === next) tails.delete(key);
  }
}
