/**
 * "Does this look like an email address" — the one implementation.
 *
 * The pattern itself was copied into three files, and in all three it is
 * ambiguous in the way that costs: `[^\s@]+\.[^\s@]+` puts a literal dot
 * between two quantifiers whose character class ALREADY CONTAINS the dot. Each
 * dot in the input is therefore a candidate for the literal `\.`, and when the
 * tail cannot match, the engine tries all of them — quadratic. CodeQL called
 * it (js/polynomial-redos) and it was right; the forgot-password route reaches
 * this straight from the request body, where Fastify's default 1MB limit is
 * the only bound.
 *
 * Measured, because the intuitive guess is wrong: a long DOTLESS input
 * (`'a'*n + '@' + 'b'*n`) is linear and answers in 0.1ms. The expensive shape
 * is many dots plus a tail outside the class — `'a@' + 'b.'.repeat(n) + ' '`
 * — at 10k/40k/80k characters: 26ms, 396ms, 1607ms. At the 1MB body limit
 * that is minutes of CPU for a single unauthenticated request.
 *
 * The fix is the length guard rather than a cleverer pattern. RFC 5321 caps a
 * complete address at 254 characters, so anything longer is invalid on its own
 * terms and never reaches the regex — which makes the cost constant-bounded no
 * matter how the pattern is written, and stays correct if someone edits it
 * later. Rewriting the regex alone would have fixed today's shape and left the
 * next author one careless quantifier away from the same bug.
 */

/** RFC 5321 §4.5.3.1.3: the whole address is at most 254 octets. */
export const MAX_EMAIL_LENGTH = 254;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A cheap shape check, NOT a validity check — deliverability is decided by
 * sending, not by a pattern. Callers are expected to have trimmed and
 * lowercased already where that matters.
 */
export function isEmailShaped(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  return EMAIL_SHAPE.test(value);
}
