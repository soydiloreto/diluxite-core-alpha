/**
 * Daily notes — one page per day, and a template that seeds it.
 *
 * The thing a second brain is used for every morning, and the one place where
 * a note is created by a routine rather than by a thought. That makes two
 * decisions matter more than the feature itself.
 *
 * **The title is the date, and nothing else.** `2026-09-02` sorts, is
 * unambiguous in every locale, and is what a wikilink from another note will
 * guess. "Daily note for Wednesday" is a title nobody links to twice the same
 * way.
 *
 * **The template is a NOTE, found by title.** Not a setting, not a class, not
 * a table: a person can open it, read it and edit it with everything they
 * already know, and it travels with an export like any other note. A template
 * stored anywhere else is a thing you have to be told about.
 */

/** Where a template lives, if the space has one. A note titled exactly this. */
export const DAILY_TEMPLATE_TITLE = 'Template: Daily';

/** `2026-09-02` — sortable, locale-proof, and what a wikilink will guess. */
export function dailyTitle(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `Dailies/2026-09` — a folder per month.
 *
 * Per month rather than per year or flat: a year of daily notes in one folder
 * is a folder nobody opens, and one folder per day is a tree nobody scrolls.
 */
export function dailyFolderPath(date: Date): string {
  return `Dailies/${date.toISOString().slice(0, 7)}`;
}

/**
 * Fill a template for a given day.
 *
 * Two placeholders and no expression language. A template that can compute is
 * a template that can be wrong in a way nobody notices, and the point of this
 * one is that a person can read it and know what tomorrow's page will say.
 *
 *   {{date}}      → 2026-09-02
 *   {{yesterday}} → 2026-09-01, so a page can link back with [[{{yesterday}}]]
 */
export function applyDailyTemplate(template: string, date: Date): string {
  const yesterday = new Date(date.getTime() - 86_400_000);
  return template
    .replaceAll('{{date}}', dailyTitle(date))
    .replaceAll('{{yesterday}}', dailyTitle(yesterday));
}

/**
 * The day a client means, in ITS timezone.
 *
 * The server's midnight is not the user's, and a daily note that appears a few
 * hours early or late is one people stop trusting. The offset comes from the
 * client because it is the only party that knows it; an absent one means UTC,
 * which is at least a stated choice rather than the server's accident.
 *
 * `offsetMinutes` follows `Date.prototype.getTimezoneOffset()` — the value a
 * browser actually has — so Buenos Aires (UTC-3) sends **+180**, not -180.
 * Taking the other sign here silently moves every daily note by twice the
 * offset, which is the kind of bug that only shows up near midnight.
 */
export function dayFor(now: Date, offsetMinutes = 0): Date {
  return new Date(now.getTime() - offsetMinutes * 60_000);
}
