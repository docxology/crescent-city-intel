import { test, expect } from 'bun:test';
import { parseSchoolClosurePage } from '../src/alerts/dusd_schools.ts';
const now = new Date('2026-09-30T12:00:00Z'), url = 'https://www.dnusd.org/news';
const page = (heading: string) => `<title>Del Norte Unified School District</title><article><h2>${heading}</h2><p>District announcements for families and students.</p></article>`;
test('fresh pages preserve occurrence dates and refuse undated status or login/SPA shells', () => {
  expect(parseSchoolClosurePage(page('Schools closed 2026-09-30'), url, now)[0]!.date).toBe('2026-09-30');
  expect(parseSchoolClosurePage(page('Schools closed 2026-09-29'), url, now)).toEqual([]);
  expect(() => parseSchoolClosurePage(page('Schools closed') + '<time datetime="2026-09-30">published</time>', url, now)).toThrow('occurrence');
  expect(() => parseSchoolClosurePage('<title>Sign in to continue</title><script>Del Norte District</script>', url, now)).toThrow('usable');
  expect(() => parseSchoolClosurePage('<div id="app"></div><script>Del Norte District</script>', url, now)).toThrow('usable');
  expect(parseSchoolClosurePage(page('Applications closed 2026-09-30'), url, now)).toEqual([]);
});
