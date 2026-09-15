import { describe, expect, it } from "bun:test";
import { OrderStatus } from "../src/generated/prisma/enums";
import {
	canTransitionOrder,
	isDeliveredSale,
	ORDER_TRANSITIONS,
} from "../src/order-status";

describe("order transitions", () => {
	const expected = {
		NEW: ["CONFIRMED", "CANCELLED"],
		CONFIRMED: ["SHIPPED", "CANCELLED"],
		SHIPPED: ["IN_DELIVERY", "RETURNED"],
		IN_DELIVERY: ["DELIVERED", "REFUSED", "RETURNED"],
		DELIVERED: ["RETURNED"],
		REFUSED: ["RETURNED"],
		RETURNED: [],
		CANCELLED: [],
	} as const;
	it("checks every status pair against the explicit lifecycle", () => {
		expect(Object.values(OrderStatus).sort()).toEqual(
			Object.keys(expected).sort(),
		);
		expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual(
			Object.keys(expected).sort(),
		);
		for (const from of Object.values(OrderStatus)) {
			for (const to of Object.values(OrderStatus)) {
				const allowed: readonly string[] = expected[from];
				expect(canTransitionOrder(from, to)).toBe(allowed.includes(to));
			}
		}
	});
	it("qualifies only currently delivered orders as delivered sales", () => {
		for (const status of Object.values(OrderStatus)) {
			expect(isDeliveredSale(status)).toBe(status === "DELIVERED");
		}
	});
});
