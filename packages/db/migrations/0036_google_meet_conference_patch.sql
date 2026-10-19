-- Import may retain a createRequest forever without processing it. Acknowledged
-- conference PATCHes are tracked separately so legacy pending imports get one
-- same-request-ID PATCH, while normal polling never resubmits an acknowledged one.
-- NULL preserves existing rows and deliberately does not imply a PATCH occurred.
ALTER TABLE booking_conferences ADD COLUMN conference_patch_request_id uuid;
