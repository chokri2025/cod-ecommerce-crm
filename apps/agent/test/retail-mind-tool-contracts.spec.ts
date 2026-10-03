import { describe, expect, it } from "bun:test";
import { parseRetailMindToolCall } from "../agent/lib/retail-mind/tool-contracts";

describe("Retail Mind tool contracts", () => {
	it("accepts a versioned order confirmation", () => {
		expect(
			parseRetailMindToolCall({
				name: "confirm_order",
				input: {
					orderId: "order-1",
					requestId: "request-1",
					expectedVersion: 3,
				},
			}),
		).toEqual({
			name: "confirm_order",
			input: {
				orderId: "order-1",
				requestId: "request-1",
				expectedVersion: 3,
			},
		});
	});

	it("requires a reason for cancellation", () => {
		expect(() =>
			parseRetailMindToolCall({
				name: "cancel_order",
				input: {
					orderId: "order-1",
					requestId: "request-1",
					expectedVersion: 3,
				},
			}),
		).toThrow();
	});

	it("parses an address update without adding fields", () => {
		expect(
			parseRetailMindToolCall({
				name: "update_address",
				input: {
					orderId: "order-1",
					requestId: "request-1",
					expectedVersion: 3,
					address: "10 Rue Exemple",
					city: "Tunis",
					region: "Tunis",
				},
			}),
		).toEqual({
			name: "update_address",
			input: {
				orderId: "order-1",
				requestId: "request-1",
				expectedVersion: 3,
				address: "10 Rue Exemple",
				city: "Tunis",
				region: "Tunis",
			},
		});
	});

	it("rejects unknown tools and unexpected fields", () => {
		expect(() =>
			parseRetailMindToolCall({
				name: "refund_order",
				input: {},
			}),
		).toThrow();
		expect(() =>
			parseRetailMindToolCall({
				name: "get_order",
				input: {
					orderId: "order-1",
					requestId: "request-1",
					unsafe: true,
				},
			}),
		).toThrow();
	});

	it("accepts a human escalation request", () => {
		expect(
			parseRetailMindToolCall({
				name: "request_human",
				input: {
					conversationId: "conversation-1",
					requestId: "request-1",
					reason: "Customer asked for a human agent",
				},
			}),
		).toEqual({
			name: "request_human",
			input: {
				conversationId: "conversation-1",
				requestId: "request-1",
				reason: "Customer asked for a human agent",
			},
		});
	});
});
