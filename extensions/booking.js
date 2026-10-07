// Flight Sector booking tools: plain HTTPS calls through the platform's egress.
// The booking connector is `person_authorized`, so the platform holds the
// provider token and the mission gate lets a reservation through only once the
// traveller's company has approved it. `book_item` declares what it asks
// approval for in the Introspection-Mission header; the runtime reports it when
// the gate steers the call (introspection-cloud connectors-aauth-b2b2c.md §12.2).
import { Type } from "typebox";

const BOOKING_API_URL = (process.env.BOOKING_API_URL ?? "https://api.booking.example").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 20_000;

async function call(path, body, headers, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const url = `${BOOKING_API_URL}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  return { status: response.status, text: await response.text() };
}

function result(res) {
  return {
    content: [{ type: "text", text: `HTTP ${res.status}\n${res.text}` }],
    details: { status: res.status },
    // A 428 is the approval steer, which carries what to tell the person.
    isError: res.status >= 400 && res.status !== 428,
  };
}

export function registerBookingTools(pi) {
  pi.registerTool({
    name: "search_offers",
    label: "Search travel",
    description: "Search flights or hotels. Pass an offer's fields unchanged to book_item.",
    promptSnippet: "Search flights or hotels for bookable offers.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("flight"), Type.Literal("hotel")]),
      from: Type.Optional(Type.String({ description: "Flight origin IATA code, e.g. SFO" })),
      to: Type.Optional(Type.String({ description: "Flight destination IATA code, e.g. SYD" })),
      date: Type.Optional(Type.String({ description: "Flight date, YYYY-MM-DD" })),
      city: Type.Optional(Type.String({ description: "Hotel city IATA code, e.g. SYD" })),
      check_in: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      check_out: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
    }),
    async execute(_toolCallId, params, signal) {
      return result(await call("/v1/search", params, {}, signal));
    },
  });

  pi.registerTool({
    name: "book_item",
    label: "Book travel",
    description:
      "Reserve one offer. Each booking is approved by the traveller's company first: within its policy that is immediate, otherwise it goes to their manager.",
    promptSnippet: "Reserve one offer the traveller has confirmed.",
    promptGuidelines: ["Book one item per call, and only after the traveller has confirmed it."],
    parameters: Type.Object({
      offer_id: Type.String(),
      kind: Type.Union([Type.Literal("flight"), Type.Literal("hotel")]),
      total: Type.Number({ description: "The offer's total price, unchanged" }),
      nightly_rate: Type.Optional(Type.Number({ description: "A hotel offer's nightly rate, unchanged" })),
    }),
    async execute(_toolCallId, params, signal) {
      const limits = { amount_max: params.total, count: 1 };
      if (params.nightly_rate !== undefined) limits.nightly_rate = params.nightly_rate;
      const mission = {
        action: `${params.kind}.reserve`,
        requested_permissions: { host: new URL(BOOKING_API_URL).hostname, resource: params.offer_id, limits },
      };
      return result(
        await call("/v1/reserve", { offer_id: params.offer_id }, { "introspection-mission": JSON.stringify(mission) }, signal)
      );
    },
  });
}

export default function (pi) {
  registerBookingTools(pi);
}
