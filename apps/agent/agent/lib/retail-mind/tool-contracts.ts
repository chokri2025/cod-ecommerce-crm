import { z } from "zod";

const identifier = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(500);
const expectedVersion = z.number().int().nonnegative().max(2_147_483_646);

const orderReference = {
	orderId: identifier,
	requestId: identifier,
};

export const getOrderInput = z.strictObject(orderReference);

export const confirmOrderInput = z.strictObject({
	...orderReference,
	expectedVersion,
});

export const cancelOrderInput = z.strictObject({
	...orderReference,
	expectedVersion,
	reason: text,
});

export const updateAddressInput = z.strictObject({
	...orderReference,
	expectedVersion,
	address: text,
	city: text,
	region: text.nullable().optional(),
});

export const getDeliveryStatusInput = z.strictObject(orderReference);

export const requestHumanInput = z.strictObject({
	conversationId: identifier,
	requestId: identifier,
	reason: text,
});

export const retailMindToolCall = z.discriminatedUnion("name", [
	z.strictObject({ name: z.literal("get_order"), input: getOrderInput }),
	z.strictObject({ name: z.literal("confirm_order"), input: confirmOrderInput }),
	z.strictObject({ name: z.literal("cancel_order"), input: cancelOrderInput }),
	z.strictObject({ name: z.literal("update_address"), input: updateAddressInput }),
	z.strictObject({
		name: z.literal("get_delivery_status"),
		input: getDeliveryStatusInput,
	}),
	z.strictObject({ name: z.literal("request_human"), input: requestHumanInput }),
]);

export type RetailMindToolCall = z.infer<typeof retailMindToolCall>;
export type RetailMindToolName = RetailMindToolCall["name"];

export function parseRetailMindToolCall(value: unknown): RetailMindToolCall {
	return retailMindToolCall.parse(value);
}
