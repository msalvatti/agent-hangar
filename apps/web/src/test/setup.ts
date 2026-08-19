/**
 * Vitest setup for the web app: jest-dom matchers and automatic DOM cleanup between tests.
 *
 * Layer: config (test).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
