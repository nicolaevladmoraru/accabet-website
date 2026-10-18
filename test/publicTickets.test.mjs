import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePublicTickets, publicTicketId, sortPublicTickets,
  calculateTicketOdds, currentUkDate, fetchPublicTickets } from '../src/lib/publicTickets.ts';

const selection = id => ({ fixture_id: id, kickoff: '2026-10-18T15:00:00+01:00',
  league: 'League', home_team: `Home ${id}`, away_team: `Away ${id}`,
  market: 'Full Time OVER 1.5', odds: 1.5, chance: 75 });
const dynamic = product => ({ date: '2026-10-18', product, slot_hour: null,
  published_at: `2026-10-18T09:0${product}:00Z`,
  selections: [selection(product * 10), selection(product * 10 + 1)] });
const legacy = slot => ({ date: '2026-10-18', slot_hour: slot,
  published_at: '2026-10-18T08:00:00Z', selections: [selection(slot)] });
const feed = tickets => ({ tickets, count: tickets.length });

test('mixed feed accepts all products and legacy slots exactly once', () => {
  const tickets = [dynamic(2), dynamic(3), dynamic(5), legacy(10), legacy(13), legacy(18)];
  const parsed = parsePublicTickets(feed([...tickets, ...tickets]));
  assert.equal(parsed.length, 6);
  for (const product of [2, 3, 5]) assert.equal(parsed.filter(t => t.product === product).length, 1);
  assert.equal(new Set(parsed.map(publicTicketId)).size, 6);
  assert.notEqual(publicTicketId(dynamic(2)), publicTicketId(legacy(10)));
});

test('identity is date plus product, independent of timestamps and selections', () => {
  const original = dynamic(2);
  assert.equal(publicTicketId(original), '2026-10-18:dynamic:2');
  assert.equal(publicTicketId({ ...original, published_at: 'later' }), publicTicketId(original));
  assert.notEqual(publicTicketId({ ...original, date: '2026-10-19' }), publicTicketId(original));
  const newest = { ...original, published_at: '2026-10-18T10:00:00Z' };
  assert.strictEqual(parsePublicTickets(feed([original, newest]))[0], newest);
});

test('preserves snapshot selections, prices, kickoffs, market labels and extra evidence', () => {
  const ticket = dynamic(5);
  ticket.selections = [selection(1), selection(2), selection(3), selection(4)];
  ticket.selections[0].result = 'WIN';
  const before = JSON.stringify(ticket);
  assert.strictEqual(parsePublicTickets(feed([ticket]))[0], ticket);
  assert.equal(JSON.stringify(ticket), before);
  assert.equal(calculateTicketOdds(ticket.selections), 5.0625);
  // Product 5 is a target-odds product, not a requirement for five legs.
  assert.equal(ticket.selections.length, 4);
});

test('sorts actual timestamps across offsets without mutating input', () => {
  const early = { ...dynamic(2), published_at: '2026-10-18T10:00:00+02:00' };
  const late = { ...dynamic(3), published_at: '2026-10-18T09:00:00Z' };
  const input = [early, late];
  assert.deepEqual(sortPublicTickets(input), [late, early]);
  assert.deepEqual(input, [early, late]);
});

test('UK date includes summer midnight, winter midnight and DST transitions', () => {
  assert.equal(currentUkDate(new Date('2026-10-17T23:01:00Z')), '2026-10-18');
  assert.equal(currentUkDate(new Date('2026-12-31T23:30:00Z')), '2026-12-31');
  assert.equal(currentUkDate(new Date('2026-03-29T01:01:00Z')), '2026-03-29');
  assert.equal(currentUkDate(new Date('2026-10-25T01:01:00Z')), '2026-10-25');
});

test('rejects invalid identities, dates and duplicate fixtures without inventing prices', () => {
  const original = dynamic(2);
  for (const invalid of [null, { ...original, product: 4 }, { ...original, slot_hour: 10 },
    { ...original, date: '2026-02-30' }, { ...original, published_at: 'invalid' },
    { ...original, selections: [selection(1), selection(1)] }]) {
    assert.deepEqual(parsePublicTickets(feed([invalid])), []);
  }
  assert.equal(calculateTicketOdds([{ ...selection(1), odds: null }]), null);
  assert.equal(calculateTicketOdds([]), null);
  assert.deepEqual(parsePublicTickets(feed([])), []);
  assert.throws(() => parsePublicTickets({}), /Invalid public ticket feed/);
});

test('transport remains GET-only with same endpoint, errors and safe limit', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.match(url, /\/api\/public\/tickets\?limit=500$/);
      assert.equal(options.method, 'GET');
      assert.equal(options.cache, 'no-store');
      return { ok: true, json: async () => feed([dynamic(2), dynamic(2)]) };
    };
    assert.equal((await fetchPublicTickets(999)).length, 1);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(fetchPublicTickets(), /HTTP 503/);
  } finally { globalThis.fetch = previous; }
});

test('every feed page uses the shared identity and no legacy-only identity', () => {
  for (const page of ['index', 'todays-accas', 'daily-accas']) {
    const source = readFileSync(new URL(`../src/pages/${page}.astro`, import.meta.url), 'utf8');
    assert.match(source, /fetchPublicTickets/);
    assert.match(source, /publicTicketId/);
    assert.match(source, /data-ticket-id/);
    assert.doesNotMatch(source, /id: `\$\{ticket.date\}-\$\{ticket.slot_hour\}`/);
  }
});
