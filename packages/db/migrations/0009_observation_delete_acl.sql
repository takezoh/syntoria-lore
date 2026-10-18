-- Source observations anchor immutable provenance and must not be deleted by the runtime role.
REVOKE DELETE ON TABLE observations FROM thymesis_app;
