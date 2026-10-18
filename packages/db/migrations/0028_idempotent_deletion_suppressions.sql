DELETE FROM public.suppressions duplicate
USING public.suppressions retained
WHERE duplicate.owner_id=retained.owner_id
  AND duplicate.scope_id=retained.scope_id
  AND duplicate.deletion_request_id=retained.deletion_request_id
  AND duplicate.object_kind=retained.object_kind
  AND duplicate.ctid > retained.ctid
  AND ((duplicate.object_id IS NOT NULL AND duplicate.object_id=retained.object_id)
    OR (duplicate.locator_hmac IS NOT NULL AND duplicate.locator_hmac=retained.locator_hmac));

CREATE UNIQUE INDEX suppressions_request_object_id_unique
  ON public.suppressions(owner_id, scope_id, deletion_request_id, object_kind, object_id)
  WHERE object_id IS NOT NULL;
CREATE UNIQUE INDEX suppressions_request_locator_hmac_unique
  ON public.suppressions(owner_id, scope_id, deletion_request_id, object_kind, locator_hmac)
  WHERE locator_hmac IS NOT NULL;
