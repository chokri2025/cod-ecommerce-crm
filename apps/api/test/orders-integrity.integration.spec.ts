import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rejects } from "node:assert/strict";
import { db, OrderStatus, type Prisma } from "@crm/db";
import { canTransitionOrder } from "@crm/db/order-status";
import { OrdersService } from "../src/orders/orders.service";

const service = new OrdersService(db);
let contactId: string;
const item = { productName: "Snapshot", quantity: 1, unitPrice: "19.00" };
function input() {
	return {
		orderNumber: crypto.randomUUID(),
		contactId,
		currency: "USD",
		recipientName: "Integrity test",
		normalizedPhone: "+212612345678",
		address: "12 Test Street",
		city: "Casablanca",
		country: "MA",
		items: [item],
	};
}
async function rawCreate(
	tx: Prisma.TransactionClient,
	subtotal = "19.00",
	seal = true,
	currency = "USD",
) {
	const now = new Date();
	const { items, ...data } = input();
	const order = await tx.order.create({
		data: {
			...data,
			currency,
			subtotal,
			total: subtotal,
			reportingCurrency: "USD",
			createdAt: now,
			statusChangedAt: now,
			items: {
				create: items.map((value) => ({ ...value, lineTotal: "19.00" })),
			},
			statusEvents: {
				create: {
					newStatus: "NEW",
					version: 0,
					occurredAt: now,
					receivedAt: now,
					sourceSystem: "test",
				},
			},
		},
	});
	if (seal)
		return tx.order.update({
			where: { id: order.id },
			data: { itemsSealedAt: now },
		});
	return order;
}

async function missingFx() {
	return db.$transaction((tx) => rawCreate(tx));
}
beforeAll(async () => {
	contactId = (
		await db.contact.create({ data: { firstName: "Integrity test" } })
	).id;
});
afterAll(async () => {
	await db.$disconnect();
});

describe("order database integrity", () => {
	it("matches all 64 database transition decisions to the independent enum matrix", async () => {
		for (const previous of Object.values(OrderStatus)) {
			for (const next of Object.values(OrderStatus)) {
				const [row] = await db.$queryRaw<
					{ allowed: boolean }[]
				>`SELECT "orderTransitionAllowed"(${previous}::"OrderStatus", ${next}::"OrderStatus") AS allowed`;
				expect(row?.allowed).toBe(canTransitionOrder(previous, next));
			}
		}
	});
	it("rejects a status-only SQL mutation at commit and preserves the order", async () => {
		const order = await service.create(input());
		await rejects(
			async () =>
				db.$transaction(async (tx) => {
					await tx.$executeRaw`UPDATE "order" SET status = 'DELIVERED' WHERE id = ${order.id}`;
				}),
			/match latest status event/,
		);
		const persisted = await db.order.findUniqueOrThrow({
			where: { id: order.id },
		});
		expect(persisted.status).toBe("NEW");
		expect(persisted.version).toBe(0);
		expect(persisted.deliveredAt).toBeNull();
	});
	it("rejects later item insertion even when its line total is zero", async () => {
		const order = await service.create(input());
		await rejects(async () =>
			db.orderItem.create({
				data: {
					orderId: order.id,
					productName: "Late item",
					quantity: 1,
					unitPrice: "0",
					lineTotal: "0",
				},
			}),
		);
		expect(await db.orderItem.count({ where: { orderId: order.id } })).toBe(1);
	});
	it("seals atomic creation and rejects missing seals, empty items and inconsistent subtotal", async () => {
		const order = await service.create(input());
		expect(order.itemsSealedAt).not.toBeNull();
		expect(
			(
				await db.orderItem.aggregate({
					where: { orderId: order.id },
					_sum: { lineTotal: true },
				})
			)._sum.lineTotal?.equals(order.subtotal),
		).toBe(true);
		await rejects(
			async () => db.$transaction((tx) => rawCreate(tx, "20.00")),
			/match subtotal/,
		);
		await rejects(
			async () => db.$transaction((tx) => rawCreate(tx, "19.00", false)),
			/sealed/,
		);
		await rejects(
			async () =>
				db.$transaction(async (tx) => {
					const { items: _items, ...data } = input();
					const now = new Date();
					await tx.order.create({
						data: {
							...data,
							subtotal: "0",
							total: "0",
							reportingCurrency: "USD",
							createdAt: now,
							statusChangedAt: now,
							itemsSealedAt: now,
							statusEvents: {
								create: {
									newStatus: "NEW",
									version: 0,
									occurredAt: now,
									receivedAt: now,
									sourceSystem: "test",
								},
							},
						},
					});
				}),
			/match subtotal/,
		);
		await rejects(
			async () =>
				db.order.update({
					where: { id: order.id },
					data: { itemsSealedAt: null },
				}),
			/unsealed/,
		);
	});
	for (const failure of [
		"predecessor",
		"transition",
		"version",
		"timestamp",
		"chronology",
		"missing event",
		"missing state",
	] as const) {
		it(`rejects an inconsistent ${failure} and rolls the transaction back`, async () => {
			const order = await service.create(input());
			await rejects(
				async () =>
					db.$transaction(async (tx) => {
						const occurredAt =
							failure === "chronology"
								? new Date(order.createdAt.getTime() - 1)
								: new Date();
						const newStatus =
							failure === "transition" ? "DELIVERED" : "CONFIRMED";
						const version = failure === "version" ? 2 : 1;
						if (failure !== "missing state")
							await tx.order.update({
								where: { id: order.id },
								data: {
									status: newStatus,
									version,
									statusChangedAt: occurredAt,
									confirmedAt:
										newStatus === "CONFIRMED" && failure !== "timestamp"
											? occurredAt
											: null,
									deliveredAt: newStatus === "DELIVERED" ? occurredAt : null,
								},
							});
						if (failure !== "missing event")
							await tx.orderStatusEvent.create({
								data: {
									orderId: order.id,
									previousStatus: failure === "predecessor" ? "SHIPPED" : "NEW",
									newStatus,
									version,
									occurredAt,
									receivedAt: new Date(),
									sourceSystem: "test",
								},
							});
					}),
				/Order (state|status event chain|lifecycle timestamps)/,
			);
			const persisted = await db.order.findUniqueOrThrow({
				where: { id: order.id },
				include: { statusEvents: true },
			});
			expect(persisted.status).toBe("NEW");
			expect(persisted.version).toBe(0);
			expect(persisted.confirmedAt).toBeNull();
			expect(persisted.statusEvents).toHaveLength(1);
		});
	}
	it("allows event-first writes when state and history agree at commit", async () => {
		const order = await service.create(input());
		const now = new Date();
		await db.$transaction(async (tx) => {
			await tx.orderStatusEvent.create({
				data: {
					orderId: order.id,
					previousStatus: "NEW",
					newStatus: "CONFIRMED",
					version: 1,
					occurredAt: now,
					receivedAt: now,
					sourceSystem: "test",
				},
			});
			await tx.order.update({
				where: { id: order.id },
				data: {
					status: "CONFIRMED",
					version: 1,
					statusChangedAt: now,
					confirmedAt: now,
				},
			});
		});
		expect(
			(await db.order.findUniqueOrThrow({ where: { id: order.id } })).version,
		).toBe(1);
	});
	it("rolls state back when event insertion fails", async () => {
		const order = await service.create(input());
		await rejects(
			async () =>
				db.$transaction(async (tx) => {
					const now = new Date();
					await tx.order.update({
						where: { id: order.id },
						data: {
							status: "CONFIRMED",
							version: 1,
							confirmedAt: now,
							statusChangedAt: now,
						},
					});
					await tx.orderStatusEvent.create({
						data: {
							orderId: order.id,
							newStatus: "NEW",
							version: 0,
							occurredAt: order.createdAt,
							receivedAt: now,
							sourceSystem: "test",
						},
					});
				}),
			/Unique constraint/,
		);
		expect(
			(await db.order.findUniqueOrThrow({ where: { id: order.id } })).status,
		).toBe("NEW");
		expect(
			await db.orderStatusEvent.count({ where: { orderId: order.id } }),
		).toBe(1);
	});
	it("supports refusal then return without inventing delivery evidence", async () => {
		let order = await service.create(input());
		for (const newStatus of [
			"CONFIRMED",
			"SHIPPED",
			"IN_DELIVERY",
			"REFUSED",
			"RETURNED",
		] as const) {
			order = (
				await service.transition({
					orderId: order.id,
					expectedVersion: order.version,
					newStatus,
					reason: "Customer refused",
				})
			).order;
		}
		expect(order.deliveredAt).toBeNull();
		expect(order.status).toBe("RETURNED");
		expect(
			await db.orderStatusEvent.count({ where: { orderId: order.id } }),
		).toBe(6);
	});
});

describe("missing order FX recovery", () => {
	it("fills missing FX once with an immutable actor audit and preserves status", async () => {
		const order = await missingFx();
		expect(order.fxRate).toBeNull();
		const recovered = await service.recoverMissingFx(
			order.id,
			"finance-operator",
		);
		expect(recovered.reportingAmount?.toFixed(2)).toBe("19.00");
		expect(recovered.fxRate?.toString()).toBe("1");
		expect(recovered.fxRateSource).toBe("IDENTITY");
		expect(recovered.fxRateAt).not.toBeNull();
		expect(recovered.version).toBe(0);
		const audit = await db.orderFxRecovery.findUniqueOrThrow({
			where: { orderId: order.id },
		});
		expect(audit.actorId).toBe("finance-operator");
		expect(audit.recordedAt.getTime()).toBeGreaterThanOrEqual(
			order.createdAt.getTime(),
		);
		await rejects(
			() => service.recoverMissingFx(order.id, "other"),
			/already established/,
		);
		await rejects(
			async () =>
				db.order.update({
					where: { id: order.id },
					data: { reportingAmount: "38", fxRate: "2" },
				}),
			/FX recovery/,
		);
		await rejects(
			async () =>
				db.orderFxRecovery.update({
					where: { orderId: order.id },
					data: { actorId: "other" },
				}),
			/immutable/,
		);
		await rejects(
			async () => db.orderFxRecovery.delete({ where: { orderId: order.id } }),
			/immutable/,
		);
		await rejects(
			async () =>
				db.order.update({
					where: { id: order.id },
					data: {
						reportingAmount: null,
						fxRate: null,
						fxRateAt: null,
						fxRateSource: null,
					},
				}),
			/FX recovery/,
		);
	});
	it("rejects unaudited, partial and arithmetically inconsistent recovery atomically", async () => {
		const order = await missingFx();
		await rejects(
			async () =>
				db.order.update({
					where: { id: order.id },
					data: {
						reportingAmount: "19",
						fxRate: "1",
						fxRateAt: new Date(),
						fxRateSource: "IDENTITY",
					},
				}),
			/audit record/,
		);
		await rejects(
			async () =>
				db.orderFxRecovery.create({
					data: { orderId: order.id, actorId: "operator" },
				}),
			/complete snapshot/,
		);
		for (const reportingAmount of [null, "18"]) {
			await rejects(
				async () =>
					db.$transaction(async (tx) => {
						await tx.orderFxRecovery.create({
							data: { orderId: order.id, actorId: "operator" },
						});
						await tx.order.update({
							where: { id: order.id },
							data: {
								reportingAmount,
								fxRate: "1",
								fxRateAt: new Date(),
								fxRateSource: "IDENTITY",
							},
						});
					}),
				/FX recovery/,
			);
		}
		expect(
			(await db.order.findUniqueOrThrow({ where: { id: order.id } })).fxRate,
		).toBeNull();
		expect(
			await db.orderFxRecovery.count({ where: { orderId: order.id } }),
		).toBe(0);
		await rejects(() => service.recoverMissingFx(order.id, " "), /actor/);
	});
	it("serializes concurrent recovery so exactly one snapshot and audit commit", async () => {
		const order = await missingFx();
		const results = await Promise.allSettled([
			service.recoverMissingFx(order.id, "operator-1"),
			service.recoverMissingFx(order.id, "operator-2"),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(
			await db.orderFxRecovery.count({ where: { orderId: order.id } }),
		).toBe(1);
	});
	it("requires a real cross-currency rate and freezes the recovered decimal snapshot", async () => {
		const order = await service.create({ ...input(), currency: "CHF" });
		expect(order.fxRate).toBeNull();
		expect(
			await db.exchangeRate.count({
				where: { baseCurrency: "USD", quoteCurrency: "CHF" },
			}),
		).toBe(0);
		await rejects(
			() => service.recoverMissingFx(order.id, "operator"),
			/No exchange rate/,
		);
		expect(
			await db.orderFxRecovery.count({ where: { orderId: order.id } }),
		).toBe(0);
		const rate = await db.exchangeRate.create({
			data: {
				baseCurrency: "USD",
				quoteCurrency: "CHF",
				rate: "1.2345678901",
				asOf: new Date(),
				source: "MANUAL",
			},
		});
		try {
			const recovered = await service.recoverMissingFx(order.id, "operator");
			expect(recovered.fxRate?.toString()).toBe("1.2345678901");
			expect(recovered.reportingAmount?.toFixed(2)).toBe("23.46");
			expect(recovered.fxRateSource).toBe("MANUAL");
			await db.exchangeRate.update({
				where: { id: rate.id },
				data: { rate: "2" },
			});
			expect(
				(
					await db.order.findUniqueOrThrow({ where: { id: order.id } })
				).fxRate?.toString(),
			).toBe("1.2345678901");
		} finally {
			await db.exchangeRate.delete({ where: { id: rate.id } });
		}
	});
	it("rolls back both a valid snapshot and its audit on a later transaction failure", async () => {
		const order = await missingFx();
		await rejects(
			async () =>
				db.$transaction(async (tx) => {
					await tx.orderFxRecovery.create({
						data: { orderId: order.id, actorId: "operator" },
					});
					await tx.order.update({
						where: { id: order.id },
						data: {
							reportingAmount: "19",
							fxRate: "1",
							fxRateAt: new Date(),
							fxRateSource: "IDENTITY",
						},
					});
					throw new Error("Later transaction failure");
				}),
			/Later transaction failure/,
		);
		expect(
			(await db.order.findUniqueOrThrow({ where: { id: order.id } })).fxRate,
		).toBeNull();
		expect(
			await db.orderFxRecovery.count({ where: { orderId: order.id } }),
		).toBe(0);
	});
	it("cannot recover or audit an FX snapshot already established at creation", async () => {
		const order = await service.create(input());
		await rejects(
			() => service.recoverMissingFx(order.id, "operator"),
			/already established/,
		);
		await rejects(
			async () =>
				db.orderFxRecovery.create({
					data: { orderId: order.id, actorId: "operator" },
				}),
			/already established/,
		);
		await rejects(
			async () =>
				db.order.update({
					where: { id: order.id },
					data: { fxRate: "2", reportingAmount: "38" },
				}),
			/FX recovery/,
		);
	});
});
