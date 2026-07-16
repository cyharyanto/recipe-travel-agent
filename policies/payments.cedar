// Payments: person-granted, single-use, and hard-capped at $500 — a
// deterministic rail that holds regardless of what a judge (or a
// socially-engineered human) approved upstream. Raising the cap requires a
// commit + redeploy, which is the review gate.
permit (
  principal,
  action == Action::"connector:use",
  resource == Connector::"stripe"
)
when {
  context.mission.granted &&
  context.mission.subject == "person" &&
  context.mission has amount_cents && context.mission.amount_cents <= 50000 &&
  context.mission has currency && context.mission.currency == "usd" &&
  context.mission has single_use && context.mission.single_use
};
