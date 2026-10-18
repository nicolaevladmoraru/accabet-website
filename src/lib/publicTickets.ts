// ACCABET PUBLIC TICKETS V2: legacy slots and Telegram-confirmed dynamic products.
// Read-only feed of tickets published after Telegram delivery.

export interface PublicSelection {
  result?: PublicResult;
  result_reason?: string;
  settled_at?: string | null;
  fixture_status?: string | null;
  final_score_verified?: boolean;
  final_score?: { home: number; away: number } | null;
  fixture_id: number;
  kickoff?: string | null;
  league?: string | null;
  home_team: string;
  away_team: string;
  home_team_logo?: string | null;
  away_team_logo?: string | null;
  market: string;
  odds?: number | null;
  chance?: number | null;
}

export type PublicResult = 'WIN' | 'LOST' | 'VOID' | 'PENDING';

export interface PublicTicket {
  result?: PublicResult;
  date: string;
  slot_hour: number | null;
  product?: number | null;
  label?: string | null;
  published_at: string;
  selections: PublicSelection[];
}

interface PublicFeedResponse {
  tickets: PublicTicket[];
  count: number;
}

const API_BASE = (
  import.meta.env?.PUBLIC_ACCABET_API_URL ||
  "https://accabet-production.up.railway.app"
).replace(/\/+$/, "");

export function currentUkDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find(part => part.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function calculateTicketOdds(
  selections: PublicSelection[]
): number | null {
  if (!selections.length) return null;

  let total = 1;

  for (const selection of selections) {
    const odd = selection.odds;

    if (
      typeof odd !== "number" ||
      !Number.isFinite(odd) ||
      odd <= 0
    ) {
      return null;
    }

    total *= odd;
  }

  return Number.isFinite(total) ? total : null;
}

export function publicTicketId(ticket: PublicTicket): string {
  return ticket.product != null
    ? `${ticket.date}:dynamic:${ticket.product}`
    : `${ticket.date}:legacy:${ticket.slot_hour}`;
}

export function sortPublicTickets(tickets: PublicTicket[]): PublicTicket[] {
  return [...tickets].sort((a, b) =>
    Date.parse(b.published_at) - Date.parse(a.published_at) ||
    publicTicketId(a).localeCompare(publicTicketId(b))
  );
}

export function parsePublicTickets(data: unknown): PublicTicket[] {
  if (!data || typeof data !== 'object' ||
      !Array.isArray((data as PublicFeedResponse).tickets)) {
    throw new Error('Invalid public ticket feed');
  }

  const valid = (data as PublicFeedResponse).tickets.filter(ticket => {
    if (!ticket || typeof ticket !== 'object') return false;
    const legacy = ticket.product == null && [10, 13, 18].includes(ticket.slot_hour as number);
    const dynamic = ticket.slot_hour == null && [2, 3, 5].includes(ticket.product as number);
    return (legacy || dynamic) && typeof ticket.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(ticket.date) &&
      Number.isFinite(Date.parse(`${ticket.date}T00:00:00Z`)) &&
      new Date(`${ticket.date}T00:00:00Z`).toISOString().slice(0, 10) === ticket.date &&
      typeof ticket.published_at === 'string' && Number.isFinite(Date.parse(ticket.published_at)) &&
      Array.isArray(ticket.selections) && ticket.selections.length >= (dynamic ? 2 : 1) &&
      ticket.selections.every(selection => selection && typeof selection === 'object' &&
        Number.isInteger(selection.fixture_id) && selection.fixture_id > 0 &&
        typeof selection.home_team === 'string' && typeof selection.away_team === 'string' &&
        typeof selection.market === 'string') &&
      new Set(ticket.selections.map(selection => selection.fixture_id)).size === ticket.selections.length;
  });

  // Preserve complete snapshots; never combine selections from duplicate rows.
  const unique = new Map<string, PublicTicket>();
  for (const ticket of sortPublicTickets(valid)) {
    const id = publicTicketId(ticket);
    if (!unique.has(id)) unique.set(id, ticket);
  }
  return [...unique.values()];
}

export async function fetchPublicTickets(
  limit = 100
): Promise<PublicTicket[]> {
  const safeLimit = Math.max(
    1,
    Math.min(500, Math.trunc(limit))
  );

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    10000
  );

  try {
    const response = await fetch(
      `${API_BASE}/api/public/tickets?limit=${safeLimit}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store",
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(
        `Public ticket feed returned HTTP ${response.status}`
      );
    }

    return parsePublicTickets(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}


// Presentation only: outcomes are supplied by the backend, never inferred from goals.
export function publicResult(value: unknown): PublicResult {
  return value === 'WIN' || value === 'LOST' || value === 'VOID' ? value : 'PENDING';
}

export function resultBadge(value: unknown): string {
  const result = publicResult(value);
  return `<span class="ab-result ab-result--${result.toLowerCase()}">${result}</span>`;
}

export function finalScoreText(selection: PublicSelection): string {
  const score = selection.final_score;
  return selection.final_score_verified === true && selection.fixture_status === 'FT' && score &&
    Number.isSafeInteger(score.home) && score.home >= 0 &&
    Number.isSafeInteger(score.away) && score.away >= 0
      ? `${score.home} – ${score.away}` : '';
}

type Visibility = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
export function startPublicTicketPolling(options: {
  load: () => Promise<PublicTicket[]>;
  onData: (tickets: PublicTicket[]) => void;
  onError: (error: unknown) => void;
  visibility?: Visibility;
  interval?: number;
  timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
}) {
  const visibility = options.visibility ?? document;
  const timers = options.timers ?? globalThis;
  let stopped = false, busy = false, epoch = 0, refreshAfter = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { if (timer !== undefined) timers.clearTimeout(timer); timer = undefined; };
  async function refresh(): Promise<void> {
    if (stopped || visibility.hidden || busy) return;
    clear();
    busy = true;
    const generation = epoch;
    try {
      const tickets = await options.load();
      if (!stopped && !visibility.hidden && generation === epoch) options.onData(tickets);
    } catch (error) {
      if (!stopped && !visibility.hidden && generation === epoch) options.onError(error);
    } finally {
      busy = false;
      if (!stopped && !visibility.hidden) {
        if (refreshAfter) { refreshAfter = false; void refresh(); }
        else timer = timers.setTimeout(() => { void refresh(); }, options.interval ?? 90000);
      }
    }
  }
  const changed = () => {
    epoch++;
    clear();
    if (!visibility.hidden) {
      if (busy) refreshAfter = true;
      else void refresh();
    }
  };
  visibility.addEventListener('visibilitychange', changed);
  const stop = () => { stopped = true; epoch++; clear(); visibility.removeEventListener('visibilitychange', changed); };
  void refresh();
  return { refresh, stop };
}
