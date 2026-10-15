# Travel Agent Recipe

An [Introspection](https://introspection.dev) recipe: **Flight Sector's travel
agent**, which books work travel for another company's employees. The booking
provider is a native [AAuth](https://github.com/dickhardt/AAuth) resource, and
the traveller's company has a Person Server that speaks for them. Each trip is
an AAuth **mission**: the manager approves it once, budget and all; a booking
within it goes through at once, and one over what is left waits for the
manager.

To run it end to end, with the booking provider and the company's approval
page, use the [`aauth-travel` example](https://github.com/introspection-org/introspection-js-sdk/tree/main/examples/aauth-travel)
in the Introspection JS SDK.

## What this demonstrates

- An agent that acts **on behalf of a person**, never on its own authority.
- **No credential in the sandbox**: the platform is the Agent Provider. Its
  egress signs each request (RFC 9421) with the session's key and presents the
  best token it holds; the provider answers with a resource token, and the
  egress exchanges it at the company's Person Server for an auth token.
- **A trip is a mission**: `propose_trip` proposes the whole trip, with its
  budget, before anything is booked; `complete_trip` ends it. The mission and
  its tokens stay in the egress; the agent holds only its `s256`.
- **The company decides**: its Person Server weighs each booking against what
  is left of the trip's budget, and asks the manager when it is over.
  `pending` is a first-class state, not an error: the agent is told, and the
  conversation resumes when the manager decides.

## The four layers

A booking passes four layers, and each can only narrow what the next one sees:
the connector is the standing capability, the recipe uses it, the recipe's
**policies** are the builder's deterministic rails, and the traveller's
**company** decides each booking through its Person Server.

### 1. Connector: the organization's definition

Created once in the project, for example with the `introspection` CLI
(`introspection connectors create @booking.json`). It is the security boundary:
which provider, which hosts the egress signs for, and which Person Server
speaks for the people it serves.

```jsonc
{
  "name": "Flight Sector booking",
  "provider": "flightsector",
  "auth_mode": "aauth",
  "api_hosts": ["api.booking.example"],            // the egress signs requests to these
  "person_server_url": "https://ps.acme.example",  // where the egress exchanges resource tokens
  "application_id": "…",                           // the application whose client id is the agent's identity
  "policy_entities": [                             // what policies/ may read about each customer company
    { "uid": { "type": "Company", "id": "acme" }, "attrs": { "business_min_level": 5, "booking_limit_cents": 100000, "senior_booking_limit_cents": 250000 }, "parents": [] }
  ]
}
```

The recipe cannot set any of this: a recipe author does not decide the
organization's security boundary.

### 2. Recipe: the agent

`agents/agent.yaml` and `extensions/booking.js`. The tools make plain HTTPS
calls to `https://api.booking.example`; nothing in them holds a credential or
knows about AAuth.

That host is a placeholder: it resolves nowhere on its own. The project's
booking connector lists it in `api_hosts`, and its `aauth_upstream` names the
booking provider the egress actually sends to, signing for `aauth_resource`.
So the agent books only with that connector set up and a live AAuth booking
provider behind it, which the `aauth-travel` example runs and wires up.

### 3. Policies: the builder's rails (`policies/`)

[Cedar](https://www.cedarpolicy.com/) policies, versioned with the agent's
code, evaluated in the platform's egress on **every request** to a connector
host, before the traveller's company is asked:

```cedar
// policies/travel.cedar
@id("missionless-booking")
@reason("propose the trip first: a booking needs the traveller's approved mission")
forbid (principal, action == Action::"booking.reserve", resource)
unless { context has mission };

@id("business-by-seniority")
@reason("business class on the company's account needs the company's seniority, on a leg of six hours or more")
forbid (principal, action == Action::"booking.reserve", resource)
when { resource has cabin && resource.cabin == "business" && resource.payer == "company" }
unless {
  principal has level && principal has company &&
  principal.level >= principal.company.business_min_level &&
  resource has block_minutes && resource.block_minutes >= 360
};
```

A deny ends the request with its reason; an allow only lets it on to the
company's Person Server, which still decides. The same rule answers per
person: `level` is set by an organization owner on the traveller's member
(`introspection members update user:{id} --policy-attributes …`), and
`company` is an entity the booking connector carries. See
[`policies/README.md`](policies/README.md).

### 4. The company decides: AAuth

1. `propose_trip` posts the trip to `https://person-server.aauth/mission`; the
   egress takes it to the company's Person Server, and the manager approves it.
2. The egress signs each booking (RFC 9421) and presents the mission's person
   token.
3. The provider answers `401` with a resource token naming this one booking.
4. The egress takes it to the Person Server: within the trip's budget, an auth
   token at once; over what is left, `202` while it asks the manager.
5. When it is decided, the agent is told in the same conversation and books
   again.
6. `complete_trip` proposes the trip done; the traveller accepts, and the
   mission ends.

## Finding flights: Browserbase's MCP

Flights are found on the open web, then quoted by the booking provider. The
recipe declares Browserbase's hosted MCP in `package.json#pi.mcp` (`start`,
`navigate`, `extract`, `observe`, `end`; never `act`), and the agent uses
`start`, `navigate`, `extract` and `end` to read a Google Flights search.
`quote_flight` then asks the booking provider for its own offer on the flight it
picked, so the price proposed and booked is always the provider's signed fare,
never the page's.

The server is required, so a project binds it before a session starts: an `mcp`
endpoint with `mcp_server_id: browserbase`.

| Binding | URL | Credential |
| --- | --- | --- |
| Real | `https://mcp.browserbase.com/mcp` | header `Authorization: Bearer ${BROWSERBASE_API_KEY}`, a project credential |
| Mock | the `aauth-travel` example's `/mcp` | any bearer; it answers like the real server for recorded SFO⇄SYD searches, and lists the booking provider's flights for other routes |

## Run it

The `aauth-travel` example sets your project up with the `introspection` CLI,
including this recipe as a runtime:

```bash
introspection login
pnpm dev:public                  # in examples/aauth-travel
pnpm run introspection:setup
```

Or create the runtime yourself, from a repository Introspection hosts:

```bash
introspection repositories add travel-agent --provider introspection \
  --template https://github.com/introspection-org/recipe-travel-agent.git
git clone "$(introspection repositories list -o json --query "[?slug=='travel-agent'].url | [0]")" travel-agent
cd travel-agent && introspection runtimes create
```

## Layout

```text
.introspection/travel-agent.yaml   # the manifest Introspection discovers
agents/agent.yaml                  # the runnable travel agent
extensions/booking.js              # search_offers, quote_flight, book_item and the mission tools: plain HTTPS calls
policies/                          # Cedar rails: schema, travel rules, connector routes
SYSTEM.md                          # the base system prompt
```
