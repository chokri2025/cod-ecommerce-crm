import { describe, expect, it } from "bun:test";
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
		for (const from of Object.keys(
			ORDER_TRANSITIONS,
		) as (keyof typeof ORDER_TRANSITIONS)[]) {
			for (const to of Object.keys(
				ORDER_TRANSITIONS,
			) as (keyof typeof ORDER_TRANSITIONS)[]) {
				const allowed: readonly string[] = expected[from];
				expect(canTransitionOrder(from, to)).toBe(allowed.includes(to));
			}
		}
	});
	it("qualifies only currently delivered orders as delivered sales", () => {
		for (const status of Object.keys(
			ORDER_TRANSITIONS,
		) as (keyof typeof ORDER_TRANSITIONS)[]) {
			expect(isDeliveredSale(status)).toBe(status === "DELIVERED");
		}
	});
});
