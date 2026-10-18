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


// Website results regression tests share the original offline npm test command.
import { publicResult, resultBadge, finalScoreText, startPublicTicketPolling } from '../src/lib/publicTickets.ts';

test('result presentation accepts only backend states; never derives outcomes', () => {
  for (const result of ['WIN','LOST','VOID','PENDING']) {
    assert.equal(publicResult(result), result);
    assert.match(resultBadge(result), new RegExp(`ab-result--${result.toLowerCase()}`));
    assert.ok(resultBadge(result).endsWith(`${result}</span>`));
  }
  for (const invalid of [null, undefined, 'OPEN', 'PUSH', 'won', '<img src=x>']) {
    assert.equal(publicResult(invalid), 'PENDING');
    assert.ok(!resultBadge(invalid).includes('<img'));
  }
});

test('final score requires explicit backend verification and final regulation status', () => {
  const verified = {...selection(1), final_score_verified:true, fixture_status:'FT', final_score:{home:2,away:1}};
  assert.equal(finalScoreText(verified), '2 – 1');
  for (const changes of [{final_score_verified:false}, {fixture_status:'2H'}, {fixture_status:'AET'},
    {fixture_status:'PEN'}, {final_score:null}, {final_score:{home:-1,away:0}},
    {final_score:{home:'2',away:1}}, {final_score:{home:2.5,away:1}}]) {
    assert.equal(finalScoreText({...verified,...changes}), '');
  }
});

function pollingHarness(load) {
  let handler, serial=0;
  const scheduled=new Map(); const received=[],errors=[];
  const visibility={hidden:false,addEventListener:(name,fn)=>{handler=fn;},removeEventListener:()=>{handler=undefined;}};
  const timers={setTimeout:(fn,ms)=>{const id=++serial;scheduled.set(id,{fn,ms});return id;},clearTimeout:id=>scheduled.delete(id)};
  const poller=startPublicTicketPolling({load,onData:data=>received.push(data),onError:e=>errors.push(e),visibility,timers});
  return {poller,scheduled,received,errors,visibility,change:hidden=>{visibility.hidden=hidden;handler?.();}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('polling is serial, uses 90 seconds, and stops cleanly', async () => {
  const first=deferred(); let calls=0;
  const h=pollingHarness(()=>{calls++;return first.promise;});
  await h.poller.refresh(); await h.poller.refresh(); assert.equal(calls,1);
  first.resolve([dynamic(2)]); await flush();
  assert.equal(h.received.length,1);assert.equal(h.scheduled.size,1);
  assert.equal([...h.scheduled.values()][0].ms,90000);
  h.poller.stop(); assert.equal(h.scheduled.size,0);
  await h.poller.refresh();assert.equal(calls,1);
});

test('hidden-page responses cannot replace newer data; resume queues one refresh', async () => {
  const old=deferred(),fresh=deferred();let calls=0;
  const h=pollingHarness(()=>++calls===1?old.promise:fresh.promise);
  h.change(true); await h.poller.refresh();assert.equal(calls,1);
  h.change(false); assert.equal(calls,1);
  old.resolve([dynamic(2)]);await flush();assert.equal(calls,2);assert.equal(h.received.length,0);
  fresh.resolve([dynamic(3)]);await flush();assert.equal(h.received.length,1);
  assert.equal(h.received[0][0].product,3);h.poller.stop();
});

test('errors retain the last data and schedule a retry, without fabricated results', async () => {
  let calls=0; const h=pollingHarness(async()=>{if(++calls===1)return [dynamic(2)];throw new Error('offline');});
  await flush();await h.poller.refresh();
  assert.equal(h.received.length,1);assert.equal(h.errors.length,1);assert.equal(h.scheduled.size,1);
  h.change(true);assert.equal(h.scheduled.size,0);h.poller.stop();
});

test('stopped and hidden pending requests cannot mutate the page', async () => {
  for (const action of ['stop','hide']) {
    const request=deferred();const h=pollingHarness(()=>request.promise);
    if(action==='stop')h.poller.stop();else h.change(true);
    request.resolve([dynamic(5)]);await flush();
    assert.equal(h.received.length,0);assert.equal(h.scheduled.size,0);h.poller.stop();
  }
});

test('all pages use the same result/score helpers and visibility-safe poller', () => {
  for (const page of ['index','todays-accas','daily-accas']) {
    const source=readFileSync(new URL(`../src/pages/${page}.astro`,import.meta.url),'utf8');
    for (const helper of ['resultBadge','finalScoreText','startPublicTicketPolling']) assert.ok(source.includes(helper));
    assert.doesNotMatch(source,/status: 'pending'/);
    assert.match(source,/pagehide/);
  }
});

test('badge colors override the existing match-copy span colors', () => {
  const css=readFileSync(new URL('../src/components/PublicResultsStyles.astro',import.meta.url),'utf8');
  for(const state of ['win','lost','void'])assert.ok(css.includes(`.ab-result.ab-result--${state}`));
});
