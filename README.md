# Travel Agent Recipe

A Git-backed Introspection recipe: a **travel agent** that books trips **on a
customer's behalf** via a `person_authorized` **connector**, with per-action
human approval through a Person Server. The recipe counterpart to the
`apps/partner` `/travel-agent` demo — this is the *authoring* model.

Design: `introspection-cloud/docs/design/connectors-aauth-b2b2c.md` (§17 mission
judge, §18 the `connectors:` recipe block).

## What this demonstrates

- An agent that acts **on behalf of a person**, never on its own authority.
- **Connectors as a recipe concern**: the agent declares which connectors it may
  use + the subset of scopes it needs — see the `connectors:` block in
  [`agents/agent.yaml`](agents/agent.yaml).
- **Per-action approval**: high-stakes actions (book, email) go through a Person
  Server; `pending` is a first-class state, not an error.
- **Deterministic policy rails**: [`policies/*.cedar`](policies/) hard-cap what
  any approval can grant — the payment step-up is capped at $500 single-use no
  matter who (or what) approved it.

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
  "auth_mode": "person_authorized",
  "subject_scope": "person",
  "scopes": ["booking.reserve"],              // the action classes this connector allows
  "api_hosts": ["api.booking.example"],       // egress allowlist
  "person_server_mode": "managed",            // managed (hosted by us) | byo | discovered
  "approval_policy": "judge_advises_human"     // human | judge_advises_human | judge_auto_within_envelope
}
```

`approval_policy` lives **here, not in the recipe** — a recipe author cannot set
the org's security boundary. The judge is an approver rung *under* a
human-granted policy, never the boundary itself.

### 2. Recipe — the agent references + scopes the connector

`agents/agent.yaml` only names connectors and narrows scopes (the same split as
MCP servers — the definition is org-side):

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

The mission is **not configuration** — its envelope (which hotel, which dates,
the real amount, the recipient) is specific to each action, so the agent authors
it at `getToken` time and the customer approves (or narrows) it. It maps 1:1 to
`MissionConstraints`:

```jsonc
// the agent's getToken call for one booking
getToken("booking.reserve", {
  subject: "person",
  requested_permissions: {          // MissionConstraints — the envelope
    host: "api.booking.example",    // request-audience lock
    resource: "hotel:barcelona-arts", // recipient/resource lock the human sees
    limits: { amount_max: 2400, count: 1 },
    window_start: "2026-08-12T00:00:00Z",
    window_end:   "2026-08-15T00:00:00Z"
  }
})
// → 202 { status: "authorization_pending", mission_id, approval_url }
//   Person Server: "Book hotel:barcelona-arts, 12–15 Aug, ≤ €2,400 — approve?"
//   human approves → signed AAuth auth token (PoP) → resource token, bound to the granted envelope
```

For `gmail.send` the same shape carries `resource: "alice@example.com"` (the
recipient) instead of an amount. The connector's `approval_policy` decides
whether a judge advises or (within the envelope) may auto-approve; the
deterministic envelope binds byte-exact regardless of the verdict.

## What's live vs pending

- **Live:** connector CRUD + the `person_authorized` broker branch (creates a
  pending mission, returns `approval_url`), behind `CONNECTORS_ENABLED`.
- **Pending — the two pieces that make the envelope real end-to-end:**
  1. **`getToken` action + `requested_permissions`** — `BrokerTokenRequest`
     carries only `{connector_id, subject}` today, so the mission is created with
     an *empty* envelope. Plumbing `action` + `requested_permissions` through is
     what fills the mission above.
  2. **Runtime `getToken` SDK** (§7) — so the in-sandbox agent can call the broker.
- **Optional follow-up:** a connector-level `mission_bounds` ceiling every mission
  must fit inside (what makes `judge_auto_within_envelope` safe).
- **Validator:** Recipe validation ignores unknown agent keys today, so the
  `connectors:` block validates now; a future Recipes schema update will add
  this key (+ a `strict: true` mode).
- **Policies:** the `policies/*.cedar` rails validate in CI now (Cedar CLI
  against `policies/schema.cedarschema`); platform-side evaluation at token-mint
  time is pending.

Until the runtime SDK lands, the agent describes the intended action + the
approval it needs.

## Register it as a runtime

Register alongside `coding-agent`: **New runtime → From existing recipe →** pick
this repo/branch → `.introspection/travel-agent.yaml`. Local dev seeds it via
`make seed-travel-agent` (wired into `make dev-partner`). It skips gracefully
until this repo is pushed + linked to the project; enable an explicit run with
`SEED_TRAVEL_AGENT_RUNTIME=true make seed-runtimes`.

## Layout

```text
.introspection/travel-agent.yaml   # the GitOps manifest Introspection discovers
agents/agent.yaml                  # the runnable travel agent (+ the connectors: block)
policies/                          # Cedar policy rails (schema + booking/payments)
SYSTEM.md                          # the base system prompt
```
