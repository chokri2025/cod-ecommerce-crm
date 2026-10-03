import { z } from "zod";
import { RETAIL_MIND_VOICE } from "./config";

const identifier = z.string().trim().min(1).max(200);
const apiKey = z.string().trim().min(1).max(500);
const text = z.string().trim().min(1).max(10_000);
const outputFormat = z.string().trim().min(1).max(100);

export type ElevenV4TurboUrlOptions = {
	outputFormat?: string;
	syncAlignment?: boolean;
};

export function elevenV4TurboUrl(
	options: ElevenV4TurboUrlOptions = {},
): string {
	const url = new URL(RETAIL_MIND_VOICE.elevenLabs.websocketUrl);
	url.searchParams.set("model_id", RETAIL_MIND_VOICE.elevenLabs.modelId);
	url.searchParams.set(
		"output_format",
		outputFormat.parse(
			options.outputFormat ?? RETAIL_MIND_VOICE.elevenLabs.outputFormat,
		),
	);
	if (options.syncAlignment === true) {
		url.searchParams.set("sync_alignment", "true");
	}
	return url.toString();
}

export function elevenV4TurboRegistrationFrame(
	value: string,
	voiceId: string,
) {
	return {
		voices: [identifier.parse(voiceId)],
		xi_api_key: apiKey.parse(value),
	};
}

export function elevenV4TurboInputFrame(
	voiceId: string,
	value: string,
	newTurn = false,
) {
	return {
		inputs: [
			{
				text: text.parse(value),
				voice_id: identifier.parse(voiceId),
				new_turn: newTurn,
			},
		],
	};
}

export function elevenV4TurboFlushFrame() {
	return { flush: true } as const;
}

export function elevenV4TurboKeepAliveFrame() {
	return { keep_alive: true } as const;
}

export function elevenV4TurboCloseFrame() {
	return { close_socket: true } as const;
}
