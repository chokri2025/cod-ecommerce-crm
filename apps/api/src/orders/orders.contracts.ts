import { isCurrencyCode, normalizeCurrency } from "@crm/db/currency";
import { OrderStatus } from "@crm/db/enums";
import { z } from "zod";

const text = z.string().trim().min(1).max(500);
const optionalText = text.nullable().optional();
const money = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/);
const source = {
	sourceSystem: z.string().trim().min(1).max(100).default("manual"),
	sourceAccount: z.string().trim().max(200).default(""),
};

export const createOrderInput = z
	.strictObject({
		orderNumber: text,
		contactId: text,
		ownerId: optionalText,
		currency: z
			.string()
			.transform(normalizeCurrency)
			.refine(isCurrencyCode, "Unsupported currency"),
		discount: money.default("0"),
		shippingCharge: money.default("0"),
		recipientName: text,
		normalizedPhone: z.string().regex(/^\+[1-9]\d{7,14}$/),
		address: text,
		city: text,
		region: optionalText,
		country: z.string().regex(/^[A-Z]{2}$/),
		carrier: optionalText,
		trackingNumber: optionalText,
		...source,
		externalOrderId: optionalText,
		utmSource: optionalText,
		utmMedium: optionalText,
		utmCampaign: optionalText,
		utmContent: optionalText,
		utmTerm: optionalText,
		fbclid: optionalText,
		fbp: optionalText,
		fbc: optionalText,
		campaignId: optionalText,
		adsetId: optionalText,
		adId: optionalText,
		landingPage: z.url().max(2048).nullable().optional(),
		items: z
			.array(
				z.strictObject({
					sku: optionalText,
					productName: text,
					variant: optionalText,
					quantity: z.number().int().positive().max(1_000_000),
					unitPrice: money,
					discount: money.default("0"),
				}),
			)
			.min(1)
			.max(500),
	})
	.refine(
		(input) => !input.externalOrderId || input.sourceAccount.length > 0,
		"External orders require a source account",
	);

export const transitionOrderInput = z
	.strictObject({
		orderId: text,
		expectedVersion: z.number().int().nonnegative().max(2_147_483_646),
		newStatus: z.enum(OrderStatus),
		occurredAt: z.date().optional(),
		...source,
		reason: optionalText,
		externalEventId: optionalText,
	})
	.refine(
		(input) => !input.externalEventId || input.sourceAccount.length > 0,
		"External events require a source account",
	);

export type CreateOrderInput = z.input<typeof createOrderInput>;
export type TransitionOrderInput = z.input<typeof transitionOrderInput>;
