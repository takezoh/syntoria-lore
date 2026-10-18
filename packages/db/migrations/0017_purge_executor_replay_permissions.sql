GRANT SELECT ON public.principals TO thymesis_purge_executor;
GRANT UPDATE (checkpoint, state, last_error_code, updated_at)
  ON public.capture_jobs TO thymesis_purge_executor;
