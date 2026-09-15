import { type Db, Prisma } from "@crm/db";
import { minorUnitsOf } from "@crm/db/currency";
import { convertToBase } from "@crm/db/fx";
import { lockIdempotencyKey } from "@crm/db/idempotency";
import { canTransitionOrder } from "@crm/db/order-status";
import { readReportingCurrency } from "@crm/db/settings";
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
} from "@nestjs/common";
import { InjectDatabase } from "../database/database.constants";
import {
	type CreateOrderInput,
	createOrderInput,
	type TransitionOrderInput,
	transitionOrderInput,
} from "./orders.contracts";

@Injectable()
export class OrdersService {
	constructor(@InjectDatabase() private readonly db: Db) {}

	async create(input: CreateOrderInput, actorId: string | null = null) {
		const { items: requestedItems, ...data } = createOrderInput.parse(input);
		const places = minorUnitsOf(data.currency);
		const amount = (value: string) => {
			const decimal = new Prisma.Decimal(value);
			if (decimal.decimalPlaces() > places)
				throw new BadRequestException("Amount exceeds currency precision");
			return decimal;
		};
		const items = requestedItems.map((item) => {
			const unitPrice = amount(item.unitPrice);
			const discount = amount(item.discount);
			const lineTotal = unitPrice.times(item.quantity).minus(discount);
			this.checkAmount(lineTotal);
			return { ...item, unitPrice, discount, lineTotal };
		});
		const subtotal = items.reduce(
			(sum, item) => sum.plus(item.lineTotal),
			new Prisma.Decimal(0),
		);
		const discount = amount(data.discount);
		const shippingCharge = amount(data.shippingCharge);
		if (discount.greaterThan(subtotal))
			throw new BadRequestException("Discount exceeds subtotal");
		const total = subtotal.minus(discount).plus(shippingCharge);
		this.checkAmount(subtotal);
		this.checkAmount(total);
		const reportingCurrency = await readReportingCurrency(this.db);
		const conversion = await convertToBase(
			this.db,
			total,
			data.currency,
			reportingCurrency,
		);
		const now = new Date();
		return this.db.$transaction(async (tx) => {
			const contact = await tx.contact.findFirst({
				where: { id: data.contactId, archivedAt: null },
				select: { id: true },
			});
			if (!contact) throw new NotFoundException("Active contact not found");
			return tx.order.create({
				data: {
					...data,
					subtotal,
					discount,
					shippingCharge,
					total,
					reportingCurrency,
					reportingAmount: conversion?.baseAmount ?? null,
					fxRate: conversion?.fxRate ?? null,
					fxRateAt: conversion?.fxRateAt ?? null,
					fxRateSource: conversion?.origin ?? null,
					createdAt: now,
					statusChangedAt: now,
					items: { create: items },
					statusEvents: {
						create: {
							newStatus: "NEW",
							version: 0,
							occurredAt: now,
							receivedAt: now,
							actorId,
							sourceSystem: data.sourceSystem,
							sourceAccount: data.sourceAccount,
						},
					},
				},
			});
		});
	}

	async transition(input: TransitionOrderInput, actorId: string | null = null) {
		const data = transitionOrderInput.parse(input);
		return this.db.$transaction(async (tx) => {
			if (data.externalEventId) {
				await lockIdempotencyKey(
					tx,
					JSON.stringify([
						"order-event",
						data.sourceSystem,
						data.sourceAccount,
						data.externalEventId,
					]),
				);
				const event = await tx.orderStatusEvent.findUnique({
					where: {
						sourceSystem_sourceAccount_externalEventId: {
							sourceSystem: data.sourceSystem,
							sourceAccount: data.sourceAccount,
							externalEventId: data.externalEventId,
						},
					},
				});
				if (event) {
					if (
						event.orderId !== data.orderId ||
						event.newStatus !== data.newStatus ||
						event.actorId !== actorId ||
						event.reason !== (data.reason ?? null) ||
						(data.occurredAt &&
							event.occurredAt.getTime() !== data.occurredAt.getTime())
					) {
						throw new ConflictException(
							"External event key already contains different data",
						);
					}
					const order = await tx.order.findUniqueOrThrow({
						where: { id: data.orderId },
					});
					return { order, event, duplicate: true };
				}
			}
			await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${data.orderId} FOR UPDATE`;
			const current = await tx.order.findUnique({
				where: { id: data.orderId },
			});
			if (!current) throw new NotFoundException("Order not found");
			if (current.version !== data.expectedVersion)
				throw new ConflictException("Order version changed");
			if (!canTransitionOrder(current.status, data.newStatus))
				throw new BadRequestException("Invalid order status transition");
			if (
				["REFUSED", "RETURNED", "CANCELLED"].includes(data.newStatus) &&
				!data.reason
			)
				throw new BadRequestException("Exception status requires a reason");
			const receivedAt = new Date();
			const occurredAt = data.occurredAt ?? receivedAt;
			if (occurredAt < current.statusChangedAt || occurredAt > receivedAt)
				throw new BadRequestException(
					"Event time is outside the current lifecycle window",
				);
			const order = await tx.order.update({
				where: { id: current.id, version: data.expectedVersion },
				data: {
					status: data.newStatus,
					statusChangedAt: occurredAt,
					version: { increment: 1 },
					confirmedAt:
						data.newStatus === "CONFIRMED" ? occurredAt : current.confirmedAt,
					shippedAt:
						data.newStatus === "SHIPPED" ? occurredAt : current.shippedAt,
					deliveredAt:
						data.newStatus === "DELIVERED" ? occurredAt : current.deliveredAt,
					cancelledAt:
						data.newStatus === "CANCELLED" ? occurredAt : current.cancelledAt,
				},
			});
			const event = await tx.orderStatusEvent.create({
				data: {
					orderId: order.id,
					previousStatus: current.status,
					newStatus: order.status,
					version: order.version,
					occurredAt,
					receivedAt,
					actorId,
					sourceSystem: data.sourceSystem,
					sourceAccount: data.sourceAccount,
					reason: data.reason,
					externalEventId: data.externalEventId,
				},
			});
			return { order, event, duplicate: false };
		});
	}

	private checkAmount(amount: Prisma.Decimal): void {
		if (amount.isNegative() || amount.greaterThan("999999999999.99"))
			throw new BadRequestException(
				"Order amount is outside the supported range",
			);
	}
}
