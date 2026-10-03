import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	RETAIL_MIND_VOICE,
	readElevenV4TurboConfig,
} from "../agent/lib/retail-mind/config";
import {
	elevenV4TurboCloseFrame,
	elevenV4TurboFlushFrame,
	elevenV4TurboInputFrame,
	elevenV4TurboKeepAliveFrame,
	elevenV4TurboRegistrationFrame,
	elevenV4TurboUrl,
} from "../agent/lib/retail-mind/eleven-v4-turbo";

const KEYS = ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

describe("Eleven v4 Turbo configuration", () => {
	it("stays disabled until both settings exist", () => {
		expect(readElevenV4TurboConfig()).toBeNull();
		process.env.ELEVENLABS_API_KEY = "key";
		expect(readElevenV4TurboConfig()).toBeNull();
		process.env.ELEVENLABS_VOICE_ID = "voice";
		expect(readElevenV4TurboConfig()).toEqual({
			apiKey: "key",
			voiceId: "voice",
		});
	});

	it("uses the v4 Turbo Text-to-Dialogue WebSocket", () => {
		const url = new URL(elevenV4TurboUrl({ syncAlignment: true }));
		expect(url.protocol).toBe("wss:");
		expect(url.pathname).toBe("/v1/text-to-dialogue/stream-input");
		expect(url.searchParams.get("model_id")).toBe(
			RETAIL_MIND_VOICE.elevenLabs.modelId,
		);
		expect(url.searchParams.get("output_format")).toBe(
			RETAIL_MIND_VOICE.elevenLabs.outputFormat,
		);
		expect(url.searchParams.get("sync_alignment")).toBe("true");
	});
});

describe("Eleven v4 Turbo frames", () => {
	it("registers exactly one voice", () => {
		expect(elevenV4TurboRegistrationFrame("secret", "voice-1")).toEqual({
			voices: ["voice-1"],
			xi_api_key: "secret",
		});
	});

	it("sends text to the registered voice", () => {
		expect(elevenV4TurboInputFrame("voice-1", "عسلامة", true)).toEqual({
			inputs: [
				{
					text: "عسلامة",
					voice_id: "voice-1",
					new_turn: true,
				},
			],
		});
	});

	it("builds the control frames", () => {
		expect(elevenV4TurboFlushFrame()).toEqual({ flush: true });
		expect(elevenV4TurboKeepAliveFrame()).toEqual({ keep_alive: true });
		expect(elevenV4TurboCloseFrame()).toEqual({ close_socket: true });
	});

	it("rejects blank text and blank identifiers", () => {
		expect(() => elevenV4TurboInputFrame("voice-1", "   ")).toThrow();
		expect(() => elevenV4TurboRegistrationFrame("secret", "   ")).toThrow();
	});
});
