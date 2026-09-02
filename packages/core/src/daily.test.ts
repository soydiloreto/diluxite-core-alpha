import { describe, it, expect } from 'vitest';
import { dailyTitle, dailyFolderPath, applyDailyTemplate, dayFor } from './daily';

const D = new Date('2026-09-02T15:00:00.000Z');

describe('daily notes', () => {
  it('titles the note with the date and nothing else', () => {
    // Sortable, unambiguous in every locale, and what a wikilink from another
    // note will guess.
    expect(dailyTitle(D)).toBe('2026-09-02');
  });

  it('files it in a folder per month', () => {
    expect(dailyFolderPath(D)).toBe('Dailies/2026-09');
  });

  it('fills the two placeholders, including yesterday for a back-link', () => {
    expect(applyDailyTemplate('# {{date}}\n\nAyer: [[{{yesterday}}]]', D)).toBe(
      '# 2026-09-02\n\nAyer: [[2026-09-01]]',
    );
  });

  it('leaves a template with no placeholders alone', () => {
    expect(applyDailyTemplate('## Qué hice\n\n## Qué aprendí', D)).toBe('## Qué hice\n\n## Qué aprendí');
  });

  it('crosses a month boundary correctly on the back-link', () => {
    expect(applyDailyTemplate('[[{{yesterday}}]]', new Date('2026-09-01T05:00:00Z'))).toBe(
      '[[2026-08-31]]',
    );
  });

  it('resolves the day in the CLIENT timezone, not the server midnight', () => {
    // 22:00 in Buenos Aires (UTC-3) is already the 3rd in UTC. A daily note
    // that appears hours early is one people stop trusting.
    //
    // The sign follows `getTimezoneOffset()`, which is what a browser has:
    // UTC-3 sends +180. Taking the other sign moves every daily note by twice
    // the offset — a bug that only shows up near midnight.
    const lateHere = new Date('2026-09-03T01:00:00.000Z');
    expect(dailyTitle(dayFor(lateHere, 180))).toBe('2026-09-02');
    // And an absent offset means UTC — a stated choice, not the server's
    // accident.
    expect(dailyTitle(dayFor(lateHere))).toBe('2026-09-03');
  });
});
