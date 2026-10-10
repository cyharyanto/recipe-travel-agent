# Policies: the agent builder's rails

`policies/` holds [Cedar](https://www.cedarpolicy.com/) policies that the
platform evaluates in its egress on every request to a connector host, before
the traveller's company is asked (introspection-cloud
`docs/design/connectors-aauth-b2b2c.md` §19).

| File | What it is |
| --- | --- |
| `schema.cedarschema` | The entities and actions the policies see |
| `*.cedar` | The rules |
| `routes.yaml` | For each connector, which requests map to which action, and where the resource's attributes come from |

There are two outcomes:

- **deny**: the agent gets `403` with the rule's `@reason`, and nothing else is asked.
- **allow**: the request goes on to the connector's own gate (the company's Person Server), which still decides.

A permit never replaces a person.

A route can ask for the session's approved AAuth mission as Cedar context
(`context: [mission]` gives `context.mission = {s256, resources}`).
`missionless-booking` uses it to refuse any booking outside an approved trip.

A route can also name a mission judge in `judges/` (`judge: booking`). Before
Cedar decides, the platform asks TypeSafe's Jev the judge's yes-or-no questions
about the request, against the traveller's own words, which the data plane
recorded and the agent can neither write nor see. Each answer reaches Cedar as
a percentage in `context.judgement` (`context: [judgement]`), and is absent
when Jev cannot answer, so a rule that requires one fails closed:

| Judge | Asked on | Rules that read it |
| --- | --- | --- |
| `judges/booking.yaml` | every reservation | `asked-for` (`requested` >= 60), `personal-is-the-travellers` (`personal` >= 70) |
| `judges/mission-proposal.yaml` | the trip the agent proposes to the Person Server | `proposed-as-asked` (`requested` >= 60) |

A judge's `attrs` names the resource attributes Jev sees. The booking judge
names only what the provider signed in its quote, never the agent's claimed
`purpose` or `payer`.

The same policy answers differently per person: the principal's `level` comes
from attributes an org owner sets on the member (`PATCH /v1/members/{id}`,
`policy_attributes`), and their `company` from entities the booking connector
carries (`policy_entities`). Policy that is the customer's own, such as
a trip's budget and who approves, stays with the customer's Person Server.

The platform reads these files at the deployed commit and fails closed: a
policy set that does not parse or validate denies every governed request. CI
validates them with the Cedar CLI (`.github/workflows/recipe-validation.yml`).
