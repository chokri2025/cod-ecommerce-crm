import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rejects } from "node:assert/strict";
import { db } from "@crm/db";
import { OrdersService } from "../src/orders/orders.service";

const service = new OrdersService(db);
const suffix = crypto.randomUUID();
let contactId: string;

function input() {
	return {
		orderNumber: crypto.randomUUID(),
		contactId,
		currency: "USD",
		recipientName: "COD Customer",
		normalizedPhone: "+212612345678",
		address: "12 Test Street",
		city: "Casablanca",
		country: "MA",
		discount: "2.00",
		shippingCharge: "5.00",
		items: [
			{
				sku: "SKU-1",
				productName: "Product",
				variant: "Blue",
				quantity: 2,
				unitPrice: "10.00",
				discount: "1.00",
			},
		],
		utmSource: "facebook",
		fbclid: "click-1",
	};
}

async function create() {
	return service.create(input());
}

async function deliver() {
	let order = await create();
	for (const newStatus of [
		"CONFIRMED",
		"SHIPPED",
		"IN_DELIVERY",
		"DELIVERED",
	] as const) {
		order = (
			await service.transition({
				orderId: order.id,
				expectedVersion: order.version,
				newStatus,
				sourceSystem: "manual",
			})
		).order;
	}
	return order;
}

beforeAll(async () => {
	const contact = await db.contact.create({
		data: { firstName: `Order ${suffix}` },
	});
	contactId = contact.id;
});

afterAll(async () => {
	await db.$disconnect();
});

describe("COD orders", () => {
	it("creates NEW orders with exact commercial snapshots and initial history", async () => {
		const order = await create();
		expect(order.status).toBe("NEW");
		expect(order.version).toBe(0);
		expect(order.subtotal.toFixed(2)).toBe("19.00");
		expect(order.total.toFixed(2)).toBe("22.00");
		expect(order.deliveredAt).toBeNull();
		expect(order.utmSource).toBe("facebook");
		const item = await db.orderItem.findFirstOrThrow({
			where: { orderId: order.id },
		});
		expect(item.lineTotal.toFixed(2)).toBe("19.00");
		const events = await db.orderStatusEvent.findMany({
			where: { orderId: order.id },
		});
		expect(events).toHaveLength(1);
		expect(events[0]?.previousStatus).toBeNull();
		expect(events[0]?.newStatus).toBe("NEW");
	});

	it("rejects invalid amounts, currencies and phone numbers", async () => {
		for (const changes of [
			{ discount: "99.00" },
			{ currency: "ZZZ" },
			{ normalizedPhone: "0612" },
			{ items: [] },
		]) {
			await rejects(async () => service.create({ ...input(), ...changes }));
		}
	});

	it("protects external order identity within its source account", async () => {
		const data = {
			...input(),
			sourceSystem: "store",
			sourceAccount: suffix,
			externalOrderId: "one",
		};
		await service.create(data);
		await rejects(async () =>
			service.create({ ...data, orderNumber: crypto.randomUUID() }),
		);
		expect(
			await service.create({
				...data,
				orderNumber: crypto.randomUUID(),
				sourceAccount: `${suffix}-other`,
			}),
		).toBeDefined();
	});

	it("rejects invalid transitions without changing state or history", async () => {
		const order = await create();
		await rejects(async () =>
			service.transition({
				orderId: order.id,
				expectedVersion: 0,
				newStatus: "DELIVERED",
				sourceSystem: "manual",
			}),
		);
		expect(
			await db.orderStatusEvent.count({ where: { orderId: order.id } }),
		).toBe(1);
		expect(
			(await db.order.findUniqueOrThrow({ where: { id: order.id } })).version,
		).toBe(0);
	});

	it("preserves delivery evidence after a return", async () => {
		const order = await deliver();
		expect(order.confirmedAt).not.toBeNull();
		expect(order.shippedAt).not.toBeNull();
		expect(order.deliveredAt).not.toBeNull();
		const returned = await service.transition({
			orderId: order.id,
			expectedVersion: order.version,
			newStatus: "RETURNED",
			sourceSystem: "manual",
			reason: "Customer return",
		});
		expect(returned.order.status).toBe("RETURNED");
		expect(returned.order.deliveredAt).toEqual(order.deliveredAt);
		expect(
			await db.orderStatusEvent.count({
				where: { orderId: order.id, newStatus: "DELIVERED" },
			}),
		).toBe(1);
		await rejects(async () =>
			service.transition({
				orderId: order.id,
				expectedVersion: returned.order.version,
				newStatus: "NEW",
				sourceSystem: "manual",
			}),
		);
	});

	it("deduplicates simultaneous retries before checking their stale version", async () => {
		const order = await create();
		const event = {
			orderId: order.id,
			expectedVersion: 0,
			newStatus: "CONFIRMED" as const,
			sourceSystem: "carrier",
			sourceAccount: suffix,
			externalEventId: crypto.randomUUID(),
			occurredAt: new Date(),
		};
		const results = await Promise.all([
			service.transition(event),
			service.transition(event),
		]);
		expect(results.filter((r) => r.duplicate)).toHaveLength(1);
		expect(
			await db.orderStatusEvent.count({ where: { orderId: order.id } }),
		).toBe(2);
		await rejects(async () =>
			service.transition({ ...event, newStatus: "SHIPPED" }),
		);
		const other = await create();
		await rejects(async () =>
			service.transition({ ...event, orderId: other.id }),
		);
	});

	it("allows only one concurrent transition at the same version", async () => {
		const order = await create();
		const results = await Promise.allSettled([
			service.transition({
				orderId: order.id,
				expectedVersion: 0,
				newStatus: "CONFIRMED",
				sourceSystem: "manual",
			}),
			service.transition({
				orderId: order.id,
				expectedVersion: 0,
				newStatus: "CANCELLED",
				sourceSystem: "manual",
				reason: "Cancelled",
			}),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
	});

	it("rejects backdated transitions and records occurrence separately from receipt", async () => {
		const order = await create();
		await rejects(async () =>
			service.transition({
				orderId: order.id,
				expectedVersion: 0,
				newStatus: "CONFIRMED",
				sourceSystem: "manual",
				occurredAt: new Date(0),
			}),
		);
		const result = await service.transition({
			orderId: order.id,
			expectedVersion: 0,
			newStatus: "CANCELLED",
			sourceSystem: "manual",
			reason: "Customer cancelled",
		});
		expect(result.order.cancelledAt).not.toBeNull();
		expect(result.event.receivedAt.getTime()).toBeGreaterThanOrEqual(
			result.event.occurredAt.getTime(),
		);
	});

	it("retains orders and snapshots through contact archival and deletion", async () => {
		const contact = await db.contact.create({
			data: { firstName: "Temporary customer" },
		});
		const order = await service.create({ ...input(), contactId: contact.id });
		await db.contact.update({
			where: { id: contact.id },
			data: { archivedAt: new Date() },
		});
		expect(await db.order.count({ where: { id: order.id } })).toBe(1);
		await db.contact.delete({ where: { id: contact.id } });
		const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } });
		expect(saved.contactId).toBeNull();
		expect(saved.normalizedPhone).toBe(order.normalizedPhone);
		expect(
			await db.orderStatusEvent.count({ where: { orderId: order.id } }),
		).toBe(1);
	});

	it("blocks history and item rewrites, deletes, and order deletion in PostgreSQL", async () => {
		const order = await create();
		await rejects(async () =>
			Promise.resolve(
				db.orderStatusEvent.updateMany({
					where: { orderId: order.id },
					data: { reason: "Rewrite" },
				}),
			),
		);
		await rejects(async () =>
			Promise.resolve(
				db.orderStatusEvent.deleteMany({ where: { orderId: order.id } }),
			),
		);
		await rejects(async () =>
			Promise.resolve(
				db.orderItem.updateMany({
					where: { orderId: order.id },
					data: { productName: "Rewrite" },
				}),
			),
		);
		await rejects(async () =>
			Promise.resolve(
				db.orderItem.deleteMany({ where: { orderId: order.id } }),
			),
		);
		await rejects(async () =>
			Promise.resolve(db.order.delete({ where: { id: order.id } })),
		);
	});

	it("protects commercial snapshots and delivery timestamps in PostgreSQL", async () => {
		const order = await deliver();
		await rejects(async () =>
			db.order.update({
				where: { id: order.id },
				data: { recipientName: "Rewritten" },
			}),
		);
		await rejects(async () =>
			db.order.update({ where: { id: order.id }, data: { total: "0" } }),
		);
		await rejects(async () =>
			db.order.update({ where: { id: order.id }, data: { deliveredAt: null } }),
		);
		const saved = await db.order.findUniqueOrThrow({ where: { id: order.id } });
		expect(saved.deliveredAt).toEqual(order.deliveredAt);
		expect(saved.total.toString()).toBe(order.total.toString());
	});

	it("isolates event keys by source account", async () => {
		const first = await create();
		const second = await create();
		const externalEventId = crypto.randomUUID();
		for (const [order, sourceAccount] of [
			[first, "account-a"],
			[second, "account-b"],
		] as const) {
			const result = await service.transition({
				orderId: order.id,
				expectedVersion: 0,
				newStatus: "CONFIRMED",
				sourceSystem: "carrier",
				sourceAccount,
				externalEventId,
			});
			expect(result.duplicate).toBe(false);
		}
		expect(
			await db.orderStatusEvent.count({ where: { externalEventId } }),
		).toBe(2);
	});

	it("rolls back failed creation without leaving partial records", async () => {
		const data = { ...input(), ownerId: `missing-${suffix}` };
		await rejects(async () => service.create(data));
		expect(
			await db.order.count({ where: { orderNumber: data.orderNumber } }),
		).toBe(0);
	});
});
