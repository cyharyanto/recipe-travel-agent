// Booking: only under a granted, person-approved mission.
permit (
  principal,
  action == Action::"connector:use",
  resource == Connector::"booking"
)
when {
  context.mission.granted &&
  context.mission.subject == "person"
};
