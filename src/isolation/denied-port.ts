// Business services and authorization stay intact; isolation has no real executor.
export function deniedPort<T>(kind: string): T {
  const error = () => { throw Object.assign(new Error('ISOLATION_REAL_PORT_DISABLED:' + kind), {code: 'ISOLATION_REAL_PORT_DISABLED'}); };
  return new Proxy({id: 'ISOLATION_DENIED_' + kind, version: '1'}, {
    get(target, key) {
      if (key === 'then') return undefined;
      if (key === 'id' || key === 'version') return target[key];
      if (key === 'available' || key === 'supportsCapabilities') return async () => false;
      if (key === 'toJSON') return () => ({kind, execution: 'DENIED'});
      return error;
    }
  }) as unknown as T;
}
