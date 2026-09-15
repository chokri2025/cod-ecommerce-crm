BEGIN;

ALTER TABLE "order" ADD COLUMN "itemsSealedAt" TIMESTAMP(3);

CREATE TABLE "orderFxRecovery" (
  "orderId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "orderFxRecovery_pkey" PRIMARY KEY ("orderId"),
  CONSTRAINT "orderFxRecovery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "orderFxRecovery_actor" CHECK (length(btrim("actorId")) > 0)
);

CREATE OR REPLACE FUNCTION "protectOrderSnapshot"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable_columns text[] := ARRAY['contactId', 'ownerId', 'carrier', 'trackingNumber', 'status', 'statusChangedAt', 'confirmedAt', 'shippedAt', 'deliveredAt', 'cancelledAt', 'updatedAt', 'version', 'itemsSealedAt', 'reportingAmount', 'fxRate', 'fxRateAt', 'fxRateSource'];
BEGIN
  IF (to_jsonb(NEW) - mutable_columns) IS DISTINCT FROM (to_jsonb(OLD) - mutable_columns) THEN
    RAISE EXCEPTION 'Order commercial and recipient snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt")
     OR (OLD."shippedAt" IS NOT NULL AND NEW."shippedAt" IS DISTINCT FROM OLD."shippedAt")
     OR (OLD."deliveredAt" IS NOT NULL AND NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt")
     OR (OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt") THEN
    RAISE EXCEPTION 'Order lifecycle timestamps cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  IF (OLD."itemsSealedAt" IS NOT NULL AND NEW."itemsSealedAt" IS DISTINCT FROM OLD."itemsSealedAt")
     OR NEW."itemsSealedAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'Order item collection cannot be unsealed' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW."reportingAmount", NEW."fxRate", NEW."fxRateAt", NEW."fxRateSource")
     IS DISTINCT FROM ROW(OLD."reportingAmount", OLD."fxRate", OLD."fxRateAt", OLD."fxRateSource") THEN
    IF OLD."fxRate" IS NOT NULL OR NEW."fxRate" IS NULL
       OR NOT EXISTS (SELECT 1 FROM "orderFxRecovery" WHERE "orderId" = NEW.id)
       OR NEW."reportingAmount" IS DISTINCT FROM round(NEW.total * NEW."fxRate", CASE WHEN NEW."reportingCurrency" = 'JPY' THEN 0 ELSE 2 END) THEN
      RAISE EXCEPTION 'FX recovery requires a missing snapshot, matching amount and audit record' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

UPDATE "order" SET "itemsSealedAt" = "createdAt";

CREATE FUNCTION "orderTransitionAllowed"(previous "OrderStatus", next "OrderStatus") RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE previous
    WHEN 'NEW' THEN next IN ('CONFIRMED', 'CANCELLED')
    WHEN 'CONFIRMED' THEN next IN ('SHIPPED', 'CANCELLED')
    WHEN 'SHIPPED' THEN next IN ('IN_DELIVERY', 'RETURNED')
    WHEN 'IN_DELIVERY' THEN next IN ('DELIVERED', 'REFUSED', 'RETURNED')
    WHEN 'DELIVERED' THEN next = 'RETURNED'
    WHEN 'REFUSED' THEN next = 'RETURNED'
    ELSE false
  END;
$$;

CREATE FUNCTION "lockOrderChildInsert"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent "order"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT parent FROM "order" WHERE id = NEW."orderId" FOR UPDATE;
  IF TG_TABLE_NAME = 'orderItem' AND parent."itemsSealedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Order item collection is sealed' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'orderFxRecovery' AND parent."fxRate" IS NOT NULL THEN
    RAISE EXCEPTION 'Order FX snapshot is already established' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "orderItem_insert_guard" BEFORE INSERT ON "orderItem"
FOR EACH ROW EXECUTE FUNCTION "lockOrderChildInsert"();
CREATE TRIGGER "orderStatusEvent_insert_lock" BEFORE INSERT ON "orderStatusEvent"
FOR EACH ROW EXECUTE FUNCTION "lockOrderChildInsert"();
CREATE TRIGGER "orderFxRecovery_insert_guard" BEFORE INSERT ON "orderFxRecovery"
FOR EACH ROW EXECUTE FUNCTION "lockOrderChildInsert"();
CREATE TRIGGER "orderFxRecovery_immutable" BEFORE UPDATE OR DELETE ON "orderFxRecovery"
FOR EACH ROW EXECUTE FUNCTION "rejectOrderSnapshotMutation"();
CREATE TRIGGER "orderFxRecovery_no_truncate" BEFORE TRUNCATE ON "orderFxRecovery"
FOR EACH STATEMENT EXECUTE FUNCTION "rejectOrderSnapshotMutation"();

CREATE FUNCTION "validateOrderIntegrity"(order_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  parent "order"%ROWTYPE;
  latest "orderStatusEvent"%ROWTYPE;
  milestones record;
  item_total numeric;
  item_count bigint;
BEGIN
  SELECT * INTO STRICT parent FROM "order" WHERE id = order_id FOR UPDATE;
  SELECT * INTO latest FROM "orderStatusEvent" WHERE "orderId" = order_id ORDER BY version DESC LIMIT 1;
  IF NOT FOUND OR ROW(parent.status, parent.version, parent."statusChangedAt")
     IS DISTINCT FROM ROW(latest."newStatus", latest.version, latest."occurredAt") THEN
    RAISE EXCEPTION 'Order state must match latest status event' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT *, row_number() OVER w - 1 AS sequence,
        lag("newStatus") OVER w AS predecessor,
        lag("occurredAt") OVER w AS previous_time
      FROM "orderStatusEvent" WHERE "orderId" = order_id WINDOW w AS (ORDER BY version)
    ) chain
    WHERE version <> sequence
       OR (version = 0 AND ("newStatus" <> 'NEW' OR "previousStatus" IS NOT NULL OR "occurredAt" <> parent."createdAt"))
       OR (version > 0 AND ("previousStatus" IS DISTINCT FROM predecessor
         OR NOT "orderTransitionAllowed"(predecessor, "newStatus") OR "occurredAt" < previous_time))
       OR ("newStatus" IN ('REFUSED', 'RETURNED', 'CANCELLED') AND nullif(btrim(reason), '') IS NULL)
  ) THEN
    RAISE EXCEPTION 'Order status event chain is inconsistent' USING ERRCODE = '23514';
  END IF;
  SELECT min("occurredAt") FILTER (WHERE "newStatus" = 'CONFIRMED') AS confirmed,
    min("occurredAt") FILTER (WHERE "newStatus" = 'SHIPPED') AS shipped,
    min("occurredAt") FILTER (WHERE "newStatus" = 'DELIVERED') AS delivered,
    min("occurredAt") FILTER (WHERE "newStatus" = 'CANCELLED') AS cancelled
  INTO milestones FROM "orderStatusEvent" WHERE "orderId" = order_id;
  IF ROW(parent."confirmedAt", parent."shippedAt", parent."deliveredAt", parent."cancelledAt")
     IS DISTINCT FROM ROW(milestones.confirmed, milestones.shipped, milestones.delivered, milestones.cancelled) THEN
    RAISE EXCEPTION 'Order lifecycle timestamps must match status history' USING ERRCODE = '23514';
  END IF;
  SELECT sum("lineTotal"), count(*) INTO item_total, item_count FROM "orderItem" WHERE "orderId" = order_id;
  IF parent."itemsSealedAt" IS NULL OR parent."itemsSealedAt" < parent."createdAt"
     OR item_count = 0 OR item_total IS DISTINCT FROM parent.subtotal THEN
    RAISE EXCEPTION 'Order items must be sealed and match subtotal' USING ERRCODE = '23514';
  END IF;
  IF parent."fxRate" IS NULL AND EXISTS (SELECT 1 FROM "orderFxRecovery" WHERE "orderId" = order_id) THEN
    RAISE EXCEPTION 'FX recovery audit requires a complete snapshot' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION "checkOrderIntegrity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'order' THEN
    PERFORM "validateOrderIntegrity"(NEW.id);
  ELSE
    PERFORM "validateOrderIntegrity"(NEW."orderId");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "order_integrity" AFTER INSERT OR UPDATE ON "order"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "checkOrderIntegrity"();
CREATE CONSTRAINT TRIGGER "orderStatusEvent_integrity" AFTER INSERT ON "orderStatusEvent"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "checkOrderIntegrity"();
CREATE CONSTRAINT TRIGGER "orderFxRecovery_integrity" AFTER INSERT ON "orderFxRecovery"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "checkOrderIntegrity"();

DO $$
DECLARE existing_id text;
BEGIN
  FOR existing_id IN SELECT id FROM "order" LOOP
    PERFORM "validateOrderIntegrity"(existing_id);
  END LOOP;
END;
$$;

COMMIT;
