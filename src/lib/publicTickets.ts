// ACCABET PUBLIC TICKETS V1
// Read-only feed of tickets published after Telegram delivery.

export interface PublicSelection {
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

export interface PublicTicket {
  date: string;
  slot_hour: number;
  published_at: string;
  selections: PublicSelection[];
}

interface PublicFeedResponse {
  tickets: PublicTicket[];
  count: number;
}

const API_BASE = (
  import.meta.env.PUBLIC_ACCABET_API_URL ||
  "https://accabet-production.up.railway.app"
).replace(/\/+$/, "");

export function currentUkDate(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

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

    const data: PublicFeedResponse = await response.json();

    if (!data || !Array.isArray(data.tickets)) {
      throw new Error("Invalid public ticket feed");
    }

    return data.tickets.filter(ticket =>
      ticket !== null &&
      typeof ticket === "object" &&
      /^\d{4}-\d{2}-\d{2}$/.test(ticket.date) &&
      typeof ticket.published_at === "string" &&
      [10, 13, 18].includes(ticket.slot_hour) &&
      Array.isArray(ticket.selections) &&
      ticket.selections.length > 0 &&
      ticket.selections.every(selection =>
        selection !== null &&
        typeof selection === "object" &&
        Number.isInteger(selection.fixture_id) &&
        typeof selection.home_team === "string" &&
        typeof selection.away_team === "string" &&
        typeof selection.market === "string"
      )
    );
  } finally {
    clearTimeout(timeout);
  }
}