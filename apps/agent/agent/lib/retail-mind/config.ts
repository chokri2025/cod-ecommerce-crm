import "@crm/env/load";

import { z } from "zod";

export const RETAIL_MIND_VOICE = {
	elevenLabs: {
		modelId: "eleven_v4_turbo",
		websocketUrl: "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input",
		outputFormat: "mp3_44100_128",
	},
} as const;

const elevenV4TurboEnvironment = z.object({
	ELEVENLABS_API_KEY: z.string().trim().min(1),
	ELEVENLABS_VOICE_ID: z.string().trim().min(1),
});

export type ElevenV4TurboConfig = {
	apiKey: string;
	voiceId: string;
};

export function readElevenV4TurboConfig(
	env: Record<string, string | undefined> = process.env,
): ElevenV4TurboConfig | null {
	const parsed = elevenV4TurboEnvironment.safeParse(env);
	if (!parsed.success) return null;

	return {
		apiKey: parsed.data.ELEVENLABS_API_KEY,
		voiceId: parsed.data.ELEVENLABS_VOICE_ID,
	};
}
