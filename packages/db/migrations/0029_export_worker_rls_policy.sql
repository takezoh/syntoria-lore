CREATE POLICY export_jobs_worker_executor ON public.export_jobs
  USING (current_user = 'thymesis_purge_executor')
  WITH CHECK (current_user = 'thymesis_purge_executor');
