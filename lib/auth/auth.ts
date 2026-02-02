import { generatePKCE } from "@openauthjs/openauth/pkce";
import { randomBytes } from "node:crypto";
import { logWarn } from "../logger.js";
import type { PKCEPair, AuthorizationFlow, ParsedAuthInput, JWTPayload, TokenResult } from "../types.js";

// OAuth constants (from openai/codex)
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const SCOPE = "openid profile email offline_access";

/** Generate random state value for OAuth flow */
export function createState(): string {
	return randomBytes(16).toString("hex");
}

/** Parse authorization code/state from input */
export function parseAuthorizationInput(input: string): ParsedAuthInput {
	const value = (input || "").trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: value };
}

export type OAuthStateValidation = "match" | "missing" | "mismatch";

export function validateOAuthState(
	expectedState: string,
	receivedState?: string,
): OAuthStateValidation {
	const expected = (expectedState || "").trim();
	const received = (receivedState || "").trim();
	if (!expected) return "missing";
	if (!received) return "missing";
	return received === expected ? "match" : "mismatch";
}

export function parseAuthorizationInputForFlow(
	input: string,
	expectedState: string,
): ParsedAuthInput & { stateStatus: OAuthStateValidation } {
	const parsed = parseAuthorizationInput(input);
	return {
		...parsed,
		stateStatus: validateOAuthState(expectedState, parsed.state),
	};
}

/** Decode JWT token to extract payload */
export function decodeJWT(token: string): JWTPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1];
		if (!/^[A-Za-z0-9_-]+={0,2}$/.test(payload)) return null;
		const decoded = Buffer.from(payload, "base64url").toString("utf-8");
		return JSON.parse(decoded) as JWTPayload;
	} catch {
		return null;
	}
}


/** Exchange authorization code for tokens */
export async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = REDIRECT_URI,
): Promise<TokenResult> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		logWarn("code->token failed:", { status: res.status, text });
		return { type: "failed" };
	}
	const json = (await res.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		id_token?: string;
	};
	if (
		!json?.access_token ||
		!json?.refresh_token ||
		typeof json?.expires_in !== "number"
	) {
		logWarn("token response missing fields:", json);
		return { type: "failed" };
	}
	return {
		type: "success",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
		idToken: typeof json.id_token === "string" && json.id_token.trim() ? json.id_token : undefined,
		headers: res.headers,
	};
}

/** Refresh access token using refresh token */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			logWarn("Token refresh failed:", { status: response.status, text });
			return { type: "failed" };
		}

		const json = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			id_token?: string;
		};
		if (
			!json?.access_token ||
			!json?.refresh_token ||
			typeof json?.expires_in !== "number"
		) {
			logWarn("Token refresh response missing fields:", json);
			return { type: "failed" };
		}

		return {
			type: "success",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: Date.now() + json.expires_in * 1000,
			idToken: typeof json.id_token === "string" && json.id_token.trim() ? json.id_token : undefined,
			headers: response.headers,
		};
	} catch (error) {
		const err = error as Error;
		logWarn("Token refresh error:", err);
		return { type: "failed" };
	}
}

/** Create OAuth authorization flow */
export async function createAuthorizationFlow(): Promise<AuthorizationFlow> {
	const pkce = (await generatePKCE()) as PKCEPair;
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", "codex_cli_rs");

	return { pkce, state, url: url.toString() };
}
