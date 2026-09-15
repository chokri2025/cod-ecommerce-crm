export const ORDER_TRANSITIONS = {
	NEW: ["CONFIRMED", "CANCELLED"],
	CONFIRMED: ["SHIPPED", "CANCELLED"],
	SHIPPED: ["IN_DELIVERY", "RETURNED"],
	IN_DELIVERY: ["DELIVERED", "REFUSED", "RETURNED"],
	DELIVERED: ["RETURNED"],
	REFUSED: ["RETURNED"],
	RETURNED: [],
	CANCELLED: [],
} as const;

export type OrderStatus = keyof typeof ORDER_TRANSITIONS;

export function canTransitionOrder(
	from: OrderStatus,
	to: OrderStatus,
): boolean {
	const allowed: readonly OrderStatus[] = ORDER_TRANSITIONS[from];
	return allowed.includes(to);
}

export function isDeliveredSale(status: OrderStatus): boolean {
	return status === "DELIVERED";
}
