// Its own module so the runner (sign-in setup) and the healer can both use it
// without importing each other.
import type { TestResult } from './types';

const UNREACHABLE_CODES =
  'net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|EMPTY_RESPONSE|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED)' +
  '|NS_ERROR_(?:CONNECTION_REFUSED|UNKNOWN_HOST|NET_RESET|NET_TIMEOUT)' +
  '|Could not connect to (?:the )?server';

/**
 * The address a navigation could not reach, when that is the whole story of
 * the failure: nothing listening, or the name does not resolve. Returns the
 * origin (e.g. http://localhost:3000), or null when this is an ordinary
 * failure the healer should see.
 *
 * Deliberately narrow, because a wrong "unreachable" verdict denies a real
 * heal:
 * - the network error must be the message of a page.goto itself, not a
 *   code-frame line or a request the page made;
 * - an assertion failure anywhere in the output means some test did reach a
 *   page, so the file is not simply "app down";
 * - if the spec spells that origin out itself, the address is the test's own
 *   mistake (a hard-coded port, an invented host) and a heal can fix it.
 */
export function unreachableOrigin(error: string | undefined, specCode = ''): string | null {
  if (!error) return null;
  const goto = new RegExp(`page\\.goto: (?:${UNREACHABLE_CODES})(?: at (\\S+))?`).exec(error);
  if (!goto) return null;
  if (/Error: expect\(/.test(error)) return null;
  const url = goto[1] ?? /navigating to "([^"]+)"/.exec(error)?.[1];
  if (!url) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  if (origin === 'null' || specCode.includes(origin)) return null;
  return origin;
}

/** The failed result as the PR should show it: what did not answer, then Playwright's own output. */
export function unreachableResult(result: TestResult, origin: string): TestResult {
  return {
    ...result,
    unreachable: origin,
    error:
      `Nothing answered at ${origin}, so this is not a problem with the test. ` +
      `Check that the app is running before GreenCI starts and that base-url (or baseURL in your Playwright config) points at it.\n\n${result.error ?? ''}`,
  };
}

/**
 * Stricter reading for a whole run's output (the sign-in setup, which may
 * have been retried): unreachable only if every error in it is the
 * navigation failing to connect. One attempt that reached the app and failed
 * for another reason (a wrong password shows up as a TimeoutError) means the
 * app is up, and the real problem is the other error.
 */
export function unreachableThroughout(output: string, specCode = ''): string | null {
  const origin = unreachableOrigin(output, specCode);
  if (!origin) return null;
  const errors = output.match(/^\s*(?:[A-Za-z.]*Error|TimeoutError): .*$/gm) ?? [];
  const connect = new RegExp(`page\\.goto: (?:${UNREACHABLE_CODES})`);
  return errors.every((line) => connect.test(line)) ? origin : null;
}
