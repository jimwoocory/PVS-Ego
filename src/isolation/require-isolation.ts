// This copy is an isolated acceptance environment. Production sources are untouched.
const boundary = (globalThis as Record<symbol, any>)[Symbol.for('pvs.isolation.boundary.v1')];
if (!boundary || boundary.contract !== 'pvs-local-deny-execution-v1') {
  throw new Error('ISOLATION_GUARD_REQUIRED_BEFORE_APPLICATION_IMPORT');
}
boundary.assertEnvironment();
export {};
