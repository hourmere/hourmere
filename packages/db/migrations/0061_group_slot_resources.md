# Group slot resources

This additive migration keeps individual bookings and their resource protocols intact.
Group slots gain an immutable selected location option; existing snapshots receive the
legacy option identity without changing their seat, occupancy or response history.
Subsequent seats must use that exact selected option. The resolved shared conference
URL belongs to the slot conference intent, separate from immutable location configuration.

Calendar mappings, conference intents, host messages and host delivery receipts belong
to the slot generation. No attendee acts as the owner of shared resources. Terminal
slots retain resource identities for bounded cleanup; replacement generations have new
identities. The notification context view projects the relevant resource identity and
readiness to each seat for delivery checks. It does not transfer ownership or join any
attendee data across seats.

Stop old workers before applying this migration and start the matching worker/server
release before enabling group service callers. Group mode remains absent from public
creation/configuration surfaces in this service-layer release. Use the documented
backup/restore procedure for rollback.

The upgrade test starts at migration 0060 with two occupied seats, a shared location,
private responses and host occupancy. It verifies preservation, location backfill,
immutable/shared option enforcement, fresh-schema equality and a no-op rerun. All SQL
runs against owned throwaway test databases.
