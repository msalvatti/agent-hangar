/**
 * Selecting a mock scenario from a spec.
 *
 * Layer: test support (Playwright).
 *
 * The mock API decides its scenario from `NEXT_PUBLIC_API_MOCK_SCENARIO` first and from
 * `localStorage` second. The environment variable is inlined when the app is built, so it cannot
 * vary per test; `localStorage` can, as long as it is written before the page's own script runs —
 * which is what an init script is for.
 */
import type { Page } from '@playwright/test';

/** Key the mock API reads its scenario from. */
export const SCENARIO_STORAGE_KEY = 'ah-mock-scenario';

/** Scenarios the mock API implements. */
export type MockScenario =
  'default' | 'missing-settings' | 'infra-down' | 'failing-turn' | 'expired-stream';

/**
 * Makes every later navigation of `page` use one mock scenario.
 *
 * @param page - The page to configure; call before the first navigation.
 * @param scenario - Scenario to select.
 */
export async function useMockScenario(page: Page, scenario: MockScenario): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(String(key), String(value));
    },
    [SCENARIO_STORAGE_KEY, scenario],
  );
}
