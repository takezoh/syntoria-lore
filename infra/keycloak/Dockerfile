ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.8.1@sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244
ARG NODE_IMAGE=node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

FROM ${KEYCLOAK_IMAGE} AS keycloak-build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true --features=resource-indicators

FROM ${KEYCLOAK_IMAGE} AS keycloak
COPY --from=keycloak-build --chown=keycloak:keycloak /opt/keycloak/ /opt/keycloak/
COPY --chown=keycloak:keycloak bootstrap.sh /opt/keycloak/cloud-oauth-bootstrap.sh
RUN chmod 0755 /opt/keycloak/cloud-oauth-bootstrap.sh
USER keycloak
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_HTTP_ENABLED=true \
    KC_HTTP_PORT=8081 \
    KC_HTTP_HOST=127.0.0.1 \
    KC_HTTP_MANAGEMENT_PORT=9000 \
    KC_HTTP_MANAGEMENT_HOST=0.0.0.0 \
    KC_PROXY_HEADERS=xforwarded \
    KC_PROXY_TRUSTED_ADDRESSES=127.0.0.1,::1 \
    KC_DB_TLS_MODE=verify-server \
    KC_DB_POOL_MAX_SIZE=10 \
    KC_CACHE=ispn \
    KC_CACHE_STACK=jdbc-ping
EXPOSE 8081
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]

FROM ${NODE_IMAGE} AS proxy
WORKDIR /app
COPY --chown=node:node proxy.mjs /app/proxy.mjs
USER node
ENV NODE_ENV=production PORT=8080 IDENTITY_BACKEND_URL=http://127.0.0.1:8081
EXPOSE 8080
ENTRYPOINT ["node", "/app/proxy.mjs"]
