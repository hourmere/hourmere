-- Calendar scheduling identity belongs to a UID's lifetime. Existing bookings keep
-- the host organizer policy; only bookings created after this migration use v2.
ALTER TABLE bookings
  ADD COLUMN ical_version integer NOT NULL DEFAULT 1 CHECK (ical_version IN (1,2)),
  ADD COLUMN ical_organizer_name text,
  ADD COLUMN ical_organizer_email text,
  ADD CONSTRAINT bookings_ical_identity CHECK (
    (ical_organizer_name IS NULL AND ical_organizer_email IS NULL) OR
    (ical_organizer_name IS NOT NULL AND char_length(ical_organizer_name) BETWEEN 1 AND 320
      AND ical_organizer_name !~ '[[:cntrl:]]'
      AND ical_organizer_email IS NOT NULL AND char_length(ical_organizer_email) BETWEEN 3 AND 320
      AND ical_organizer_email !~ '[[:space:][:cntrl:]]'));
ALTER TABLE bookings ALTER COLUMN ical_version SET DEFAULT 2;

-- Capture the best surviving historical identity, preferring an actual conference
-- snapshot over today's host account. Deleted/unverified/nonmember hosts cannot
-- establish a new identity. A UID with no recoverable identity remains null.
-- Preserve every historical booking timestamp during this metadata backfill.
ALTER TABLE bookings DISABLE TRIGGER bookings_updated_at;
WITH identities AS (
  SELECT b.id, coalesce(c.invitation_organizer_name,h.name) AS name,
    coalesce(c.invitation_organizer_email,h.email) AS email
  FROM bookings b
  LEFT JOIN LATERAL (
    SELECT invitation_organizer_name,invitation_organizer_email
    FROM booking_conferences c
    WHERE (c.root_booking_id=b.id OR c.booking_id=b.id)
      AND invitation_organizer_name IS NOT NULL AND invitation_organizer_email IS NOT NULL
    ORDER BY (c.root_booking_id=b.id) DESC,c.root_booking_id LIMIT 1
  ) c ON true
  LEFT JOIN LATERAL (
    -- Match notification host ordering and name.trim() || profile.handle || email.
    -- Empty display names must not move an existing UID to another organizer.
    -- The trim character set is ECMAScript's whitespace and line terminators.
    -- Malformed historical CNs are bounded and cleaned without changing mailbox.
    SELECT left(coalesce(nullif(btrim(regexp_replace(u.name,'[[:cntrl:]]',' ','g'),
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),''),p.handle,u.email),320) AS name,
      u.email FROM booking_hosts h
    JOIN auth."user" u ON u.id=h.user_id
    JOIN auth.member m ON m."userId"=u.id AND m."organizationId"=b.organization_id
    LEFT JOIN profiles p ON p.user_id=u.id
    WHERE h.booking_id=b.id AND u."emailVerified"
      AND char_length(u.email) BETWEEN 3 AND 320 AND u.email !~ '[[:space:][:cntrl:]]'
    ORDER BY u.id LIMIT 1
  ) h ON true
)
UPDATE bookings b SET ical_organizer_name=i.name,ical_organizer_email=i.email
FROM identities i WHERE i.id=b.id AND i.email IS NOT NULL;
ALTER TABLE bookings ENABLE TRIGGER bookings_updated_at;
