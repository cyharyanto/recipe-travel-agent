# Travel Agent Recipe

A Git-backed Introspection recipe: **Flight Sector's travel agent**, which books
work travel for a company's employees from a Slack DM, through an `aauth`
**connector**. The booking provider is a native [AAuth](https://github.com/dickhardt/AAuth)
resource and the employee's company runs the Person Server that speaks for
them: in policy a booking goes through at once, over policy it waits for their
manager.

Design: `introspection-cloud/docs/design/connectors-aauth-b2b2c.md` (§12.3 the
AAuth agent, §18 the `connectors:` recipe block).

## What this demonstrates

- An agent that acts **on behalf of a person**, never on its own authority.
- **No credential in the sandbox**: the platform is the Agent Provider. Egress
  signs each request (RFC 9421) with the session's key and presents the agent
  token; the provider answers with a resource token, and egress exchanges it at
  the company's Person Server for an auth token.
- **The company decides**: Acme's Person Server applies its own policy to the
  provider-signed quote, and asks the employee's manager when a booking is over
  it. `pending` is a first-class state, not an error: the agent is told, and
  the chat resumes when the manager decides.

## The full scope — four layers

A person-authorized action spans four layers. The connector is the standing
capability, the recipe references it, the recipe's **policies** are the
deterministic rails around it, and the **mission** is the per-action envelope a
human approves at runtime. Config defines the *ceiling*; the mission is the
*instance*.

### 1. Connector — the org-side definition (Control Plane)

Created once, org-side (the "Add connector" UI / `POST /v1/connectors`). This is
the security boundary: which provider, which action scopes, who hosts approval,
and how missions are decided.

```jsonc
{
  "name": "Booking",
  "provider": "booking",
  "auth_mode": "aauth",
  "subject_scope": "person",
  "scopes": ["booking.reserve"],              // the action classes this connector allows
  "api_hosts": ["api.booking.example"],       // egress allowlist; egress signs requests to these
  "person_server_url": "https://ps.acme.example", // the agent token's `ps`: where egress exchanges resource tokens
  "application_id": "…"                       // the Agent Provider client the agent token names
}
```

`approval_policy` lives **here, not in the recipe** — a recipe author cannot set
the org's security boundary. The judge is an approver rung *under* a
human-granted policy, never the boundary itself.

### 2. Recipe — the agent references + scopes the connector

Planned: `agents/agent.yaml` will name connectors and narrow scopes (the same
split as MCP servers — the definition is org-side). The recipe loader rejects
unknown keys today, so this block is not in the file yet:

```yaml
connectors:
  booking:
    subject: person          # act on the customer's behalf
    scopes: [booking.reserve] # subset of the connector's scopes this agent needs
  gmail:
    subject: person
    scopes: [gmail.send]
  stripe: # payment step-up: a second, higher-stakes approval
    subject: person
    scopes: [charge]
```

### 3. Policies — deterministic rails (`policies/*.cedar`)

[Cedar](https://www.cedarpolicy.com/) policies, versioned with the agent's code,
evaluated by the platform on **every token request**. Missions are what a human
approves; policies are the hard rail *around* the approval — deterministic,
immune to prompt injection or an over-persuaded approver:

```cedar
// policies/payments.cedar — holds regardless of what was approved upstream
permit (principal, action == Action::"connector:use", resource == Connector::"stripe")
when {
  context.mission.granted &&
  context.mission.subject == "person" &&
  context.mission has amount_cents && context.mission.amount_cents <= 50000 &&
  context.mission has single_use && context.mission.single_use
};
```

If `policies/` exists, connector use is **default-deny**: only what a policy
permits can mint. Each layer only narrows the previous one (org config ∩ recipe
policies ∩ mission). Loosening a rail requires a commit + redeploy — the review
gate. See [`policies/README.md`](policies/README.md) for validation.

### 4. Mission — the per-action envelope (runtime)

The mission is **not configuration**: its envelope (which offer, the real amount)
is specific to each booking, so the tool declares it on the request. It maps 1:1
to `MissionConstraints`. [`extensions/booking.js`](extensions/booking.js) sends it
in an `Introspection-Mission` header, the only approval-aware line in the recipe:

```jsonc
// book_item → POST /v1/reserve, with
// Introspection-Mission: {"action": "hotel.reserve", "requested_permissions": {
//   "host": "api.booking.example", "resource": "<offer_id>",
//   "limits": {"amount_max": 1680, "nightly_rate": 420, "count": 1}}}
```

What happens next is the platform's, not the recipe's
(`introspection-cloud` `docs/design/connectors-aauth-b2b2c.md` §12.2):

1. The egress mission gate answers the reservation `428 mission-required`; the
   provider token is never injected.
2. The runtime reports the declared mission. The control plane opens it and hands
   it to the company's own Person Server (the connector's `person_server_url`),
   and the tool result tells the agent the booking was sent for approval.
3. The Person Server applies its company's policy: within the nightly cap it
   approves at once; over it, it asks the traveller's manager.
4. When it is decided, the agent is told in the same DM. It retries, the gate
   lets that one request through with the injected token, and the booking lands.

## Status

- **Live on the platform branch:** the mission gate, opening missions for a
  sandbox session, the hand-off to a `byo` Person Server, and the resume.
- **Example:** `introspection-js-sdk` `examples/aauth-travel` runs the booking
  provider and Acme's Person Server.
- **Policies:** `policies/*.cedar` validate in CI; nothing evaluates them at
  runtime. The company's policy lives in its Person Server.
- **What the gate binds:** an approval lets through one request, declaring the
  approved `resource` (the offer id). It does not read the request body, so it
  trusts the tool to declare the offer it books, as `book_item` does.

## Register it as a runtime

Register alongside `coding-agent`: **New runtime → From existing recipe →** pick
this repo/branch → `.introspection/travel-agent.yaml`. Local dev seeds it via
`make seed-travel-agent` (wired into `make dev-partner`). It skips gracefully
until this repo is pushed + linked to the project; enable an explicit run with
`SEED_TRAVEL_AGENT_RUNTIME=true make seed-runtimes`.

## Layout

```text
.introspection/travel-agent.yaml   # the GitOps manifest Introspection discovers
agents/agent.yaml                  # the runnable travel agent
extensions/booking.js              # search_offers + book_item, declaring each booking's mission
policies/                          # Cedar policy rails (schema + booking/payments)
SYSTEM.md                          # the base system prompt
```
