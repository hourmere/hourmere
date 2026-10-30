-- Legacy attempt counts have no recorded attempt time. Add no backfill: metadata
-- updates and SMTP outcomes must never invent one from updated_at or acceptance.
ALTER TABLE public.invitation_deliveries
  ADD COLUMN last_attempt_at timestamptz;

CREATE FUNCTION public.record_invitation_delivery_attempt_time() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.attempts > 0 THEN
      NEW.last_attempt_at := clock_timestamp();
    ELSE
      NEW.last_attempt_at := NULL;
    END IF;
  ELSIF NEW.attempts = 0 THEN
    NEW.last_attempt_at := NULL;
  ELSIF NEW.generation <> OLD.generation OR NEW.attempts > OLD.attempts THEN
    NEW.last_attempt_at := clock_timestamp();
  ELSE
    NEW.last_attempt_at := OLD.last_attempt_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invitation_delivery_attempt_time
  BEFORE INSERT OR UPDATE ON public.invitation_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.record_invitation_delivery_attempt_time();
