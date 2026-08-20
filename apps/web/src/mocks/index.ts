/**
 * Public API of the mock layer: handlers, the Node server, the store, scenario control, and the
 * SSE script builders (reused by tests that need to script a stream directly).
 *
 * Layer: mock (barrel).
 */
export { handlers } from './handlers';
export { server } from './server';
export { store, resetStore } from './store';
export { initializeScenario, setScenario } from './scenario';
export type { MockScenario } from './scenario';
export { createSseResponse, scriptedTurnFrames } from './events';
export type { CreateSseResponseOptions, ScriptedTurnOptions, SseScriptFrame } from './events';
export { MockProvider } from './MockProvider';
