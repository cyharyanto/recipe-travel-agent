# Policies — deterministic connector guardrails

`policies/*.cedar` are [Cedar](https://www.cedarpolicy.com/) policies, versioned
with the agent's code, that the platform evaluates **every time the agent
requests a connector token**. They are the deterministic layer of a
three-layer, narrow-only model:

```text
org connector config (ceiling)         # scopes, approval policy — set in the org
  ∩ recipe policies (this directory)   # .cedar rails, versioned with the code
    ∩ mission grant (per action)       # what the human actually approved
```

Each layer can only **narrow** the one above it. A policy here cannot widen
what the org's connector allows; a mission cannot exceed what these policies
permit. If this directory exists, connector use is **default-deny**: only what
a policy explicitly permits can mint a token. Deleting or loosening a policy
takes effect only when the new commit is deployed — deployment is the review
gate.

## Why both missions *and* policies?

The mission is what a human approves at run time — semantic, per-action, and
(under `judge_*` approval policies) advised by an LLM. Policies are the hard
rail *around* that: written ahead of time, evaluated deterministically, immune
to prompt injection or an over-persuaded approver. In this recipe:
`payments.cedar` caps any charge at $500 single-use — a $2,000 charge is denied
even if it was approved upstream.

## Validating

The schema (`schema.cedarschema`) defines the entities and the context shape
the platform supplies. Validate the policies against it with the Cedar CLI:

```bash
cargo install cedar-policy-cli --locked
cat policies/*.cedar > /tmp/policyset.cedar
cedar validate --schema policies/schema.cedarschema --policies /tmp/policyset.cedar
```

CI runs the same check on every push (`.github/workflows/recipe-validation.yml`),
so a policy that doesn't parse or references attributes the platform never
supplies fails the build — not the production request. At run time the platform
re-validates on deploy and fails **closed**: an invalid policy set denies, never
falls open.
