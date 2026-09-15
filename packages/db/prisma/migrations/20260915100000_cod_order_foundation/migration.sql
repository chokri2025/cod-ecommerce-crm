BEGIN;
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'CONFIRMED', 'SHIPPED', 'IN_DELIVERY', 'DELIVERED', 'REFUSED', 'RETURNED', 'CANCELLED');

CREATE TABLE "order" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "contactId" TEXT,
    "ownerId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "shippingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "reportingCurrency" TEXT NOT NULL,
    "reportingAmount" DECIMAL(24,4),
    "fxRate" DECIMAL(20,10),
    "fxRateAt" TIMESTAMP(3),
    "fxRateSource" TEXT,
    "recipientName" TEXT NOT NULL,
    "normalizedPhone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "country" TEXT NOT NULL,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "sourceSystem" TEXT NOT NULL DEFAULT 'manual',
    "sourceAccount" TEXT NOT NULL DEFAULT '',
    "externalOrderId" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "fbclid" TEXT,
    "fbp" TEXT,
    "fbc" TEXT,
    "campaignId" TEXT,
    "adsetId" TEXT,
    "adId" TEXT,
    "landingPage" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "orderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sku" TEXT,
    "productName" TEXT NOT NULL,
    "variant" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "orderItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "orderStatusEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "previousStatus" "OrderStatus",
    "newStatus" "OrderStatus" NOT NULL,
    "version" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "sourceSystem" TEXT NOT NULL,
    "sourceAccount" TEXT NOT NULL DEFAULT '',
    "reason" TEXT,
    "externalEventId" TEXT,

    CONSTRAINT "orderStatusEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_orderNumber_key" ON "order"("orderNumber");

CREATE INDEX "order_contactId_idx" ON "order"("contactId");

CREATE INDEX "order_ownerId_idx" ON "order"("ownerId");

CREATE INDEX "order_status_createdAt_idx" ON "order"("status", "createdAt");

CREATE INDEX "order_deliveredAt_idx" ON "order"("deliveredAt");

CREATE INDEX "order_carrier_trackingNumber_idx" ON "order"("carrier", "trackingNumber");

CREATE UNIQUE INDEX "order_sourceSystem_sourceAccount_externalOrderId_key" ON "order"("sourceSystem", "sourceAccount", "externalOrderId");

CREATE INDEX "orderItem_orderId_idx" ON "orderItem"("orderId");

CREATE INDEX "orderStatusEvent_orderId_occurredAt_idx" ON "orderStatusEvent"("orderId", "occurredAt");

CREATE UNIQUE INDEX "orderStatusEvent_sourceSystem_sourceAccount_externalEventId_key" ON "orderStatusEvent"("sourceSystem", "sourceAccount", "externalEventId");

CREATE UNIQUE INDEX "orderStatusEvent_orderId_version_key" ON "orderStatusEvent"("orderId", "version");

ALTER TABLE "order" ADD CONSTRAINT "order_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "order" ADD CONSTRAINT "order_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "orderItem" ADD CONSTRAINT "orderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orderStatusEvent" ADD CONSTRAINT "orderStatusEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order" ADD CONSTRAINT "order_amounts_check" CHECK (
  "subtotal" >= 0 AND "discount" >= 0 AND "shippingCharge" >= 0
  AND "discount" <= "subtotal" AND "total" = "subtotal" - "discount" + "shippingCharge"
  AND "version" >= 0
);

ALTER TABLE "order" ADD CONSTRAINT "order_fx_check" CHECK (
  ("reportingAmount" IS NULL AND "fxRate" IS NULL AND "fxRateAt" IS NULL AND "fxRateSource" IS NULL)
  OR ("reportingAmount" >= 0 AND "reportingAmount" IS NOT NULL AND "fxRate" > 0
      AND "fxRate" IS NOT NULL AND "fxRateAt" IS NOT NULL AND "fxRateSource" IS NOT NULL)
);

ALTER TABLE "order" ADD CONSTRAINT "order_external_identity_check" CHECK (
  "externalOrderId" IS NULL OR (length(btrim("externalOrderId")) > 0 AND length(btrim("sourceAccount")) > 0)
);

ALTER TABLE "orderItem" ADD CONSTRAINT "orderItem_amounts_check" CHECK (
  "quantity" > 0 AND "unitPrice" >= 0 AND "discount" >= 0 AND "lineTotal" >= 0
  AND "lineTotal" = "quantity" * "unitPrice" - "discount"
);

ALTER TABLE "orderStatusEvent" ADD CONSTRAINT "orderStatusEvent_shape_check" CHECK (
  "version" >= 0 AND "occurredAt" <= "receivedAt"
  AND (("version" = 0 AND "previousStatus" IS NULL AND "newStatus" = 'NEW')
       OR ("version" > 0 AND "previousStatus" IS NOT NULL AND "previousStatus" <> "newStatus"))
  AND ("externalEventId" IS NULL OR (length(btrim("externalEventId")) > 0 AND length(btrim("sourceAccount")) > 0))
);

CREATE FUNCTION "rejectOrderSnapshotMutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Order snapshots and status history are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "orderStatusEvent_immutable" BEFORE UPDATE OR DELETE ON "orderStatusEvent"
FOR EACH ROW EXECUTE FUNCTION "rejectOrderSnapshotMutation"();
CREATE TRIGGER "orderStatusEvent_no_truncate" BEFORE TRUNCATE ON "orderStatusEvent"
FOR EACH STATEMENT EXECUTE FUNCTION "rejectOrderSnapshotMutation"();
CREATE TRIGGER "orderItem_immutable" BEFORE UPDATE OR DELETE ON "orderItem"
FOR EACH ROW EXECUTE FUNCTION "rejectOrderSnapshotMutation"();
CREATE TRIGGER "orderItem_no_truncate" BEFORE TRUNCATE ON "orderItem"
FOR EACH STATEMENT EXECUTE FUNCTION "rejectOrderSnapshotMutation"();
CREATE TRIGGER "order_no_delete" BEFORE DELETE ON "order"
FOR EACH ROW EXECUTE FUNCTION "rejectOrderSnapshotMutation"();
CREATE TRIGGER "order_no_truncate" BEFORE TRUNCATE ON "order"
FOR EACH STATEMENT EXECUTE FUNCTION "rejectOrderSnapshotMutation"();

CREATE FUNCTION "protectOrderSnapshot"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mutable_columns text[] := ARRAY['contactId', 'ownerId', 'carrier', 'trackingNumber', 'status', 'statusChangedAt', 'confirmedAt', 'shippedAt', 'deliveredAt', 'cancelledAt', 'updatedAt', 'version'];
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
  RETURN NEW;
END;
$$;

CREATE TRIGGER "order_snapshot_immutable" BEFORE UPDATE ON "order"
FOR EACH ROW EXECUTE FUNCTION "protectOrderSnapshot"();
COMMIT;
