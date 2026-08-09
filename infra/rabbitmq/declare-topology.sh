#!/bin/sh
# Declares the ADR 0011/0014 queue topology, idempotently, via the management API.
# Runs as the one-shot `mq-topology` compose job after the broker is healthy.
# Every PUT is a no-op when the object already exists with identical properties,
# and FAILS LOUDLY (broker-side 400) if it exists with different ones — which is
# exactly the behaviour we want on an accidental drift.
set -eu

BASE="http://rabbitmq:15672/api"
AUTH="$RABBITMQ_USER:$RABBITMQ_PASSWORD"
N="$MQ_PARTITION_COUNT"
LIMIT="$MQ_DELIVERY_LIMIT"

req() {
  method="$1"; path="$2"; body="${3:-}"
  if [ -n "$body" ]; then
    code=$(curl -s -o /tmp/resp -w '%{http_code}' -u "$AUTH" \
      -H 'content-type: application/json' -X "$method" "$BASE$path" -d "$body")
  else
    code=$(curl -s -o /tmp/resp -w '%{http_code}' -u "$AUTH" -X "$method" "$BASE$path")
  fi
  case "$code" in
    2*) ;;
    *) echo "FATAL: $method $path -> HTTP $code: $(cat /tmp/resp)"; exit 1 ;;
  esac
}

# ---- The immutability guard (ADR 0014) -------------------------------------
# The partition count is EFFECTIVELY IMMUTABLE once real traffic has flowed:
# changing it re-routes existing users to different partitions and breaks the
# per-user ordering guarantee the whole scheme exists for (ADR 0011). A broker
# that already carries a different count is therefore a deployment error, not
# something to silently "fix" by adding queues.
existing=$(curl -s -u "$AUTH" "$BASE/queues/%2F" | tr ',' '\n' | grep -c '"name":"loc.events.p' || true)
if [ "$existing" -gt 0 ] && [ "$existing" -ne "$N" ]; then
  echo "FATAL: broker already has $existing loc.events.p* partition queues but MQ_PARTITION_COUNT=$N."
  echo "The partition count is effectively immutable in production (ADR 0011/0014):"
  echo "changing it re-routes users to different partitions and breaks per-user ordering."
  echo "If this is a deliberate re-partitioning, drain and DELETE the old queues explicitly first."
  exit 1
fi

# ---- Exchanges ---------------------------------------------------------------
# x-consistent-hash routes by hashing the ROUTING KEY (= userId, N4B). The DLX is
# a fanout so dead-lettered messages land in loc.dead regardless of their
# original routing key.
req PUT "/exchanges/%2F/loc.events" '{"type":"x-consistent-hash","durable":true}'
req PUT "/exchanges/%2F/loc.dlx"    '{"type":"fanout","durable":true}'

# ---- Dead-letter queue -------------------------------------------------------
req PUT  "/queues/%2F/loc.dead" '{"durable":true,"arguments":{"x-queue-type":"quorum"}}'
req POST "/bindings/%2F/e/loc.dlx/q/loc.dead" '{"routing_key":""}'

# ---- Partition queues --------------------------------------------------------
# On a consistent-hash exchange the binding "routing key" is the WEIGHT — "1"
# gives every partition an equal share of the hash ring.
i=0
while [ "$i" -lt "$N" ]; do
  req PUT  "/queues/%2F/loc.events.p$i" '{"durable":true,"arguments":{"x-queue-type":"quorum"}}'
  req POST "/bindings/%2F/e/loc.events/q/loc.events.p$i" '{"routing_key":"1"}'
  i=$((i + 1))
done

# ---- Retry policy ------------------------------------------------------------
# delivery-limit + dead-letter-exchange live in a POLICY, not queue arguments:
# queue arguments are frozen at declaration (changing them errors), a policy is
# mutable at runtime — the retry count can be tuned without re-declaring or
# re-creating queues. After MQ_DELIVERY_LIMIT redeliveries a message is
# dead-lettered to loc.dlx -> loc.dead instead of looping forever.
req PUT "/policies/%2F/loc-partitions" \
  "{\"pattern\":\"^loc\\\\.events\\\\.p\",\"apply-to\":\"queues\",\"definition\":{\"dead-letter-exchange\":\"loc.dlx\",\"delivery-limit\":$LIMIT}}"

echo "topology OK: loc.events (x-consistent-hash) -> $N quorum partitions, DLQ loc.dead, delivery-limit $LIMIT (policy)"
